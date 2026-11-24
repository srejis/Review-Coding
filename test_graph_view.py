from pathlib import Path
import tempfile
import unittest

from graph_view import completed_graph
from main import register
from mcp_tools import AnalysisTools
from source import COMPOSITION_SCHEMA, index


def result(version, status="submitted", relations=(), dependencies=(), **meaning):
    return dict(version=version, status=status, meaning={"role": version, **meaning},
                relations=list(relations), dependencies=list(dependencies))


def relation(kind, source, target, line, certainty="confirmed"):
    return dict(kind=kind, target=target, certainty=certainty, reason="Source evidence",
                evidence=[dict(unit=source, line=line)])


class GraphViewTests(unittest.TestCase):
    def graph(self, results, tasks=None):
        return completed_graph("test", self.units, results, tasks or {}, self.files)

    def snapshot(self, **files):
        self.files = {file: {"source": source} for file, source in files.items()}
        self.units = {uid: unit for file, source in files.items() for uid, unit in index(source, file).items()}

    def uid(self, name):
        return next(uid for uid, unit in self.units.items() if unit["name"] == name)

    def test_visible_units_and_relationships_follow_committed_results(self):
        self.snapshot(**{"sample.py": "def a():\n    a()\n    b()\ndef b(): pass\ndef c(): pass\ndef d(): pass\n"})
        a, b, c, d = map(self.uid, "abcd")
        results = {a: result("v-a", relations=[relation("call", a, a, 2), relation("call", a, b, 3)]),
                   b: result("v-b", "partial"), c: result("v-c", "stale"), d: result("v-d")}
        tasks = {a: {"state": "CONNECTING"}, d: {"state": "QUALITY_VERIFIED"}}
        visible = self.graph(results, tasks)
        self.assertEqual(visible["counts"], {"total": 5, "completed": 2, "partial": 1})
        self.assertEqual([(n["id"], n["quality"], n["degree"]) for n in visible["nodes"]],
                         [(a, False, 1), (d, True, 0)])
        self.assertEqual([(e["source"], e["target"]) for e in visible["edges"]], [(a, a)])
        results[b] = result("new-b")
        visible = self.graph(results, tasks)
        self.assertEqual([(e["source"], e["target"]) for e in visible["edges"]], [(a, a), (a, b)])

    def test_dependency_versions_and_transitive_invalidity(self):
        self.snapshot(**{"sample.py": "def a(): pass\ndef b(): pass\ndef c(): pass\n"})
        a, b, c = map(self.uid, "abc")
        results = {a: result("a1", dependencies=[dict(unit=b, version="b1")]),
                   b: result("b1", dependencies=[dict(unit=c, version="c1")]), c: result("c1")}
        self.assertEqual(self.graph(results)["edges"], [])
        results[c] = result("c2")
        changed = self.graph(results)
        self.assertEqual([node["id"] for node in changed["nodes"]], [c])
        self.assertEqual(changed["edges"], [])

    def test_empty_and_quality_are_independent(self):
        self.snapshot(**{"sample.py": ""})
        a = self.uid("sample.py")
        self.assertEqual(self.graph({})["nodes"], [])
        legacy = result(None)
        first = self.graph({a: legacy})
        second = self.graph({a: legacy}, {a: {"state": "QUALITY_VERIFIED"}})
        self.assertEqual(first["nodes"][0]["version"], second["nodes"][0]["version"])
        self.assertTrue(second["nodes"][0]["quality"])

    def test_direct_containment_and_lowest_call_owner(self):
        self.snapshot(**{"sample.py": """def helper(): pass
class Service:
    helper()
    def method(self):
        helper()
helper()
"""})
        module, helper, cls, method = (self.uid(name) for name in ["sample.py", "helper", "Service", "method"])
        results = {module: result("1", relations=[relation("call", module, helper, line) for line in (5, 6)] +
                                  [relation("contains", module, method, 4)]),
                   cls: result("2", relations=[relation("call", cls, helper, line) for line in (3, 5)]),
                   helper: result("3"),
                   method: result("4", relations=[relation("call", method, helper, 5),
                                                 relation("reference", method, cls, 5),
                                                 relation("call", method, cls, 5, "candidate")],
                                  dependencies=[dict(unit=helper, version="3")])}
        graph = self.graph(results)
        edges = {(e["source"], e["target"], e["kind"]): e["evidence"] for e in graph["edges"]}
        self.assertEqual(set(edges), {(module, helper, "contains"), (module, cls, "contains"),
                                     (cls, method, "contains"), (method, helper, "call"),
                                     (cls, helper, "call"), (module, helper, "call")})
        self.assertEqual(len(edges[method, helper, "call"]), 3)
        self.assertEqual({node["kind"] for node in graph["nodes"]}, {"module", "class", "method", "function"})
        self.assertEqual({node["id"]: node["degree"] for node in graph["nodes"]},
                         {module: 3, helper: 4, cls: 3, method: 2})

    def test_split_edges_keep_evidence_and_depend_on_completed_parent(self):
        self.snapshot(**{"sample.py": "def helper(): pass\ndef worker():\n" + "    helper()\n"*33})
        worker, helper = self.uid("worker"), self.uid("helper")
        first, second = self.units[worker]["blocks"]
        results = {helper: result("helper"),
                   first: result("first", relations=[relation("call", first, helper, 3),
                                                   relation("call", first, second, 4)]),
                   second: result("second", relations=[relation("call", second, helper, 35)])}
        self.assertEqual([n["id"] for n in self.graph(results)["nodes"]], [helper])
        results[worker] = result("worker", composition=dict(schema=COMPOSITION_SCHEMA, blocks=[
            dict(unit=uid, version=results[uid]["version"]) for uid in [first, second]]))
        graph = self.graph(results)
        self.assertEqual({node["id"]: node["degree"] for node in graph["nodes"]}, {helper: 1, worker: 1})
        self.assertEqual(graph["edges"], [dict(source=worker, target=helper, kind="call", evidence=[
            dict(unit=first, line=3), dict(unit=second, line=35)])])
        results[worker]["status"] = "partial"
        self.assertFalse(self.graph(results)["edges"])

    def test_inheritance_recovers_only_proven_local_bases_and_validates_submission(self):
        files = {"pkg/__init__.py": "from .base import Base as Public\n",
                 "pkg/base.py": "class Base: pass\nclass Other: pass\n",
                 "pkg/app.py": """from . import Public as Alias
from .base import Other
class Child(
    Alias,
):
    value = Other
class Dynamic(make_base()): pass
class Plain:
    value = Other
class Outer:
    class NestedBase: pass
    class NestedChild(NestedBase): pass
"""}
        self.snapshot(**files)
        base, child, other, plain = (self.uid(name) for name in ["Base", "Child", "Other", "Plain"])
        results = {uid: result(uid) for uid in self.units}
        results[plain]["relations"] = [relation("reference", plain, other, 9)]
        edges = [e for e in self.graph(results)["edges"] if e["kind"] == "inheritance"]
        self.assertEqual({(e["source"], e["target"]) for e in edges}, {
            (child, base), (self.uid("NestedChild"), self.uid("NestedBase"))})
        self.assertIn(dict(unit=child, line=4), next(e["evidence"] for e in edges if e["source"] == child))

        with tempfile.TemporaryDirectory() as tmp:
            root, path = Path(tmp)/"project", Path(tmp)/"db"/"review.sqlite3"
            for name, source in files.items():
                file = root/name
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_text(source, encoding="utf-8")
            rev, _ = register(path, root)
            tools = AnalysisTools(path, rev, "test", child, "connection")
            for uid in [child, base, other]:
                tools.call("read_unit", {"unit": uid})
            for wrong in [relation("inheritance", child, other, 4), relation("inheritance", child, base, 6)]:
                with self.assertRaisesRegex(ValueError, "explicit base expression"):
                    tools.call("submit_relations", dict(relations=[wrong], dependencies=[]))
            valid = relation("inheritance", child, base, 4)
            tools.call("submit_relations", dict(relations=[valid], dependencies=[]))
            self.assertEqual(tools.staged["relations"], [valid])

    def test_explicit_relative_base_at_package_root_and_shadowed_module(self):
        self.snapshot(**{"__init__.py": "shadow = object()\n",
                         "base.py": "class Base: pass\n",
                         "shadow.py": "class Hidden: pass\n",
                         "child.py": """from .base import Base
from . import shadow
class Child(Base): pass
class Unproven(shadow.Hidden): pass
"""})
        results = {uid: result(uid) for uid in self.units}
        self.assertEqual([(edge["source"], edge["target"]) for edge in self.graph(results)["edges"]
                          if edge["kind"] == "inheritance"], [(self.uid("Child"), self.uid("Base"))])
