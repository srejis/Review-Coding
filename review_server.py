"""Loopback HTTP server for the React review interface."""
import asyncio
import httpx
import json
import mimetypes
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import threading
import time
from urllib.parse import parse_qs, urlsplit
import webbrowser

from agent import analyze
from chatgpt_auth import ChatGPTAuth, ServiceError
from main import export, register
from responses import DEFAULT_EFFORT, DEFAULT_MODEL, EFFORTS, Responses
from source import database, encode, load_snapshot

UI = Path(__file__).resolve().parent / "ui" / "dist"


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
    def __init__(self, path, auth, values):
        self.path, self.auth, self.values = path, auth, values
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
        token = await asyncio.to_thread(self.auth.token, state.get("active"))
        provider = Responses(token)
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
        query = {k: values[0] for k, values in parse_qs(uri.query).items()}
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
        elif path == "/api/export":
            self.json(export(db_path, query["revision"]))
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
            root, snap = load_snapshot(db, revision)
            profiles = [raw for raw, in db.execute(
                "SELECT profile FROM event WHERE snapshot=? UNION SELECT profile FROM result WHERE snapshot=? "
                "ORDER BY profile", (revision, revision))]
            latest = db.execute("SELECT profile FROM result WHERE snapshot=? ORDER BY rowid DESC LIMIT 1",
                                (revision,)).fetchone()
            latest_run = db.execute("SELECT profile FROM event WHERE snapshot=? ORDER BY rowid DESC LIMIT 1",
                                    (revision,)).fetchone()
            default = latest_run or latest
            profile = query.get("profile", default[0] if default else "")
            results = {uid: json.loads(raw) for uid, raw in db.execute(
                "SELECT unit,data FROM result WHERE snapshot=? AND profile=?", (revision, profile))}
            feedback = [dict(unit=uid, time=stamp, **json.loads(raw)) for uid, stamp, raw in db.execute(
                "SELECT unit,time,data FROM feedback WHERE snapshot=? AND profile=?", (revision, profile))]
        self.json(dict(root=root, profiles=profiles, profile=profile, units=snap["units"],
                       results=results, feedback=feedback, issues=snap["issues"],
                       files={name: file["source"] for name, file in snap["files"].items()}))

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
            rev, snap = register(db_path, Path(data["root"]))
            self.json(dict(id=rev, count=len(snap["units"])))
        elif path == "/api/analyze":
            values = dict(revision=data["revision"], model=data.get("model", DEFAULT_MODEL),
                          effort=data.get("effort", DEFAULT_EFFORT), only=data.get("unit"))
            with database(db_path) as db:
                _, snap = load_snapshot(db, values["revision"])
                if values["only"] is not None and values["only"] not in snap["units"]:
                    raise ValueError("Unknown unit.")
            with self.server.lock:
                if self.server.job and self.server.job.thread.is_alive():
                    raise ServiceError("active_run", "An analysis is already running.")
                self.server.job = Job(db_path, self.server.auth, values)
                self.server.job.thread.start()
            self.json({"state": "running"}, 202)
        elif path == "/api/cancel":
            with self.server.lock:
                if self.server.job and self.server.job.thread.is_alive():
                    self.server.job.cancel()
            self.json({"state": "cancellation_requested"})
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
