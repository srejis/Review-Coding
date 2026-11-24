
"""Split ownership, composition provenance, and invalidation regressions."""
import ast
import json
from pathlib import Path
import tempfile
import unittest

from agent import analyze
from dependency_store import Checkpoints
from graph_view import completed_graph
from main import register
from mcp_tools import AnalysisTools
from responses import DEFAULT_MODEL
from source import database, encode, load_snapshot, split_blocks, validate_meaning


class PartitionProvider:
    """Scripted tool turns verify orchestration, not language-model accuracy."""
    def __init__(self, snapshot, partial=None):
        self.units = snapshot["units"]
        self.files = snapshot["files"]
        self.partial = partial
        self.phases = []

    async def models(self):
        return [{"id": DEFAULT_MODEL}]

    async def generate(self, model, effort, instructions, messages, tools):
        uid = ast.literal_eval(messages[0]["content"].split("ID는 ", 1)[1].split(". 도구", 1)[0])
        unit = self.units[uid]
        context = json.loads(messages[1]["content"].split(": ", 1)[1])
        phase = "connection" if any(tool["name"] == "submit_relations" for tool in tools) else "semantic"
        calls = [item for item in messages if item.get("type") == "function_call"]
        outputs = [json.loads(item["output"]) for item in messages if item.get("type") == "function_call_output"]
        if outputs and "error" in outputs[-1]:
            raise AssertionError(outputs[-1]["error"])
        if not calls:
            self.phases.append((uid, phase))
        used = [(call["name"], json.loads(call["arguments"])) for call in calls]
        if ("read_unit", {"unit": uid}) not in used:
            return self.call(calls, "read_unit", unit=uid)
        if phase == "connection":
            return self.call(calls, "submit_relations", relations=[], dependencies=[])
        owners = split_blocks(self.units, uid) or [unit]
        for owner in owners:
            if ("read_unit", {"unit": owner["id"]}) not in used:
                return self.call(calls, "read_unit", unit=owner["id"])
            file_lines = len(self.files[owner["file"]]["source"].splitlines())
            # Read all pages, including noncontiguous source ownership.
            for start in range(owner["line"] + 80, min(owner["end"], file_lines) + 1, 80):
                if ("read_unit", {"unit": owner["id"], "start": start}) not in used:
                    return self.call(calls, "read_unit", unit=owner["id"], start=start)
        for ref in [*context.get("prepared", []), *context.get("blocks", [])]:
            if ("get_meaning", {"unit": ref["unit"]}) not in used:
                return self.call(calls, "get_meaning", unit=ref["unit"])
        sites = [site["id"] for owner in owners for site in owner["sites"]]
        return self.call(calls, "submit_meaning", role="Summarize the assigned execution flow.",
                         steps=[dict(text="Combine the grounded execution effects.", sites=sites)],
                         unresolved=["Dynamic boundary remains."] if uid == self.partial else [])

    @staticmethod
    def call(calls, tool, **arguments):
        return dict(output=[dict(type="function_call", name=tool, arguments=encode(arguments),
                                 call_id=f"call-{len(calls)}")])


class PartitionTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / "src"
        self.root.mkdir()
        body = 'def large(x):\n    """Document the large function."""\n    def nested():\n        return 19\n'
        body += "".join(f"    x += {i}\n" for i in range(66)) + "    return x\n"
        self.body = body
        (self.root / "large.py").write_text(body, encoding="utf8")
        (self.root / "other.py").write_text("def small(x):\n    return x + 1\n", encoding="utf8")
        self.db = self.root.parent / "data" / "review.sqlite3"
        self.rev, self.snap = register(self.db, self.root)
        self.parent = next(unit for unit in self.snap["units"].values() if unit["name"] == "large")
        self.blocks = split_blocks(self.snap["units"], self.parent["id"])

    async def run_parent(self, partial=None):
        provider = PartitionProvider(self.snap, partial)
        report = await analyze(provider, self.db, self.rev, only=self.parent["id"])
        self.profile = encode(report["profile"])
        self.checkpoint = Checkpoints(self.db, self.rev, self.profile)
        return provider, self.checkpoint.read()

    def stage_parent(self, results):
        inputs = {block["id"]: results[block["id"]] for block in self.blocks}
        tools = AnalysisTools(self.db, self.rev, self.profile, self.parent["id"], "semantic",
                              list(inputs), inputs)
        tools.call("read_unit", dict(unit=self.parent["id"]))
        for block in self.blocks:
            tools.call("read_unit", dict(unit=block["id"]))
            tools.call("get_meaning", dict(unit=block["id"]))
        args = dict(role="Compose the entire function.",
                    steps=[dict(text="Preserve the complete execution flow.",
                                sites=[site["id"] for block in self.blocks for site in block["sites"]])],
                    unresolved=[])
        return tools, args

    async def test_ownership_order_and_legacy_snapshot(self):
        units = self.snap["units"]
        self.assertEqual(len(self.blocks), 3)
        self.assertEqual(self.parent["sites"], [])
        nested = next(unit for unit in units.values() if unit["name"] == "nested")
        self.assertNotIn(nested["id"], self.parent["blocks"])
        ids = [site["id"] for unit in units.values() for site in unit["sites"]]
        count = sum(isinstance(node, ast.stmt) for node in ast.walk(ast.parse(self.body))) + 2
        self.assertEqual(len(ids), count)
        self.assertEqual(len(ids), len(set(ids)))
        self.assertEqual([block["partition_order"] for block in self.blocks], [0, 1, 2])
        tools = AnalysisTools(self.db, self.rev, "{}", self.blocks[0]["id"], "semantic")
        original = tools.call("read_unit", dict(unit=self.blocks[0]["id"]))
        self.assertTrue(any("__doc__" in fact for effect in original["effects"] for fact in effect["facts"]))
        # Metadata is derived for existing snapshots without replacing immutable source.
        legacy = json.loads(encode(self.snap))
        for unit in legacy["units"].values():
            for key in ("blocks", "partition_parent", "partition_order"):
                unit.pop(key, None)
        with database(self.db) as db:
            db.execute("UPDATE snapshot SET data=? WHERE id=?", (encode(legacy), self.rev))
            loaded = load_snapshot(db, self.rev)[1]
        self.assertEqual(loaded["units"][self.parent["id"]]["blocks"], self.parent["blocks"])
        self.assertEqual(legacy["units"][self.parent["id"]]["sites"], [])

    async def test_blocks_precede_parent_without_model_call_relations(self):
        provider, (states, connections, deps, results) = await self.run_parent()
        uid = self.parent["id"]
        self.assertNotIn((uid, "connection"), provider.phases)
        self.assertEqual([unit for unit, phase in provider.phases if phase == "semantic"],
                         [*[block["id"] for block in self.blocks], uid])
        self.assertTrue(all(states[block["id"]] == "SEMANTIC_SUBMITTED" for block in self.blocks))
        self.assertEqual(results[uid]["status"], "submitted")
        self.assertEqual(results[uid]["dependencies"], [])
        refs = results[uid]["meaning"]["composition"]["blocks"]
        self.assertEqual([ref["unit"] for ref in refs], self.parent["blocks"])
        self.assertTrue(all(ref["version"] == results[ref["unit"]]["version"] for ref in refs))
        self.assertTrue(all(not connection["relations"] for connection in connections.values()))
        self.assertEqual(deps[uid], self.parent["blocks"])
        self.assertNotIn("nested", [self.snap["units"][unit]["name"] for unit, _ in provider.phases])

    async def test_missing_partial_empty_and_foreign_evidence_are_not_complete(self):
        with self.assertRaisesRegex(ValueError, "ownership context"):
            validate_meaning(self.parent, "Whole function.", [], [])
        with self.assertRaisesRegex(ValueError, "Prepare every"):
            validate_meaning(self.parent, "Whole function.", [], [], units=self.snap["units"])
        _, (_, connections, _, results) = await self.run_parent(self.blocks[0]["id"])
        uid = self.parent["id"]
        self.assertEqual(results[uid]["status"], "partial")
        tools, args = self.stage_parent(results)
        foreign = next(unit for unit in self.snap["units"].values() if unit["name"] == "small")
        tools.call("read_unit", dict(unit=foreign["id"]))
        bad = dict(args, steps=[dict(text="Foreign operation.", sites=[foreign["sites"][0]["id"]])])
        with self.assertRaisesRegex(ValueError, "owned source sites"):
            tools.call("submit_meaning", bad)
        with self.assertRaisesRegex(ValueError, "substantive composition"):
            tools.call("submit_meaning", dict(args, steps=[]))
        tools.call("submit_meaning", args)
        # Even omitting the unresolved warning in the model output cannot promote a partial block.
        saved = self.checkpoint.semanticize(uid, tools.staged["meaning"], connections[uid], [], [], tools.read_files)
        self.assertEqual(saved["status"], "partial")
        block = self.blocks[0]
        block_tools = AnalysisTools(self.db, self.rev, self.profile, block["id"], "semantic")
        block_tools.call("read_unit", dict(unit=block["id"]))
        with self.assertRaisesRegex(ValueError, "owned source sites"):
            block_tools.call("submit_meaning", dict(args, steps=[
                dict(text="Another block.", sites=[self.blocks[1]["sites"][0]["id"]])]))

    async def test_child_version_change_and_atomic_parent_submission(self):
        _, (_, connections, _, results) = await self.run_parent()
        parent = self.parent["id"]
        tools, args = self.stage_parent(results)
        tools.call("submit_meaning", args)
        block = self.blocks[0]["id"]
        self.checkpoint.semanticize(block, dict(results[block]["meaning"], role="A revised block role."),
                                    connections[block], [], [], {"large.py"})
        self.assertEqual(self.checkpoint.read()[3][parent]["status"], "stale")
        with self.assertRaisesRegex(ValueError, "versions changed"):
            self.checkpoint.semanticize(parent, tools.staged["meaning"], connections[parent], [], [], tools.read_files)
        resumed = PartitionProvider(self.snap)
        await analyze(resumed, self.db, self.rev, only=parent)
        self.assertEqual(resumed.phases, [(parent, "semantic")])
        updated = self.checkpoint.read()[3][parent]
        self.assertEqual(updated["status"], "submitted")
        self.assertNotEqual(updated["version"], results[parent]["version"])

    async def test_source_change_invalidates_composition_and_reuses_other_file(self):
        await self.run_parent()
        small = next(unit for unit in self.snap["units"].values() if unit["name"] == "small")
        provider = PartitionProvider(self.snap)
        await analyze(provider, self.db, self.rev, only=small["id"])
        before = self.checkpoint.read()[3][small["id"]]
        (self.root / "large.py").write_text(self.body.replace("x += 8\n", "x += 800\n"), encoding="utf8")
        revision, _ = register(self.db, self.root)
        states, _, _, results = Checkpoints(self.db, revision, self.profile).read()
        self.assertEqual(results[self.parent["id"]]["status"], "stale")
        self.assertEqual(results[small["id"]], before)
        self.assertEqual(states[small["id"]], "SEMANTIC_SUBMITTED")

    async def test_legacy_composition_is_stale_and_valid_blocks_are_reused(self):
        _, (_, _, _, results) = await self.run_parent()
        uid = self.parent["id"]
        old = dict(results[uid])
        old["meaning"] = dict(old["meaning"])
        del old["meaning"]["composition"]
        with database(self.db) as db:
            db.execute("UPDATE result SET data=? WHERE snapshot=? AND profile=? AND unit=?",
                       (encode(old), self.rev, self.profile, uid))
        self.assertEqual(self.checkpoint.read()[3][uid]["status"], "stale")
        self.assertTrue(all(self.checkpoint.read()[3][block["id"]] == results[block["id"]]
                            for block in self.blocks))
        provider = PartitionProvider(self.snap)
        await analyze(provider, self.db, self.rev, only=uid)
        self.assertEqual(provider.phases, [(uid, "semantic")])

    async def test_recursive_parent_waits_for_blocks_and_retains_cycle_boundary(self):
        # A site's block calls its parent. The structural edge still has to precede composition.
        _, (_, connections, _, results) = await self.run_parent()
        from dependency_scheduler import next_action
        from source import validate_relations
        parent = self.parent["id"]
        block = self.blocks[0]["id"]
        edge = dict(kind="call", certainty="confirmed", target=parent,
                    reason="Recursive call.", evidence=[dict(unit=block, line=self.blocks[0]["line"])])
        validate_relations(self.snap["units"], [edge])
        self.checkpoint.connect(block, dict(relations=[edge], dependencies=[parent]), {"large.py"})
        for uid in [parent, block]:
            self.checkpoint.state(uid, "WAITING_DEPENDENCIES")
        states, _, deps, _ = self.checkpoint.read()
        action = next_action(parent, states, deps, {parent: self.parent["blocks"]})
        self.assertEqual(action[1], block)
        self.assertIn(parent, action[-1])


    async def test_graph_rejects_old_composition_or_changed_block_without_new_edges(self):
        _, (_, _, _, results) = await self.run_parent()
        uid = self.parent["id"]
        def graph_for(saved):
            return completed_graph(self.rev, self.snap["units"], saved, {}, self.snap["files"])

        graph = graph_for(results)
        self.assertIn(uid, [node["id"] for node in graph["nodes"]])
        self.assertEqual(graph["edges"], [])
        changed = json.loads(encode(results))
        changed[self.blocks[0]["id"]]["version"] = "different-block-version"
        self.assertNotIn(uid, [node["id"] for node in
                              graph_for(changed)["nodes"]])
        legacy = json.loads(encode(results))
        del legacy[uid]["meaning"]["composition"]
        self.assertNotIn(uid, [node["id"] for node in
                              graph_for(legacy)["nodes"]])

    async def test_parent_requires_actual_block_source_and_meaning_reads(self):
        _, (_, _, _, results) = await self.run_parent()
        inputs = {block["id"]: results[block["id"]] for block in self.blocks}
        tools = AnalysisTools(self.db, self.rev, self.profile, self.parent["id"], "semantic",
                              list(inputs), inputs)
        tools.call("read_unit", dict(unit=self.parent["id"], start=self.parent["end"]))
        args = dict(role="Whole function.", steps=[dict(text="Combine grounded blocks.",
                    sites=[site["id"] for block in self.blocks for site in block["sites"]])], unresolved=[])
        with self.assertRaisesRegex(ValueError, "Read every prepared"):
            tools.call("submit_meaning", args)
        for block in self.blocks:
            tools.call("get_meaning", dict(unit=block["id"]))
        with self.assertRaisesRegex(ValueError, "Read the cited source"):
            tools.call("submit_meaning", args)
        # Reading the same immutable original through the parent is also valid;
        # ownership still remains with each block.
        tools.call("read_unit", dict(unit=self.parent["id"]))
        tools.call("submit_meaning", args)
        sources = tools.staged["meaning"]["composition"]["blocks"]
        self.assertEqual([site["line"] for ref in sources for site in ref["source"]],
                         [site["line"] for block in self.blocks for site in block["sites"]])
