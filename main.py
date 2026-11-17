"""CLI for registering, analyzing and exporting a Python snapshot."""
import argparse
import asyncio
import json
import os
from pathlib import Path
import sys

# The product may be analyzing this directory itself.
sys.dont_write_bytecode = True

from source import database, encode, load_snapshot, snapshot


def data_directory():
    return Path(os.environ.get("LOCALAPPDATA", Path.home() / ".local/share")).resolve() / "PythonCodeReview"


def register(db_path, root):
    revision, data = snapshot(root, db_path.parent)
    from dependency_store import inherit
    root = str(root.resolve())
    with database(db_path) as db:
        inserted = db.execute("INSERT OR IGNORE INTO snapshot VALUES(?,?,?)",
                              (revision, root, encode(data)))
        if inserted.rowcount:
            inherit(db, revision, root, data)
    return revision, data


def export(db_path, revision):
    with database(db_path) as db:
        root, snap = load_snapshot(db, revision)
        return dict(snapshot=revision, root=root, source=snap, tasks=[
            dict(profile=json.loads(profile), unit=uid, state=state, metadata=json.loads(metadata))
            for profile, uid, state, metadata in db.execute(
                "SELECT profile,unit,state,metadata FROM analysis_task WHERE snapshot=?", (revision,))],
            connections=[dict(profile=json.loads(profile), unit=uid, **json.loads(data))
                         for profile, uid, data in db.execute(
                             "SELECT profile,unit,data FROM analysis_connection WHERE snapshot=?", (revision,))],
            dependencies=[dict(profile=json.loads(profile), unit=uid, target=target)
                          for profile, uid, target in db.execute(
                              "SELECT profile,unit,target FROM analysis_dependency WHERE snapshot=?", (revision,))],
            results=[
            dict(profile=json.loads(profile), unit=uid, **json.loads(data))
            for profile, uid, data in db.execute(
                "SELECT profile,unit,data FROM result WHERE snapshot=? ORDER BY profile,unit", (revision,))],
            events=[dict(profile=json.loads(profile), time=time, event=json.loads(data))
                    for profile, time, data in db.execute(
                        "SELECT profile,time,data FROM event WHERE snapshot=? ORDER BY rowid", (revision,))],
            feedback=[dict(profile=json.loads(profile), unit=uid, time=time, **json.loads(data))
                      for profile, uid, time, data in db.execute(
                          "SELECT profile,unit,time,data FROM feedback WHERE snapshot=?", (revision,))])


async def run_cancellable(operation, stop_file):
    if stop_file is None:
        return await operation
    async with asyncio.TaskGroup() as group:
        task = group.create_task(operation)
        while not task.done():
            if stop_file.exists():
                task.cancel()
                break
            await asyncio.sleep(0.5)
    return {"state": "cancelled"} if task.cancelled() else task.result()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, default=data_directory())
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("status")
    sub.add_parser("login")
    add = sub.add_parser("register")
    add.add_argument("root", type=Path)
    run = sub.add_parser("analyze")
    run.add_argument("snapshot")
    run.add_argument("--unit", help="Analyze one selected unit ID.")
    run.add_argument("--model")
    run.add_argument("--effort")
    run.add_argument("--limit", type=int, default=12, choices=range(1, 101), metavar="1..100")
    run.add_argument("--seconds", type=int, default=300, choices=range(1, 1801), metavar="1..1800")
    run.add_argument("--cancel-file", type=Path, help=argparse.SUPPRESS)
    out = sub.add_parser("export")
    out.add_argument("snapshot")
    ui = sub.add_parser("review")
    ui.add_argument("--port", type=int, default=8765)
    ui.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()
    data = args.data.resolve()
    db_path = data / "review.sqlite3"
    from agent import analyze
    from chatgpt_auth import ChatGPTAuth
    from responses import DEFAULT_EFFORT, DEFAULT_MODEL, Responses
    from review_server import account_models, serve

    auth = ChatGPTAuth(data / "chatgpt")

    async def run_analysis():
        token = await asyncio.to_thread(auth.token)
        provider = Responses(token)
        async with provider.client:
            return await analyze(provider, db_path, args.snapshot, args.model or DEFAULT_MODEL,
                                 args.effort or DEFAULT_EFFORT, args.limit, args.seconds, args.unit)
    try:
        match args.command:
            case "status":
                value = asyncio.run(account_models(auth))
            case "login":
                serve(data, 0, signin=True)
                return
            case "register":
                revision, snap = register(db_path, args.root)
                value = dict(snapshot=revision, units=len(snap["units"]), issues=snap["issues"],
                             excluded=snap["excluded"], database=str(db_path))
            case "analyze":
                value = asyncio.run(run_cancellable(run_analysis(), args.cancel_file))
            case "export":
                value = export(db_path, args.snapshot)
            case "review":
                serve(data, args.port, not args.no_browser)
                return
        print(json.dumps(value, ensure_ascii=False, indent=2))
    except KeyboardInterrupt:
        print("Cancelled. Saved results are available for resume.", file=sys.stderr)
        raise SystemExit(130)
    except Exception as exc:
        print(f"{type(exc).__name__}: {exc}", file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    main()
