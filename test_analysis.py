import ast
import hashlib
from pathlib import Path
import sqlite3
import tempfile
import unittest

from dependency_store import Checkpoints
from main import export, register
from mcp_tools import AnalysisTools
from source import database, index


class AnalysisTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        base = Path(self.temp.name)
        self.root = base / "src"
        self.root.mkdir()
        self.file = self.root / "app.py"
        self.file.write_text("from other import f\ndef g(x):\n    return f(x)\n", encoding="utf8")
        (self.root / "other.py").write_text("def f(x):\n    return x * 2\n", encoding="utf8")
        (self.root / "bad.py").write_text("def incomplete(", encoding="utf8")
        (self.root / ".env.py").write_text("excluded", encoding="utf8")
        self.db = base / "product" / "review.sqlite3"
        self.rev, self.snap = register(self.db, self.root)
        self.unit = next(u for u in self.snap["units"].values() if u["name"] == "g")
        self.tools = AnalysisTools(self.db, self.rev, "{}", self.unit["id"], "connection")

    def test_snapshot_and_reanalysis(self):
        self.assertIn("bad.py", self.snap["issues"])
        self.assertNotIn(".env.py", self.snap["files"])
        self.assertIn(".env.py", self.snap["excluded"])
        original = hashlib.sha256(self.file.read_bytes()).hexdigest()
        self.assertEqual(self.snap["files"]["app.py"]["hash"], original)
        self.assertEqual(register(self.db, self.root)[0], self.rev)
        self.file.write_text("pass\n", encoding="utf8")
        self.assertNotEqual(register(self.db, self.root)[0], self.rev)
        self.assertEqual(export(self.db, self.rev)["source"]["files"]["app.py"]["hash"], original)
        with self.assertRaises(ValueError):
            register(self.root / "db.sqlite3", self.root)

    def test_scope_and_partition(self):
        raw = "def f():\n    def duplicate():\n        return 1\n"
        raw += "    if True:\n" + "".join(f"        a = {i}\n" for i in range(370))
        raw += "def g():\n    def duplicate():\n        return 2\n"
        units = index(raw, "sample.py")
        scopes = {u["scope"] for u in units.values() if u["name"] == "duplicate"}
        self.assertEqual(scopes, {"sample.py.f.duplicate", "sample.py.g.duplicate"})
        sites = [site["id"] for unit in units.values() for site in unit["sites"]]
        self.assertEqual(len(sites), sum(isinstance(node, ast.stmt) for node in ast.walk(ast.parse(raw))))
        self.assertEqual(len(set(sites)), len(sites))
        self.assertTrue(any(u["kind"] == "block" for u in units.values()))

    def test_tools_and_atomic_save(self):
        with self.assertRaises(KeyError):
            self.tools.call("read_unit", {"unit": "../../outside.py"})
        uid = self.unit["id"]
        self.tools.call("read_unit", {"unit": uid})
        target = self.tools.call("lookup_symbol", {"name": "f"})[0]["id"]
        edge = dict(kind="call",certainty="confirmed",target=target,
                    evidence=[dict(unit=uid,line=3)],reason="Imported f receives x.")
        with self.assertRaises(ValueError):
            self.tools.call("submit_relations", {"relations":[edge], "dependencies":[target]})
        self.tools.call("read_unit", {"unit": target})
        with self.assertRaises(ValueError):
            self.tools.call("submit_meaning", {})
        self.tools.call("submit_relations", {"relations":[edge], "dependencies":[target]})
        checkpoint = Checkpoints(self.db, self.rev, "{}")
        checkpoint.connect(uid, self.tools.staged, self.tools.read_files)
        self.assertEqual(export(self.db, self.rev)["results"], [])
        _, connections, deps, _ = checkpoint.read()
        self.assertEqual(deps[uid], [target])
        semantic = AnalysisTools(self.db, self.rev, "{}", uid, "semantic")
        semantic.call("read_unit", {"unit": uid})
        with self.assertRaises(ValueError):
            semantic.call("submit_meaning", dict(role="a",steps=[dict(text="x",sites=["bogus"])],unresolved=[]))
        semantic.call("submit_meaning", dict(role="Return twice the input.", steps=[
            dict(text="Pass x to f and return its result.", sites=[self.unit["sites"][0]["id"]])],
            unresolved=[]))
        checkpoint.semanticize(uid, semantic.staged["meaning"], connections[uid], [], [], semantic.read_files)
        self.assertEqual(export(self.db, self.rev)["results"][0]["status"], "submitted")
        self.assertNotIn(uid, [u["id"] for u in semantic.call("get_pending_tasks", {})["units"]])


if __name__ == "__main__":
    unittest.main()
