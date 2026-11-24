
"""Continuous single-agent orchestration and failure isolation."""
import asyncio
from pathlib import Path
import tempfile
import unittest

from agent import analyze
from dependency_store import Checkpoints
from main import register
from source import encode
from test_dependencies import ScriptedProvider
from test_partitions import PartitionProvider


class FullAnalysisTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)/"src"
        self.root.mkdir()
        self.db = self.root.parent/"data"/"review.sqlite3"

    async def test_full_exceeds_all_batch_limits(self):
        (self.root/"many.py").write_text("".join(
            f"def fn{i}(x):\n    return x + {i}\n" for i in range(100)), encoding="utf8")
        revision, snapshot = register(self.db, self.root)
        provider = PartitionProvider(snapshot)
        report = await analyze(provider,self.db,revision,limit=1,seconds=.001,full=True)
        states = Checkpoints(self.db,revision,encode(report["profile"])).read()[0]
        self.assertGreater(report["phases"],192)
        self.assertGreater(len(states),12)
        self.assertEqual(report["remaining"],0)
        self.assertEqual(report["failed"],0)
        self.assertTrue(all(state=="SEMANTIC_SUBMITTED" for state in states.values()))

    async def test_failed_dependency_does_not_stop_unrelated_units(self):
        for name,body in dict(a="def a(x):\n    return bad(x)\n",
                              bad="def bad(x):\n    return x\n",
                              good="def good(x):\n    return x+1\n").items():
            (self.root/(name+".py")).write_text(body,encoding="utf8")
        revision,snapshot = register(self.db,self.root)
        provider = ScriptedProvider(snapshot,{"a":["bad"]},stop=("bad","semantic"))
        report = await analyze(provider,self.db,revision,full=True)
        states = Checkpoints(self.db,revision,encode(report["profile"])).read()[0]
        self.assertEqual(states[provider.ids["bad"]],"FAILED")
        self.assertEqual(states[provider.ids["a"]],"BLOCKED_DEPENDENCY")
        self.assertEqual(states[provider.ids["good"]],"SEMANTIC_SUBMITTED")
        self.assertEqual(report["failed"],2)
        self.assertEqual(report["remaining"],0)

    async def test_full_cancel_and_resume_reuses_committed_meanings(self):
        (self.root/"sample.py").write_text("def a(x):\n    return x\n",encoding="utf8")
        revision,snapshot = register(self.db,self.root)
        ready=asyncio.Event()
        class HeldProvider(PartitionProvider):
            async def generate(inner,model,effort,instructions,messages,tools):
                if "sample.py:1:1" in messages[0]["content"]:
                    ready.set()
                    await asyncio.Future()
                return await super().generate(model,effort,instructions,messages,tools)
        provider=HeldProvider(snapshot)
        task=asyncio.create_task(analyze(provider,self.db,revision,full=True))
        await asyncio.wait_for(ready.wait(),10)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        resumed=PartitionProvider(snapshot)
        report=await analyze(resumed,self.db,revision,full=True)
        self.assertEqual(report["remaining"],0)
        module=next(uid for uid,unit in snapshot["units"].items() if unit["kind"]=="module")
        self.assertNotIn((module,"semantic"),resumed.phases)
