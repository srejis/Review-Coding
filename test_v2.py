"""Regression tests for v2 authorization, orchestration and local HTTP."""
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

import httpx

from agent import analyze
from chatgpt_auth import ChatGPTAuth, ServiceError
from main import export, register
from responses import DEFAULT_MODEL, Responses
from review_server import Handler, ReviewServer
from source import database, encode


class AgentTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.source = self.root / "project"
        self.source.mkdir()
        (self.source / "main.py").write_text("def f(x):\n    return x + 1\n")
        self.db = self.root / "data" / "review.sqlite3"
        self.revision, self.snapshot = register(self.db, self.source)
        self.unit = next(unit for unit in self.snapshot["units"].values() if unit["name"] == "f")

    async def test_stream_tool_loop(self):
        uid, site = self.unit["id"], self.unit["sites"][0]["id"]
        requests = []
        tools = [
            ("read_unit", dict(unit=uid)),
            ("submit_relations", dict(relations=[], dependencies=[])),
            ("read_unit", dict(unit=uid)),
            ("submit_meaning", dict(role="Increase the input by one.", unresolved=[],
                                    steps=[dict(text="Add one and return the sum.", sites=[site])]))
        ]

        def handler(request):
            self.assertEqual(request.headers["Authorization"], "Bearer synthetic-test-token")
            if request.method == "GET":
                return httpx.Response(200, json={"models":[{"slug":DEFAULT_MODEL,"visibility":"list"}]})
            body = json.loads(request.content)
            self.assertEqual(body["model"], DEFAULT_MODEL)
            self.assertEqual(body["reasoning"], {"effort":"medium"})
            self.assertTrue(body["stream"])
            self.assertFalse(body["store"])
            names = {item["name"] for item in body["tools"]}
            self.assertEqual("submit_relations" in names, len(requests) < 2)
            self.assertEqual("submit_meaning" in names, len(requests) >= 2)
            if requests and len(requests) != 2:
                self.assertEqual(body["input"][-1]["type"], "function_call_output")
            index = len(requests)
            requests.append(body)
            tool, args = tools[index]
            event = {"type":"response.completed","response":{"id":str(index), "output":[
                {"type":"function_call","name":tool,"arguments":encode(args),"call_id":f"call_{index}"}]}}
            return httpx.Response(200, text=f'data: {encode(event)}\n\n')

        provider = Responses("synthetic-test-token", httpx.MockTransport(handler))
        async with provider.client:
            report = await analyze(provider, self.db, self.revision, only=uid)
        self.assertEqual(report["processed"], 1)
        self.assertEqual(len(requests), 4)
        saved = export(self.db, self.revision)
        self.assertEqual(saved["results"][0]["meaning"]["missing"], [])
        self.assertEqual(saved["results"][0]["meaning"]["review"], "unreviewed")
        self.assertEqual(saved["results"][0]["profile"]["auth"], "chatgpt_plan_oauth")

    async def test_no_luna_does_not_request_another_model(self):
        def handler(request):
            self.assertEqual(request.method, "GET")
            return httpx.Response(200,json={"models":[{"slug":"gpt-6.1-sol","visibility":"list"}]})
        provider = Responses("synthetic-test-token", httpx.MockTransport(handler))
        async with provider.client:
            with self.assertRaisesRegex(ServiceError, "gpt-6-luna is unavailable"):
                await analyze(provider, self.db, self.revision)
        self.assertFalse(export(self.db, self.revision)["results"])

    async def test_terminal_completion_required(self):
        provider = Responses("synthetic-test-token", httpx.MockTransport(
            lambda _: httpx.Response(200, text='data: {"type":"response.output_text.delta"}\n\n')))
        async with provider.client:
            with self.assertRaisesRegex(ServiceError, "without a completed event"):
                await provider.generate(DEFAULT_MODEL, "medium", "", [], [])


class LocalTests(unittest.TestCase):
    def test_state_pkce_and_protected_storage(self):
        entries = {}
        with tempfile.TemporaryDirectory() as tmp, patch(
            "keyring.get_password", side_effect=lambda service, user: entries.get((service, user))
        ), patch("keyring.set_password", side_effect=lambda service, user, key: entries.update({(service,user):key})):
            auth = ChatGPTAuth(Path(tmp))
            redirect = 'http://127.0.0.1:36001/auth/callback'
            params = parse_qs(urlsplit(auth.begin(redirect)).query)
            self.assertEqual(params["client_id"], ["dynamic_agent_client"])
            self.assertEqual(params["code_challenge_method"], ["S256"])
            self.assertEqual(params["redirect_uri"], [redirect])
            self.assertEqual(len(params["code_challenge"][0]), 43)
            state = params["state"][0]
            with self.assertRaisesRegex(ServiceError, "not granted"):
                auth.finish(dict(state=state, error="access_denied"))
            with self.assertRaisesRegex(ServiceError, "invalid or expired"):
                auth.finish(dict(state=state, error="access_denied"))
            self.assertNotIn(b"profiles", auth.path.read_bytes())

    def test_legacy_reviews_and_login_redirect(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            src = root / "src"
            src.mkdir()
            (src / "a.py").write_text("pass\n")
            data = root / "data"
            revision, snap = register(data / "review.sqlite3", src)
            uid = next(iter(snap["units"]))
            legacy = encode(dict(model="gpt-6.1-sol", effort="low", auth="chatgpt"))
            result = dict(status="submitted", relations=[], meaning=dict(role="Pass", steps=[],
                                                                       missing=[], unresolved=[]))
            with database(data / "review.sqlite3") as db:
                db.execute("INSERT INTO result VALUES(?,?,?,?)", (revision,legacy,uid,encode(result)))
                db.execute("INSERT INTO feedback(snapshot,profile,unit,data) VALUES(?,?,?,?)",
                           (revision,legacy,uid,encode(dict(category="검수 메모",note="v1 note"))))
            assets = root / "dist"
            assets.mkdir()
            (assets / "index.html").write_text("React UI")
            auth = unittest.mock.Mock()
            with patch("review_server.UI", assets), ReviewServer(("127.0.0.1",0),Handler,data,auth) as server:
                worker = threading.Thread(target=server.serve_forever, daemon=True)
                worker.start()
                try:
                    with httpx.Client(base_url=server.base, trust_env=False) as client:
                        redirect = client.get("/auth/callback?state=test&code=placeholder")
                        self.assertEqual(redirect.headers["location"],"/?login=connected")
                        self.assertEqual(client.get(redirect.headers["location"],
                            headers={"Sec-Fetch-Site":"cross-site"}).text, "React UI")
                        self.assertEqual(client.get("/api/projects",
                            headers={"Sec-Fetch-Site":"cross-site"}).status_code, 403)
                        view = client.get("/api/snapshot",params={"revision":revision}).json()
                        self.assertEqual(view["results"][uid]["meaning"]["role"], "Pass")
                        self.assertEqual(view["feedback"][0]["note"], "v1 note")
                        graph = client.get("/api/snapshot", params={"revision":revision, "view":"graph"}).json()
                        self.assertEqual(graph["files"], {})
                        self.assertNotIn("meaning", graph["results"][uid])
                        self.assertEqual(graph["results"][uid]["status"], "submitted")
                        detail = client.get("/api/snapshot", params={
                            "revision":revision, "view":"unit", "unit":uid, "profile":legacy}).json()
                        self.assertEqual(detail["files"], {"a.py":(src / "a.py").read_bytes().decode()})
                        self.assertEqual(detail["results"][uid]["meaning"]["role"], "Pass")
                        empty_profile = client.get("/api/snapshot", params={
                            "revision":revision, "view":"unit", "unit":uid, "profile":""}).json()
                        self.assertEqual(empty_profile["profile"], "")
                        self.assertEqual(empty_profile["results"], {})
                        self.assertEqual(client.get("/api/export", params={"revision":revision}).json()
                                         ["results"][0]["unit"], uid)
                        self.assertEqual(client.post("/api/cancel", json={}, headers={"X-Review-Local":"1"}).json()
                                         ["state"], "cancellation_requested")
                        self.assertEqual(client.post("/api/cancel",json={}).status_code, 403)
                finally:
                    server.shutdown()
                    worker.join()


if __name__ == "__main__":
    unittest.main()
