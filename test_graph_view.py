import unittest

from graph_view import completed_graph


def result(version, status="submitted", relations=(), dependencies=()):
    return dict(version=version, status=status, meaning={"role":version}, relations=list(relations),
                dependencies=list(dependencies))


def call(target):
    return dict(kind="call", target=target, certainty="confirmed")


class GraphViewTests(unittest.TestCase):
    def test_visible_units_and_relationships_follow_committed_results(self):
        units = {uid: {"name":uid} for uid in "abcde"}
        results = dict(a=result("v-a", relations=[call("a"), call("b")]),
                       b=result("v-b", "partial"), c=result("v-c", "stale"),
                       d=result("v-d"))
        tasks = dict(a={"state":"CONNECTING"}, d={"state":"QUALITY_VERIFIED"})
        visible = completed_graph("test",units,results,tasks)
        self.assertEqual(visible["counts"], {"total":5, "completed":2, "partial":1})
        self.assertEqual([(n["id"],n["quality"]) for n in visible["nodes"]], [("a",False),("d",True)])
        self.assertEqual([(e["source"],e["target"]) for e in visible["edges"]], [("a","a")])
        results["b"] = result("new-b")
        visible = completed_graph("test",units,results,tasks)
        self.assertEqual([(e["source"],e["target"]) for e in visible["edges"]], [("a","a"),("a","b")])

    def test_dependency_versions_and_transitive_invalidity(self):
        units = {uid: {"name":uid} for uid in "abc"}
        results = dict(a=result("a1", dependencies=[dict(unit="b",version="b1")]),
                       b=result("b1", dependencies=[dict(unit="c",version="c1")]),
                       c=result("c1"))
        complete = completed_graph("test",units,results,{})
        self.assertEqual(len(complete["edges"]),2)
        self.assertTrue(all(edge["dependency"] for edge in complete["edges"]))
        results["c"] = result("c2")
        changed = completed_graph("test",units,results,{})
        self.assertEqual([node["id"] for node in changed["nodes"]], ["c"])
        self.assertEqual(changed["edges"], [])

    def test_empty_and_quality_are_independent(self):
        units = {"a":{"name":"one"}}
        self.assertEqual(completed_graph("test",units,{}, {})["nodes"], [])
        legacy = result(None)
        first = completed_graph("test",units,{"a":legacy},{})
        second = completed_graph("test",units,{"a":legacy},{"a":{"state":"QUALITY_VERIFIED"}})
        self.assertEqual(first["nodes"][0]["version"],second["nodes"][0]["version"])
        self.assertTrue(second["nodes"][0]["quality"])
