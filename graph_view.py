"""Derive the renderable graph from committed meanings in one snapshot/profile."""
from source import digest, encode


def completed_graph(revision, units, results, tasks):
    valid = {uid: result for uid, result in results.items()
             if uid in units and result["status"] == "submitted" and result.get("meaning")
             and not tasks.get(uid, {}).get("stale")}
    # Defend against version mismatches even if an interrupted writer left a prior submission.
    versions = {uid: result.get("version") or digest(encode(result).encode())
                for uid, result in results.items()
                if uid in units and result["status"] in {"submitted", "partial"}
                and not tasks.get(uid, {}).get("stale")}
    consumers = {}
    invalid = set()
    for uid, result in valid.items():
        for ref in result.get("dependencies", ()):
            consumers.setdefault(ref["unit"], []).append(uid)
            if versions.get(ref["unit"]) != ref["version"]:
                invalid.add(uid)
    stack = list(invalid)
    while stack:
        for parent in consumers.get(stack.pop(), ()):
            if parent not in invalid:
                invalid.add(parent)
                stack.append(parent)
    for uid in invalid:
        valid.pop(uid)
    nodes = [
        dict(id=uid, name=units[uid]["name"], version=versions[uid],
             quality=tasks.get(uid, {}).get("state") == "QUALITY_VERIFIED")
        for uid in sorted(valid)
    ]
    edges = []
    for uid in sorted(valid):
        result = valid[uid]
        for edge in result["relations"]:
            target = edge["target"]
            if target in valid:
                edges.append(dict(source=uid, target=target, dependency=False, kind=edge["kind"],
                                  certainty=edge["certainty"], version=versions[uid]))
        # Live connection discovery can change before a new meaning commits. Use its saved provenance.
        for ref in result.get("dependencies", ()):
            target = ref["unit"]
            if target in valid:
                edges.append(dict(source=uid, target=target, dependency=True, kind="dependency",
                                  certainty="confirmed", version=versions[uid]))
    counts = dict(total=len(units), completed=len(valid),
                  partial=sum(uid in units and result["status"] == "partial"
                              for uid, result in results.items()))
    return dict(revision=revision, nodes=nodes, edges=edges, counts=counts)
