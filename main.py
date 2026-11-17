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
    with database(db_path) as db:
        db.execute("INSERT OR IGNORE INTO snapshot VALUES(?,?,?)",
                   (revision, str(root.resolve()), encode(data)))
    return revision, data


def export(db_path, revision):
    with database(db_path) as db:
        root, snap = load_snapshot(db, revision)
        return dict(snapshot=revision, root=root, source=snap, results=[
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
    sign_in = sub.add_parser("login")
    sign_in.add_argument("--device", action="store_true")
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
    sub.add_parser("review")
    args = parser.parse_args()
    data = args.data.resolve()
    db_path = data / "review.sqlite3"
    from codex_runtime import analyze, catalog, login
    try:
        match args.command:
            case "status":
                value = asyncio.run(catalog(data))
            case "login":
                value = dict(auth=asyncio.run(login(data, args.device)))
            case "register":
                revision, snap = register(db_path, args.root)
                value = dict(snapshot=revision, units=len(snap["units"]), issues=snap["issues"],
                             excluded=snap["excluded"], database=str(db_path))
            case "analyze":
                value = asyncio.run(run_cancellable(
                    analyze(data, db_path, args.snapshot, args.model, args.effort, args.limit, args.seconds, args.unit),
                    args.cancel_file))
            case "export":
                value = export(db_path, args.snapshot)
            case "review":
                from review_ui import review
                review(data, db_path)
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
