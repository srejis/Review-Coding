"""Regression tests for bounded automatic repair and logical projects."""
import asyncio
from collections import Counter
import json
from pathlib import Path
import tempfile
import unittest

from agent import analyze
from chatgpt_auth import ServiceError
from dependency_store import Checkpoints
from main import register
from mcp_tools import AnalysisTools
from review_server import delete_project, display_profile, project_catalog, project_id
from source import analysis_lock, database, encode
from test_dependencies import ScriptedProvider


class RepairProvider(ScriptedProvider):
    def __init__(self, snapshot, *, hold=None, permanent=False):
        super().__init__(snapshot, {"a": ["b"]})
        self.hold, self.permanent = hold, permanent
        self.submissions = Counter()

    async def generate(self, model, effort, instructions, messages, tools):
        response = await super().generate(model, effort, instructions, messages, tools)
        item = response["output"][0]
        arguments = json.loads(item["arguments"])
        name, phase = self.calls[-1]
        context = json.loads(messages[1]["content"].split(": ", 1)[1])
        if self.hold and name == "b" and phase == "semantic" and context.get("repair"):
            self.hold.set()
            await asyncio.Future()
        if item["name"] == "submit_relations" and name == "b":
            uid = self.ids[name]
            args = dict(relations=[dict(kind="call", target=None, certainty="external",
                        evidence=[dict(unit=uid, line=self.units[uid]["sites"][-1]["line"])],
                        reason="Use the built-in to count items.")], dependencies=[])
            return self.call(item["name"], **args)
        if item["name"] == "submit_meaning":
            self.submissions[name] += 1
            if name == "b" and (self.permanent or not context.get("repair")):
                arguments["steps"][0]["sites"].pop()
                arguments["unresolved"] = ["Explain the returned count."]
                return self.call(item["name"], **arguments)
        return response


class RecoveryTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        root = Path(directory.name)
        self.project = root / "src"
        self.project.mkdir()
        self.db = root / "app" / "review.sqlite3"
        (self.project / "src.py").write_text(
            "def a(x):\n    return b(x)\ndef b(x):\n    data = x\n    return len(data)\ndef stable():\n    return 1\n")
        self.rev, self.snap = register(self.db, self.project)

    async def test_external_and_missing_sites_repair_dependency_then_consumer(self):
        provider = RepairProvider(self.snap)
        report = await analyze(provider, self.db, self.rev, recover=True, limit=1, seconds=.001)
        self.assertEqual(report["state"], "finished")
        self.assertEqual(provider.submissions["a"], 2)
        self.assertEqual(provider.submissions["b"], 2)
        self.assertEqual(provider.submissions["stable"], 1)
        c = Checkpoints(self.db, self.rev, encode(report["profile"]))
        states, _, _, results = c.read()
        b, a = (provider.ids[name] for name in ("b", "a"))
        self.assertEqual(states[b], "SEMANTIC_SUBMITTED")
        self.assertEqual(results[b]["boundaries"][0]["kind"], "external")
        self.assertEqual(results[a]["dependencies"], [dict(unit=b, version=results[b]["version"])])
        _, history = c.recovery_state()
        self.assertEqual(history[b][0]["phase"], "semantic")
        self.assertIn("missing_sites", {item["code"] for item in history[b][0]["reasons"]})

    async def test_same_failure_is_exhausted_and_resume_keeps_history(self):
        provider = RepairProvider(self.snap, permanent=True)
        result = await analyze(provider, self.db, self.rev, recover=True)
        self.assertEqual(result["state"], "partial")
        self.assertEqual(provider.submissions["b"], 2)
        self.assertEqual(result["retries"], 1)
        resumed = RepairProvider(self.snap)
        next_result = await analyze(resumed, self.db, self.rev, recover=True, previous=encode(result["profile"]))
        self.assertEqual(next_result["counts"], result["counts"])
        self.assertEqual(resumed.calls, [])

    async def test_consumer_waits_for_both_retryable_children_before_recomposition(self):
        (self.project / "src.py").write_text(
            "def a(x):\n    return b(x) + c(x)\n"
            "def b(x):\n    data = x\n    return len(data)\n"
            "def c(x):\n    data = x\n    return len(data)\n")
        revision, snap = register(self.db, self.project)

        class Siblings(RepairProvider):
            async def generate(inner, model, effort, instructions, messages, tools):
                answer = await super().generate(model, effort, instructions, messages, tools)
                result = answer["output"][0]
                context = json.loads(messages[1]["content"].split(": ", 1)[1])
                if (inner.calls[-1][0] == "c" and result["name"] == "submit_meaning"
                        and not context["repair"]):
                    arguments = json.loads(result["arguments"])
                    arguments["steps"][0]["sites"].pop()
                    arguments["unresolved"] = ["Explain the count."]
                    return inner.call(result["name"], **arguments)
                return answer

        provider = Siblings(snap)
        provider.relations["a"] = ["b", "c"]
        report = await analyze(provider, self.db, revision, recover=True)
        self.assertEqual(report["state"], "finished")
        self.assertEqual(provider.submissions["a"], 2)
        self.assertEqual(provider.submissions["b"], 2)
        self.assertEqual(provider.submissions["c"], 2)

    async def test_interrupted_retry_continues_from_durable_attempt(self):
        ready = asyncio.Event()
        interrupted = RepairProvider(self.snap, hold=ready)
        task = asyncio.create_task(analyze(interrupted, self.db, self.rev, recover=True))
        await asyncio.wait_for(ready.wait(), 10)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        with database(self.db) as db:
            previous, state = db.execute("SELECT profile,state FROM analysis_run").fetchone()
        self.assertEqual(state, "cancelled")
        resumed = RepairProvider(self.snap)
        report = await analyze(resumed, self.db, self.rev, recover=True, previous=previous)
        self.assertEqual(report["state"], "finished")
        self.assertEqual(report["retries"], 1)
        self.assertNotIn(("stable", "semantic"), resumed.calls)

    async def test_legacy_profile_is_validated_and_preserved(self):
        original = await analyze(RepairProvider(self.snap), self.db, self.rev, full=True)
        old_key = encode(original["profile"])
        old = Checkpoints(self.db, self.rev, old_key).read()[3]
        provider = RepairProvider(self.snap)
        current = await analyze(provider, self.db, self.rev, recover=True, previous=old_key)
        self.assertNotEqual(encode(current["profile"]), old_key)
        self.assertEqual(Checkpoints(self.db, self.rev, old_key).read()[3], old)
        self.assertNotIn(("stable", "semantic"), provider.calls)
        self.assertEqual(current["state"], "finished")

    async def test_unconfirmed_connection_reopens_connection_phase(self):
        class Candidate(RepairProvider):
            async def generate(inner, model, effort, instructions, messages, tools):
                answer = await super().generate(model, effort, instructions, messages, tools)
                item = answer["output"][0]
                context = json.loads(messages[1]["content"].split(": ", 1)[1])
                if item["name"] == "submit_relations" and inner.calls[-1][0] == "a" and not context["repair"]:
                    args = json.loads(item["arguments"])
                    args["relations"][0]["certainty"] = "candidate"
                    args["dependencies"] = []
                    return inner.call("submit_relations", **args)
                return answer
        provider = Candidate(self.snap)
        report = await analyze(provider, self.db, self.rev, recover=True)
        self.assertEqual(report["state"], "finished")
        self.assertEqual(provider.calls.count(("a", "connection")), 2)

    async def test_transient_provider_failure_is_repaired_at_same_phase(self):
        class Transient(ScriptedProvider):
            failed = False

            async def generate(inner, model, effort, instructions, messages, tools):
                if not inner.failed and repr(inner.ids["stable"]) in messages[0]["content"] and any(
                        tool["name"] == "submit_meaning" for tool in tools):
                    inner.failed = True
                    raise ServiceError("provider_error", "OpenAI request failed (HTTP 503).")
                return await super().generate(model, effort, instructions, messages, tools)
        provider = Transient(self.snap, {"a": ["b"]})
        report = await analyze(provider, self.db, self.rev, recover=True)
        self.assertEqual(report["state"], "finished")
        _, history = Checkpoints(self.db, self.rev, encode(report["profile"])).recovery_state()
        trial, = history[provider.ids["stable"]]
        self.assertEqual(trial["phase"], "semantic")
        self.assertEqual(trial["reasons"][0]["code"], "transient_provider")
        self.assertEqual(provider.calls.count(("stable", "connection")), 1)

    def test_owned_return_exposes_eager_nested_arguments(self):
        (self.project / "nested.py").write_text(
            "def nested():\n    return expand(getenv('A', join(getenv('B'), 'suffix')))\n")
        revision, snap = register(self.db, self.project)
        uid = next(uid for uid, unit in snap["units"].items() if unit["name"] == "nested")
        view = AnalysisTools(self.db, revision, "test", uid, "semantic", recover=True)
        effects = view.call("read_unit", {"unit":uid})["effects"]
        self.assertIn("expand, getenv, join", effects[0]["facts"][0])

    async def test_group_versions_and_delete_only_after_active_revision_released(self):
        file = self.project / "src.py"
        file.write_text("x = 2\n")
        new, _ = register(self.db, self.project)
        other = self.project.parent / "other" / "src"
        other.mkdir(parents=True)
        other_rev, _ = register(self.db, other)
        with database(self.db) as db:
            projects = project_catalog(db)
        item = next(item for item in projects if item["id"] == project_id(str(self.project.resolve())))
        self.assertEqual(item["latest"], new)
        self.assertEqual({p["name"] for p in projects}, {"src"})
        self.assertEqual(len(projects), 2)
        self.assertEqual(len(item["snapshots"]), 2)
        with analysis_lock(self.db, self.rev):
            with self.assertRaises(ServiceError):
                delete_project(self.db, item["id"])
        self.assertEqual(set(delete_project(self.db, item["id"])), {self.rev, new})
        self.assertEqual(file.read_text(), "x = 2\n")
        with database(self.db) as db:
            self.assertEqual(db.execute("SELECT id FROM snapshot").fetchall(), [(other_rev,)])

    def test_default_profile_prefers_the_most_complete_saved_graph(self):
        units = list(self.snap["units"])
        with database(self.db) as db:
            for uid in units:
                db.execute("INSERT INTO result VALUES(?,?,?,?)",
                           (self.rev, "established", uid, encode({"status": "submitted"})))
            db.execute("INSERT INTO result VALUES(?,?,?,?)",
                       (self.rev, "recent", units[0], encode({"status": "submitted"})))
            self.assertEqual(display_profile(db, self.rev), "established")
