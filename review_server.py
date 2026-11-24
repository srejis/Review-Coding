"""Loopback HTTP server for the React review interface."""
import asyncio
from contextlib import ExitStack
import httpx
import json
import mimetypes
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import threading
import time
from urllib.parse import parse_qs, urlsplit
import webbrowser

from agent import analyze, invalid_repair_connections, quality_counts, recovery_profile
from chatgpt_auth import ChatGPTAuth, ServiceError
from dependency_scheduler import next_repair, repair_reasons
from dependency_store import Checkpoints, FAILURES, read_state, set_state
from main import export, register
from graph_view import completed_graph
from responses import DEFAULT_EFFORT, DEFAULT_MODEL, EFFORTS, Responses
from source import AnalysisBusy, analysis_lock, database, digest, encode, load_snapshot
from source_relations import SourceRelations

UI = Path(__file__).resolve().parent / "ui" / "dist"


def project_id(root):
    return digest(os.path.normcase(os.path.normpath(root)).encode())


def display_profile(db, revision):
    latest = db.execute("""
        SELECT profile,SUM(json_extract(data,'$.status')='submitted') AS complete,COUNT(*) AS saved
        FROM result WHERE snapshot=? AND json_extract(data,'$.status') IN ('submitted','partial')
        GROUP BY profile ORDER BY complete DESC,saved DESC,MAX(rowid) DESC LIMIT 1
    """, (revision,)).fetchone()
    if latest:
        return latest[0]
    for table in ("result", "analysis_task", "event"):
        last = db.execute(f"SELECT profile FROM {table} WHERE snapshot=? ORDER BY rowid DESC LIMIT 1",
                          (revision,)).fetchone()
        if last:
            return last[0]
    return ""


def project_catalog(db):
    projects = {}
    rows = db.execute("""
        SELECT s.id,s.root,h.registered,
               (SELECT MAX(time) FROM event WHERE snapshot=s.id),
               (SELECT COUNT(*) FROM json_each(s.data,'$.units')),
               (SELECT COUNT(*) FROM json_each(s.data,'$.issues'))
        FROM snapshot s LEFT JOIN snapshot_history h ON h.snapshot=s.id
        ORDER BY h.registered DESC,s.rowid DESC
    """)
    for revision, root, registered, last, count, parse_errors in rows:
        key = project_id(root)
        projects.setdefault(key, dict(id=key, root=root, name=Path(root).name, snapshots=[]))
        profiles = db.execute("""
            SELECT profile,MAX(time) FROM (
                SELECT profile,time FROM event WHERE snapshot=? AND json_extract(data,'$.state') IN
                    ('started','finished','partial','cancelled','failed','time_limit','unit_limit','phase_limit')
                UNION ALL SELECT profile,NULL FROM analysis_task WHERE snapshot=?
                UNION ALL SELECT profile,NULL FROM result WHERE snapshot=?
            ) GROUP BY profile ORDER BY MAX(time) DESC,profile
        """, (revision, revision, revision))
        history = []
        for profile, time in profiles:
            states = [state for state, in db.execute(
                "SELECT state FROM analysis_task WHERE snapshot=? AND profile=?", (revision, profile))]
            counts = quality_counts(range(count), dict(enumerate(states)))
            history.append(dict(id=profile, time=time, counts=counts))
        projects[key]["snapshots"].append(dict(id=revision, registered=registered, last=last, count=count,
                                                parse_errors=parse_errors, profiles=history,
                                                default_profile=display_profile(db, revision)))
    for item in projects.values():
        snapshots = item["snapshots"]
        item["latest"] = snapshots[0]["id"]
        item["last"] = max((snap["last"] for snap in snapshots if snap["last"]), default=None)
        for index, snap in enumerate(snapshots):
            if index+1 == len(snapshots):
                snap["changed"] = None
                continue
            def hashes(revision):
                return dict(db.execute("SELECT j.key,json_extract(j.value,'$.hash') FROM snapshot s,"
                                       "json_each(s.data,'$.files') j WHERE s.id=?", (revision,)))
            left, right = hashes(snap["id"]), hashes(snapshots[index+1]["id"])
            snap["changed"] = sum(left.get(path) != right.get(path) for path in left.keys() | right.keys())
    return list(projects.values())


def delete_project(path, key, active_revision=None):
    with ExitStack() as locks, database(path) as db:
        db.execute("BEGIN IMMEDIATE")
        revisions = [rev for rev, root in db.execute("SELECT id,root FROM snapshot") if project_id(root) == key]
        if not revisions:
            raise ValueError("Unknown project.")
        try:
            for revision in sorted(revisions):
                if revision == active_revision:
                    raise AnalysisBusy("An analysis is active for this code version.")
                locks.enter_context(analysis_lock(path, revision))
        except AnalysisBusy as exc:
            raise ServiceError("active_run", "Stop the active analysis before deleting this project.") from exc
        for table in ("analysis_retry", "analysis_run", "snapshot_history", "analysis_task", "analysis_dependency",
                      "analysis_connection", "feedback", "event", "result"):
            db.executemany(f"DELETE FROM {table} WHERE snapshot=?", ((rev,) for rev in revisions))
        db.executemany("DELETE FROM snapshot WHERE id=?", ((rev,) for rev in revisions))
        return revisions


async def account_models(auth):
    state = await asyncio.to_thread(auth.status)
    state.update(model=DEFAULT_MODEL, effort=DEFAULT_EFFORT, efforts=EFFORTS, models=[])
    if state["auth"] == "chatgpt_plan_oauth":
        try:
            token = await asyncio.to_thread(auth.token, state["active"])
            provider = Responses(token)
            async with provider.client:
                state["models"] = await provider.models()
        except (ServiceError, httpx.RequestError) as exc:
            state["problem"] = str(exc) if isinstance(exc, ServiceError) else "Model catalog network request failed."
    if "problem" not in state and not any(m["id"] == DEFAULT_MODEL for m in state["models"]):
        state["problem"] = ("Luna is unavailable to this ChatGPT registration."
                            if state["auth"] == "chatgpt_plan_oauth" else "Connect ChatGPT and authorize plan usage.")
    return state


class Job:
    def __init__(self, path, auth, values, cursor, total):
        self.path, self.auth, self.values = path, auth, values
        self.cursor, self.total = cursor, total
        self.lock = threading.Lock()
        self.summary = {"state": "running"}
        self.loop = self.task = None
        self.cancelled = False
        self.thread = threading.Thread(target=self.run, daemon=True)

    def run(self):
        try:
            asyncio.run(self.work())
        except asyncio.CancelledError:
            self.summary = {"state": "cancelled"}
        except AnalysisBusy as exc:
            self.summary = {"state": "failed", "code": "active_run", "error": str(exc)}
        except ServiceError as exc:
            self.summary = {"state": "failed", "code": exc.code, "error": str(exc)}
        except Exception as exc:
            self.summary = {"state": "failed", "code": type(exc).__name__,
                            "error": "The local analysis run failed."}
        finally:
            with self.lock:
                self.loop = self.task = None

    async def work(self):
        with self.lock:
            self.loop, self.task = asyncio.get_running_loop(), asyncio.current_task()
            if self.cancelled:
                raise asyncio.CancelledError
        state = await asyncio.to_thread(self.auth.status)
        account = state.get("active")

        async def refresh():
            return await asyncio.to_thread(self.auth.token, account)

        provider = Responses(await refresh(), refresh=refresh)
        async with provider.client:
            self.summary = await analyze(provider, self.path, **self.values)

    def cancel(self):
        with self.lock:
            self.cancelled = True
            if self.loop:
                self.loop.call_soon_threadsafe(self.task.cancel)


class ReviewServer(ThreadingHTTPServer):
    def __init__(self, address, handler, data, auth):
        super().__init__(address, handler)
        self.db_path = data / "review.sqlite3"
        self.auth = auth
        self.lock = threading.Lock()
        self.job = None

    @property
    def base(self):
        return f"http://127.0.0.1:{self.server_port}"


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass  # OAuth callback query parameters contain authorization codes.

    def output(self, body, status=200, content_type="application/json; charset=utf-8", **headers):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", "default-src 'self'; object-src 'none'; frame-ancestors 'none'")
        for key, value in headers.items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def json(self, value, status=200):
        self.output(encode(value).encode(), status)

    def do_GET(self):
        self.route(False)

    def do_POST(self):
        self.route(True)

    def route(self, post):
        uri = urlsplit(self.path)
        if self.headers.get("Host") != urlsplit(self.server.base).netloc:
            self.json({"error": "Use the app's loopback address."}, 403)
            return
        if post and (self.headers.get("X-Review-Local") != "1" or
                     self.headers.get("Origin", self.server.base) != self.server.base):
            self.json({"error": "Cross-origin writes are not allowed."}, 403)
            return
        if self.headers.get("Sec-Fetch-Site") == "cross-site" and uri.path.startswith("/api/"):
            self.json({"error": "Cross-site requests are not allowed."}, 403)
            return
        query = {k: values[0] for k, values in parse_qs(uri.query, keep_blank_values=True).items()}
        try:
            if post:
                size = int(self.headers.get("Content-Length", "0"))
                if not 0 < size <= 65536:
                    raise ValueError("Invalid request length.")
                data = json.loads(self.rfile.read(size))
                if not isinstance(data, dict):
                    raise ValueError("Expected a JSON object.")
                self.post(uri.path, data)
            else:
                self.get(uri.path, query)
        except (ConnectionError, BrokenPipeError):
            return
        except ServiceError as exc:
            if uri.path == "/auth/callback":
                self.output(b"", 303, Location=f"/?login={exc.code}")
            else:
                self.json({"code": exc.code, "error": str(exc)}, 409)
        except (KeyError, TypeError, ValueError, FileNotFoundError) as exc:
            self.json({"error": str(exc)}, 400)
        except Exception:
            self.json({"error": "The local request failed."}, 500)

    def get(self, path, query):
        db_path = self.server.db_path
        if path == "/auth/callback":
            self.server.auth.finish(query)
            self.output(b"", 303, Location="/?login=connected")
        elif path == "/favicon.ico":
            self.output(b"", 204)
        elif path == "/api/account":
            self.json(asyncio.run(account_models(self.server.auth)))
        elif path == "/api/projects":
            with database(db_path) as db:
                self.json([dict(id=rev, root=root) for rev, root in db.execute(
                    "SELECT id,root FROM snapshot ORDER BY rowid DESC")])
        elif path == "/api/snapshot":
            self.snapshot(db_path, query)
        elif path == "/api/project-catalog":
            with database(db_path) as db:
                self.json(project_catalog(db))
        elif path == "/api/analysis":
            self.json(self.analysis_status(db_path, query))
        elif path == "/api/export":
            self.json(export(db_path, query["revision"]))
        elif path == "/api/run":
            self.json(self.run_status(db_path))
        elif path == "/api/events":
            self.events(query["revision"], int(query.get("after", "0")))
        elif path.startswith("/api/"):
            self.json({"error": "Unknown API route."}, 404)
        else:
            asset = (UI / (path.lstrip("/") or "index.html")).resolve()
            if not asset.is_relative_to(UI) or not asset.is_file():
                self.output(b"Build the UI with: npm --prefix ui run build", 404, "text/plain")
                return
            self.output(asset.read_bytes(), content_type=mimetypes.guess_type(asset)[0] or
                        ("text/javascript" if asset.suffix == ".js" else "application/octet-stream"))

    def snapshot(self, db_path, query):
        revision = query["revision"]
        with database(db_path) as db:
            db.execute("BEGIN")
            root, snap = load_snapshot(db, revision)
            profiles = [raw for raw, in db.execute(
                "SELECT profile FROM event WHERE snapshot=? UNION SELECT profile FROM result WHERE snapshot=? UNION SELECT profile FROM analysis_task WHERE snapshot=? "
                "ORDER BY profile", (revision, revision, revision))]
            profile = query["profile"] if "profile" in query else display_profile(db, revision)
            _, connections, dependencies, results = read_state(db, revision, profile)
            tasks = {uid: dict(state=state, **json.loads(raw)) for uid, state, raw in db.execute(
                "SELECT unit,state,metadata FROM analysis_task WHERE snapshot=? AND profile=?", (revision, profile))}
            feedback = [dict(unit=uid, time=stamp, **json.loads(raw)) for uid, stamp, raw in db.execute(
                "SELECT unit,time,data FROM feedback WHERE snapshot=? AND profile=?", (revision, profile))]
        units, files = snap["units"], snap["files"]
        view = query.get("view")
        if view and "profile" in query and profile and profile not in profiles:
            raise ValueError("Unknown analysis profile.")
        graph = None
        if view == "graph":
            graph = completed_graph(revision, units, results, tasks, files)
            files, feedback = {}, []
            results = {uid: {**conn, "status": results.get(uid, {}).get("status", "")}
                       for uid, conn in connections.items()} | {
                uid: dict(status=result["status"], relations=result["relations"])
                for uid, result in results.items()
            }
            connections = {}
            units = {uid: {**unit, "sites": []} for uid, unit in units.items()}
        elif view == "unit":
            uid = query["unit"]
            unit = units[uid]
            units, files = {uid: unit}, {unit["file"]: files[unit["file"]]}
            results = {uid: results[uid]} if uid in results else {}
            connections, dependencies, feedback = {}, {}, []
            tasks = {uid: tasks[uid]} if uid in tasks else {}
        self.json(dict(root=root, profiles=profiles, profile=profile, units=units,
                       results=results, tasks=tasks, connections=connections, dependencies=dependencies, graph=graph,
                       feedback=feedback, issues=snap["issues"],
                       file_paths=sorted(files if view != "graph" else snap["files"]),
                       files={name: file["source"] for name, file in files.items()}))

    def run_status(self, db_path):
        job = self.server.job
        if not job:
            return None
        revision = job.values["revision"]
        with database(db_path) as db:
            row = db.execute(
                "SELECT profile FROM event WHERE snapshot=? AND rowid>? AND json_extract(data,'$.state')='started' ORDER BY rowid DESC LIMIT 1",
                (revision, job.cursor)).fetchone()
            profile = row[0] if row else None
            count = db.execute(
                "SELECT COUNT(*) FROM analysis_task WHERE snapshot=? AND profile=? AND state IN ('SEMANTIC_SUBMITTED','SEMANTIC_PARTIAL','QUALITY_VERIFIED')",
                (revision, profile)).fetchone()[0]
            phase = db.execute(
                "SELECT data FROM event WHERE snapshot=? AND profile=? AND rowid>? AND json_extract(data,'$.state') IN ('CONNECTING','SEMANTICIZING') ORDER BY rowid DESC LIMIT 1",
                (revision, profile, job.cursor)).fetchone()
        current = json.loads(phase[0]) if phase and job.summary["state"] == "running" else {}
        return dict(job.summary, revision=revision, model=job.values["model"], effort=job.values["effort"], profile=profile,
                    current_unit=current.get("unit"), phase=current.get("state"),
                    submitted=count, left=max(0,job.total-count), attempt=current.get("attempt"))

    def analysis_status(self, path, query):
        revision = query["revision"]
        live = self.run_status(path)
        if not live or live["revision"] != revision:
            live = None
        with database(path) as db:
            root, snap = load_snapshot(db, revision)
            interrupted = db.execute("SELECT profile FROM analysis_run WHERE snapshot=? AND state IN "
                                     "('started','cancelled') ORDER BY rowid DESC LIMIT 1", (revision,)).fetchone()
            profile = (live or {}).get("profile") if live and (live["state"] == "running" or not query.get("profile")) else None
            profile = profile or query.get("profile") or (interrupted[0] if interrupted else display_profile(db, revision))
            states, connections, deps, results = read_state(db, revision, profile)
            saved = db.execute("SELECT state,data FROM analysis_run WHERE snapshot=? AND profile=?",
                               (revision, profile)).fetchone()
            last = db.execute("SELECT json_extract(data,'$.state') FROM event WHERE snapshot=? AND profile=? "
                              "AND json_extract(data,'$.state') IN ('started','finished','partial','cancelled',"
                              "'failed','time_limit','unit_limit','phase_limit') ORDER BY rowid DESC LIMIT 1",
                              (revision, profile)).fetchone()
        metadata, history = Checkpoints(path, revision, profile).recovery_state()
        units = snap["units"]
        counts = quality_counts(units, states)
        state = saved[0] if saved else (last[0] if last else "idle")
        if state == "started":
            state = "cancelled"
        if live and (live["profile"] in {None, profile} or live["state"] == "running"):
            state = live["state"]
        error = (live or {}).get("error") or (json.loads(saved[1]).get("error") if saved else None)
        other_running = bool(self.server.job and self.server.job.thread.is_alive() and not live)
        resumable = False
        if profile and states and query.get("summary") != "1":
            try:
                selected = json.loads(profile)
                recovery_profile(selected.get("model"), selected.get("effort"), profile)
                resumable = True
            except (ValueError, TypeError, AttributeError):
                pass
        base = dict(root=root, profile=profile, state=state, counts=counts, issues=snap["issues"],
                    live=live, retries=sum(map(len, history.values())), error=error, other_running=other_running,
                    resumable=resumable)
        if query.get("summary") == "1":
            return dict(base, outstanding=[], repairable=False)
        if live and live.get("current_unit") in units:
            info = units[live["current_unit"]]
            live["current_name"] = f"{info['name']} · {info['file']}:{info['line']}"
        facts = SourceRelations(units, snap["files"])
        invalid = invalid_repair_connections(facts, units, states, connections, results)
        retry_metadata = {uid: {**meta, "seeded": meta.get("seeded") or not json.loads(profile or "{}").get("recovery")}
                          for uid, meta in metadata.items()}
        repairable = bool(next_repair(units, states, connections, deps, results, retry_metadata, history, invalid))
        outstanding = []
        for uid, unit in units.items():
            if states.get(uid) not in {"SEMANTIC_PARTIAL", *FAILURES}:
                continue
            reasons = repair_reasons(uid, results.get(uid, {}), metadata.get(uid, {}), uid in invalid)
            outstanding.append(dict(unit=uid, name=unit["name"], file=unit["file"], line=unit["line"],
                                    state=states[uid], reasons=reasons, retries=history.get(uid, ())))
        return dict(base, outstanding=outstanding, repairable=repairable)

    def events(self, revision, after):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        deadline = time.monotonic() + 20
        after = max(after, int(self.headers.get("Last-Event-ID", "0")))
        last_state = None
        while time.monotonic() < deadline:
            with database(self.server.db_path) as db:
                events = db.execute(
                    "SELECT rowid,time,profile,data FROM event WHERE snapshot=? AND rowid>? ORDER BY rowid LIMIT 100",
                    (revision, after)).fetchall()
            for after, stamp, profile, raw in events:
                value = dict(id=after, time=stamp, profile=json.loads(profile), event=json.loads(raw))
                self.wfile.write(f"id: {after}\ndata: {encode(value)}\n\n".encode())
            job = self.server.job
            if job and job.values["revision"] == revision and job.summary != last_state:
                last_state = job.summary
                self.wfile.write(f"event: run\ndata: {encode(last_state)}\n\n".encode())
            self.wfile.write(b": keepalive\n\n")
            self.wfile.flush()
            time.sleep(0.7)

    def post(self, path, data):
        db_path = self.server.db_path
        if path == "/api/login":
            target = self.server.auth.begin(f"{self.server.base}/auth/callback", data.get("account"))
            self.json({"url": target})
        elif path == "/api/register":
            with self.server.lock:
                rev, snap = register(db_path, Path(data["root"]))
            self.json(dict(id=rev, count=len(snap["units"])))
        elif path == "/api/delete-project":
            with self.server.lock:
                job = self.server.job
                revisions = delete_project(db_path, data["project"], job.values["revision"] if
                                           job and job.thread.is_alive() else None)
            self.json(dict(revisions=revisions))
        elif path == "/api/analyze":
            values = dict(revision=data["revision"], model=data.get("model", DEFAULT_MODEL),
                          effort=data.get("effort", DEFAULT_EFFORT), only=data.get("unit"),
                          full=data.get("unit") is None, recover=True, previous=data.get("previous"))
            with self.server.lock, database(db_path) as db:
                if self.server.job and self.server.job.thread.is_alive():
                    raise ServiceError("active_run", "An analysis is already running.")
                _, snap = load_snapshot(db, values["revision"])
                cursor = db.execute("SELECT COALESCE(MAX(rowid),0) FROM event").fetchone()[0]
                if values["only"] is not None and values["only"] not in snap["units"]:
                    raise ValueError("Unknown unit.")
                if values["previous"] and not db.execute(
                    "SELECT 1 FROM analysis_task WHERE snapshot=? AND profile=? LIMIT 1",
                    (values["revision"], values["previous"])).fetchone():
                    raise ValueError("Unknown analysis profile.")
                recovery_profile(values["model"], values["effort"], values["previous"])
                self.server.job = Job(db_path, self.server.auth, values, cursor, len(snap["units"]))
                self.server.job.thread.start()
            self.json({"state": "running"}, 202)
        elif path == "/api/cancel":
            with self.server.lock:
                if self.server.job and self.server.job.thread.is_alive():
                    if data.get("revision") and self.server.job.values["revision"] != data["revision"]:
                        raise ServiceError("active_run", "That project no longer owns the active analysis.")
                    self.server.job.cancel()
            self.json({"state": "cancellation_requested"})
        elif path == "/api/verify":
            revision, profile, unit, version = (data[k] for k in ("revision", "profile", "unit", "version"))
            with database(db_path) as db:
                row = db.execute(
                    "SELECT t.state,r.data FROM analysis_task t JOIN result r USING(snapshot,profile,unit) "
                    "WHERE t.snapshot=? AND t.profile=? AND t.unit=?", (revision, profile, unit)).fetchone()
                if not row or row[0] != "SEMANTIC_SUBMITTED" or json.loads(row[1]).get("version") != version:
                    raise ValueError("Independent verification requires the current complete submission.")
                set_state(db, revision, profile, unit, "QUALITY_VERIFIED", {"version": version})
                db.execute("INSERT INTO event(snapshot,profile,data) VALUES(?,?,?)",
                           (revision, profile, encode(dict(state="QUALITY_VERIFIED", unit=unit, version=version))))
            self.json({"saved": True})
        elif path == "/api/feedback":
            revision, profile, unit = (data[k] for k in ("revision", "profile", "unit"))
            note = data["note"].strip()
            if not note or len(note) > 4000:
                raise ValueError("Feedback must contain 1–4,000 characters.")
            category = data["category"]
            if category not in {"설명 누락", "잘못된 연결", "너무 추상적", "근거 없는 의미", "검수 메모"}:
                raise ValueError("Unknown feedback category.")
            with database(db_path) as db:
                if not db.execute("SELECT 1 FROM result WHERE snapshot=? AND profile=? AND unit=?",
                                  (revision, profile, unit)).fetchone():
                    raise ValueError("Feedback requires a saved analysis.")
                db.execute("INSERT INTO feedback(snapshot,profile,unit,data) VALUES(?,?,?,?)",
                           (revision, profile, unit, encode(dict(category=category, note=note))))
            self.json({"saved": True})
        else:
            self.json({"error": "Unknown API route."}, 404)


def serve(data, port=8765, launch=True, signin=False):
    auth = ChatGPTAuth(data / "chatgpt")
    if not signin and not (UI / "index.html").is_file():
        raise RuntimeError("Build the UI first with: npm --prefix ui ci && npm --prefix ui run build")
    with ReviewServer(("127.0.0.1", port), Handler, data, auth) as server:
        print(server.base, flush=True)
        if launch:
            target = auth.begin(f"{server.base}/auth/callback", auth.status().get("active")) if signin else server.base
            webbrowser.open(target)
        server.serve_forever()
