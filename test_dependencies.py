"""Dependency scheduling regressions using real Python snapshots and scripted model turns."""
import ast
import json
from pathlib import Path
import tempfile
import unittest

from agent import analyze
from dependency_store import Checkpoints
from main import export, register
from responses import DEFAULT_MODEL


class ScriptedProvider:
    def __init__(self, snapshot, relations, *, detour=None, stop=None):
        self.units = snapshot["units"]
        self.ids = {u["name"]: uid for uid, u in self.units.items() if u["kind"] == "function"}
        self.relations = relations
        self.detour = detour
        self.stop = stop
        self.calls = []

    async def models(self):
        return [{"id": DEFAULT_MODEL}]

    async def generate(self, model, effort, instructions, messages, tools):
        uid = ast.literal_eval(messages[0]["content"].split("ID는 ", 1)[1].split(". 도구", 1)[0])
        unit = self.units[uid]
        name = unit["name"]
        context = json.loads(messages[1]["content"].split(": ", 1)[1])
        used = [json.loads(item["arguments"]) for item in messages if item.get("type") == "function_call"]
        phase = "connection" if any(t["name"] == "submit_relations" for t in tools) else "semantic"
        if not used:
            self.calls.append((name, phase))
            if self.stop == (name, phase):
                raise RuntimeError("scripted interruption")
            return self.call("read_unit", unit=uid)
        targets = self.relations.get(name, [])
        if phase == "connection":
            if self.detour and name == self.detour[0] and not context.get("investigate"):
                targets = []
            for target in targets:
                if target in self.ids and {"unit": self.ids[target]} not in used:
                    return self.call("read_unit", unit=self.ids[target])
            edges = [dict(kind="call", certainty="confirmed" if target in self.ids else "unresolved",
                          target=self.ids.get(target), evidence=[dict(unit=uid, line=unit["sites"][-1]["line"])],
                          reason=f"Call evidence for {target}.") for target in targets]
            return self.call("submit_relations", relations=edges,
                             dependencies=[self.ids[target] for target in targets if target in self.ids])
        if self.detour and name == self.detour[0] and not context["prepared"]:
            target = self.ids[self.detour[1]]
            if {"unit": target} not in used:
                return self.call("read_unit", unit=target)
            return self.call("revisit_connection", target=target, reason="New local target.",
                             evidence=[dict(unit=uid, line=unit["sites"][-1]["line"])])
        for ref in context["prepared"]:
            if {"unit": ref["unit"]} not in used:
                return self.call("get_meaning", unit=ref["unit"])
        return self.call("submit_meaning", role=f"Role of {name}.",
                         steps=[dict(text="Record the direct execution effect.",
                                     sites=[site["id"] for site in unit["sites"]])],
                         unresolved=[])

    def call(self, tool, **args):
        # IDs only have to be unique within one phase.
        return dict(output=[dict(type="function_call", name=tool, arguments=json.dumps(args),
                                 call_id=f"{tool}:{json.dumps(args,sort_keys=True)}")])


class DependencyTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name) / "source"
        self.root.mkdir()
        self.db = self.root.parent / "data" / "review.sqlite3"

    def fixture(self, **sources):
        for name, body in sources.items():
            (self.root / f"{name}.py").write_text(body, encoding="utf-8")
        return register(self.db, self.root)

    async def run_unit(self, provider, rev, name):
        return await analyze(provider, self.db, rev, only=provider.ids[name], limit=1)

    async def test_dependency_chain_shared_reuse_and_source_change(self):
        # A → B → C and D → C. E is an independent source.
        rev, snap = self.fixture(a="from b import b\ndef a(x):\n    return b(x)\n",
                                 b="from c import c\ndef b(x):\n    return c(x)\n",
                                 c="def c(x):\n    return x + 1\n",
                                 d="from c import c\ndef d(x):\n    return c(x)\n",
                                 e="def e(x):\n    return -x\n")
        links = {"a":["b"], "b":["c"], "d":["c"]}
        provider = ScriptedProvider(snap, links)
        report = await self.run_unit(provider, rev, "a")
        await self.run_unit(provider, rev, "d")
        await self.run_unit(provider, rev, "e")
        self.assertEqual(provider.calls, [
            ("a","connection"), ("b","connection"), ("c","connection"), ("c","semantic"),
            ("b","semantic"), ("a","semantic"), ("d","connection"), ("d","semantic"),
            ("e","connection"), ("e","semantic")])
        saved = export(self.db, rev)
        self.assertTrue(any(event["event"].get("waiting") == [provider.ids["c"]] for event in saved["events"]))
        key = json.dumps(report["profile"], ensure_ascii=False, sort_keys=True)
        checkpoints = Checkpoints(self.db, rev, key)
        _, connections, _, results = checkpoints.read()
        c = provider.ids["c"]
        changed_meaning = dict(results[c]["meaning"], role="Change the recorded meaning version.")
        checkpoints.semanticize(c, changed_meaning, connections[c], [], [], {"c.py"})
        self.assertTrue(all(checkpoints.read()[3][provider.ids[name]]["status"] == "stale" for name in ("a","b","d")))
        await self.run_unit(provider, rev, "a")
        await self.run_unit(provider, rev, "d")
        new_rev, new_snap = self.fixture(c="def c(x):\n    return x + 2\n")
        new_checkpoint = Checkpoints(self.db, new_rev, key)
        states, _, _, results = new_checkpoint.read()
        self.assertTrue(all(results[provider.ids[name]]["status"] == "stale" for name in ("a","b","d")))
        self.assertEqual(states[provider.ids["e"]], "SEMANTIC_SUBMITTED")
        updated = ScriptedProvider(new_snap, links)
        await self.run_unit(updated, new_rev, "a")
        await self.run_unit(updated, new_rev, "d")
        self.assertEqual(updated.calls.count(("c","semantic")), 1)
        self.assertNotIn(("e","connection"), updated.calls)

    async def test_cycle_external_dependency_and_dynamic_boundary(self):
        rev, snap = self.fixture(a="def a(x):\n    return b(x)\n",
                                 b="def b(x):\n    return a(c(x))\n",
                                 c="def c(x):\n    return callback(x)\n")
        provider = ScriptedProvider(snap, {"a":["b"], "b":["a","c"], "c":["callback"]})
        report = await self.run_unit(provider, rev, "a")
        self.assertEqual(provider.calls, [("a","connection"), ("b","connection"), ("c","connection"),
                                         ("c","semantic"), ("a","semantic"), ("b","semantic")])
        self.assertEqual(report["processed"], 3)
        results = {r["unit"]:r for r in export(self.db, rev)["results"]}
        self.assertEqual(results[provider.ids["c"]]["relations"][0]["certainty"], "unresolved")
        self.assertEqual(results[provider.ids["a"]]["boundaries"][0]["kind"], "cycle")
        self.assertEqual(results[provider.ids["a"]]["status"], "partial")
        self.assertEqual(results[provider.ids["b"]]["dependencies"][0]["unit"], provider.ids["c"])

    async def test_restart_restores_connections_and_late_dependency_revisits(self):
        rev, snap = self.fixture(a="def a(x):\n    return b(x)\n", b="def b(x):\n    return x\n")
        links = {"a":["b"]}
        first = ScriptedProvider(snap, links, stop=("b","semantic"))
        with self.assertRaisesRegex(RuntimeError, "scripted interruption"):
            await self.run_unit(first, rev, "a")
        resumed = ScriptedProvider(snap, links)
        await self.run_unit(resumed, rev, "a")
        self.assertEqual(resumed.calls, [("b","semantic"), ("a","semantic")])
        rev, snap = self.fixture(a="def a(x):\n    return b(x) + 0\n")
        late = ScriptedProvider(snap, links, detour=("a","b"))
        await self.run_unit(late, rev, "a")
        self.assertEqual(late.calls, [("a","connection"), ("a","semantic"),
                                       ("a","connection"), ("a","semantic")])
        trace = export(self.db, rev)["events"]
        self.assertTrue(any(row["event"].get("state") == "dependency_revisit" for row in trace))
