
"""Preserved, sequential rembg baseline using the existing ChatGPT registration."""
import argparse
import asyncio
from datetime import datetime, timezone
import gzip
import hashlib
import importlib.metadata
import json
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import time

import httpx

from agent import analyze, CONNECTION, SEMANTIC
from chatgpt_auth import ChatGPTAuth, ServiceError
from dependency_store import Checkpoints, ENGINE, TERMINAL, FAILURES
from main import data_directory, register, run_cancellable
from responses import Responses, DEFAULT_MODEL, DEFAULT_EFFORT
from source import VERSION, encode, load_snapshot

sys.dont_write_bytecode = True


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf8")


def now():
    return datetime.now(timezone.utc).isoformat()


def append_json(path, value):
    with path.open("a", encoding="utf8") as stream:
        stream.write(encode(value)+"\n")


def prepare(directory, source_db, root):
    directory.mkdir(parents=True, exist_ok=False)
    with sqlite3.connect("file:"+source_db.as_posix()+"?mode=ro", uri=True) as source:
        with sqlite3.connect(directory/"original.sqlite3") as target:
            source.backup(target)
    shutil.copy2(directory/"original.sqlite3", directory/"review.sqlite3")
    backend=directory/"backend"
    backend.mkdir()
    repo=Path(__file__).resolve().parent
    code_files=list(repo.glob("*.py"))+[repo/"requirements.txt"]
    hashes={}
    for file in code_files:
        shutil.copy2(file, backend/file.name)
        hashes[file.name]=hashlib.sha256(file.read_bytes()).hexdigest()
    def git(*arguments):
        return subprocess.check_output(["git","-C",str(repo),*arguments],text=True,encoding="utf8")
    (directory/"local-changes.patch").write_text(git("diff","--binary"),encoding="utf8")
    revision,snapshot=register(directory/"review.sqlite3",root)
    with sqlite3.connect(directory/"review.sqlite3") as db:
        cursor=db.execute("SELECT COALESCE(MAX(rowid),0) FROM event").fetchone()[0]
        seed=[dict(profile=profile,unit=uid,result=json.loads(raw)) for profile,uid,raw in db.execute(
            "SELECT profile,unit,data FROM result WHERE snapshot=?",(revision,))]
    shutil.copy2(directory/"review.sqlite3",directory/"seed.sqlite3")
    write_json(directory/"seed-results.json",seed)
    write_json(directory/"manifest.json",dict(
        created_at=now(),repository=str(repo),git_head=git("rev-parse","HEAD").strip(),
        python=sys.version,python_executable=sys.executable,
        packages={package:importlib.metadata.version(package) for package in ("httpx","PyJWT","keyring")},
        git_status=git("status","--short"),code_hashes=hashes,source_database=str(source_db),
        snapshot=revision,source_root=str(root),units=len(snapshot["units"]),
        event_cursor=cursor,model=DEFAULT_MODEL,effort=DEFAULT_EFFORT,auth="chatgpt_plan_oauth",
        orchestration="one sequential Python agent; full=True",parallel_agents=False,
        inherited_results=len(seed),
        seed_database_sha256=hashlib.sha256((directory/"seed.sqlite3").read_bytes()).hexdigest(),
        original_database_sha256=hashlib.sha256((directory/"original.sqlite3").read_bytes()).hexdigest()))


class ObservedStream(httpx.AsyncByteStream):
    """Record transport progress without changing request payloads or analysis."""
    def __init__(self, stream, directory, number, status):
        self.stream=stream
        self.raw=directory/f"{number:06d}-stream.sse.gz"
        self.progress=directory/f"{number:06d}-stream-progress.json"
        self.state=dict(request=number,http_status=status,headers_at=now(),bytes=0,chunks=0,event_types={})
        self.arguments={}
        self.trailing_whitespace={}
        self.output=gzip.open(self.raw,"wb")
        write_json(self.progress,self.state)

    def finish(self):
        if self.output is not None:
            self.output.close()
            self.output=None
            self.state["stream_closed_at"]=now()
            write_json(self.progress,self.state)

    async def __aiter__(self):
        pending=b""
        saved=0.0
        try:
            async for chunk in self.stream:
                self.output.write(chunk)
                self.output.flush()
                self.state["bytes"]+=len(chunk)
                self.state["chunks"]+=1
                self.state["received_at"]=now()
                pending+=chunk
                while b"\n" in pending:
                    line,pending=pending.split(b"\n",1)
                    if not line.startswith(b"data:"):
                        continue
                    try:
                        event=json.loads(line[5:].strip())
                    except (ValueError,UnicodeError):
                        continue
                    if isinstance(event,dict) and event.get("type"):
                        kind=event["type"]
                        self.state["event_types"][kind]=self.state["event_types"].get(kind,0)+1
                        self.state["last_event_type"]=kind
                        if kind=="response.function_call_arguments.delta":
                            key=event.get("item_id",event.get("output_index",0))
                            delta=event.get("delta","")
                            self.arguments[key]=self.arguments.get(key,0)+len(delta)
                            previous=self.trailing_whitespace.get(key,0)
                            self.trailing_whitespace[key]=(previous+len(delta) if not delta.strip()
                                else len(delta)-len(delta.rstrip()))
                            self.state["argument_characters"]=self.arguments
                            self.state["trailing_whitespace"]=self.trailing_whitespace
                            if self.arguments[key]>100_000 or self.trailing_whitespace[key]>8192:
                                code=("stream_arguments_limit" if self.arguments[key]>100_000
                                      else "stream_whitespace_loop")
                                self.state["aborted"]=code
                                raise ServiceError(code,"Streaming tool arguments exceeded the size or non-progress whitespace guard.")
                if time.monotonic()-saved>=1:
                    write_json(self.progress,self.state)
                    saved=time.monotonic()
                yield chunk
        finally:
            self.finish()

    async def aclose(self):
        self.finish()
        await self.stream.aclose()


class RecordedResponses(Responses):
    def __init__(self, token, auth, directory):
        super().__init__(token)
        self.auth=auth
        self.directory=directory
        self.requests=directory/"requests"
        self.requests.mkdir(exist_ok=True)
        self.journal=directory/"requests.jsonl"
        previous=self.journal.read_text(encoding="utf8").splitlines() if self.journal.exists() else []
        self.counter=max((json.loads(line)["request"] for line in previous),default=0)
        self.client.event_hooks["response"].append(self.observe_response)

    async def observe_response(self,response):
        if response.request.url.path.endswith("/responses"):
            response.stream=ObservedStream(response.stream,self.requests,self.counter,response.status_code)

    def dump(self, number, suffix, value):
        with gzip.open(self.requests/f"{number:06d}-{suffix}.json.gz","wt",encoding="utf8") as stream:
            json.dump(value,stream,ensure_ascii=False)

    async def models(self):
        token=await asyncio.to_thread(self.auth.token)
        self.client.headers["Authorization"]="Bearer "+token
        return await super().models()

    async def generate(self, model, effort, instructions, messages, tools):
        self.counter+=1
        number=self.counter
        stamp=now()
        started=time.monotonic()
        self.dump(number,"input",dict(model=model,effort=effort,instructions=instructions,
                                     input=messages,tools=tools,store=False,stream=True))
        append_json(self.directory/"request-starts.jsonl",dict(request=number,time=stamp,
                    target=messages[0]["content"],phase="connection" if any(
                        tool["name"]=="submit_relations" for tool in tools) else "semantic"))
        try:
            token=await asyncio.to_thread(self.auth.token)
            self.client.headers["Authorization"]="Bearer "+token
            response=await super().generate(model,effort,instructions,messages,tools)
            self.dump(number,"response",response)
        except BaseException as exc:
            append_json(self.journal,dict(request=number,started_at=stamp,ended_at=now(),
                        elapsed_seconds=time.monotonic()-started,status="failed",
                        code=getattr(exc,"code",type(exc).__name__),error=str(exc)[:4000],usage=None))
            raise
        append_json(self.journal,dict(request=number,started_at=stamp,ended_at=now(),
                    elapsed_seconds=time.monotonic()-started,status="completed",
                    response_id=response.get("id"),model=response.get("model"),usage=response.get("usage")))
        return response


def summarize(directory, manifest, profile, outcome):
    path=directory/"review.sqlite3"
    states,connections,deps,results=Checkpoints(path,manifest["snapshot"],profile).read()
    with sqlite3.connect(path) as db:
        _,snapshot=load_snapshot(db,manifest["snapshot"])
        events=[dict(id=row,time=stamp,event=json.loads(raw)) for row,stamp,raw in db.execute(
            "SELECT rowid,time,data FROM event WHERE snapshot=? AND profile=? AND rowid>? ORDER BY rowid",
            (manifest["snapshot"],profile,manifest["event_cursor"]))]
    seed={row["unit"]:row["result"].get("version") for row in json.loads(
        (directory/"seed-results.json").read_text(encoding="utf8")) if row["profile"]==profile}
    counts=dict(submitted=0,partial=0,failed=0,unprocessed=0)
    units=[]
    for uid,unit in snapshot["units"].items():
        result=results.get(uid,{})
        if states.get(uid) in FAILURES:
            category="failed"
        elif states.get(uid) in TERMINAL and result.get("status") in {"submitted","partial"}:
            category=result["status"]
        else:
            category="unprocessed"
        counts[category]+=1
        units.append(dict(unit=uid,file=unit["file"],name=unit["name"],kind=unit["kind"],
                          line=unit["line"],end=unit["end"],state=states.get(uid,"NEW"),category=category,
                          result_version=result.get("version"),
                          reused=bool(result.get("version") and seed.get(uid)==result.get("version"))))
    journal=directory/"requests.jsonl"
    requests=[json.loads(line) for line in journal.read_text(encoding="utf8").splitlines()] if journal.exists() else []
    totals={key:sum(row.get("usage",{}).get(key,0) for row in requests
                    if isinstance(row.get("usage"),dict)) for key in ("input_tokens","output_tokens","total_tokens")}
    segments=[json.loads(line) for line in (directory/"segments.jsonl").read_text(encoding="utf8").splitlines()]
    summary=dict(snapshot=manifest["snapshot"],profile=json.loads(profile),outcome=outcome,
                 units=len(units),counts=counts,reused_results=sum(unit["reused"] for unit in units),
                 model_calls=len(requests),completed_model_calls=sum(row["status"]=="completed" for row in requests),
                 failed_model_calls=sum(row["status"]=="failed" for row in requests),
                 usage=totals,usage_unknown_requests=sum(not row.get("usage") for row in requests),
                 elapsed_seconds=sum(segment["elapsed_seconds"] for segment in segments),
                 unit_failures=[event for event in events if event["event"].get("state")=="unit_failed"],
                 tool_rejections=[event for event in events if event["event"].get("state")=="tool_rejected"])
    write_json(directory/"summary.json",summary)
    write_json(directory/"units.json",units)
    write_json(directory/"results.json",results)
    write_json(directory/"events.json",events)
    write_json(directory/"connections.json",connections)
    write_json(directory/"dependencies.json",deps)
    return summary


async def execute(directory,manifest):
    profile=encode(dict(model=DEFAULT_MODEL,effort=DEFAULT_EFFORT,auth="chatgpt_plan_oauth",
                        engine=ENGINE,analyzer=VERSION,prompt_hash=hashlib.sha256(
                            (CONNECTION+SEMANTIC).encode()).hexdigest()))
    started=time.monotonic()
    stamp=now()
    outcome={}
    try:
        auth=ChatGPTAuth(data_directory()/"chatgpt")
        token=await asyncio.to_thread(auth.token)
        provider=RecordedResponses(token,auth,directory)
        async with provider.client:
            outcome=await run_cancellable(analyze(provider,directory/"review.sqlite3",
                        manifest["snapshot"],full=True),directory/"cancel.request")
    except asyncio.CancelledError:
        outcome=dict(state="cancelled")
    except Exception as exc:
        outcome=dict(state="failed",code=getattr(exc,"code",type(exc).__name__),error=str(exc)[:4000])
    finally:
        append_json(directory/"segments.jsonl",dict(started_at=stamp,ended_at=now(),
                    elapsed_seconds=time.monotonic()-started,outcome=outcome))
    summary=summarize(directory,manifest,profile,outcome)
    print(json.dumps(summary,ensure_ascii=False,indent=2),flush=True)
    return 0 if summary["counts"]["unprocessed"]==0 else 1


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory",type=Path,required=True)
    parser.add_argument("--source-db",type=Path,default=data_directory()/"review.sqlite3")
    parser.add_argument("--root",type=Path)
    parser.add_argument("--resume",action="store_true")
    args=parser.parse_args()
    directory=args.directory.resolve()
    if not args.resume:
        if args.root is None:
            parser.error("--root is required for a new preserved baseline")
        prepare(directory,args.source_db.resolve(),args.root.resolve())
    manifest=json.loads((directory/"manifest.json").read_text(encoding="utf8"))
    frozen=directory/"backend"/"baseline.py"
    if Path(__file__).resolve()!=frozen:
        return subprocess.call([sys.executable,"-B",str(frozen),"--directory",str(directory),"--resume"])
    return asyncio.run(execute(directory,manifest))


if __name__=="__main__":
    raise SystemExit(main())
