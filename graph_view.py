"""Derive the renderable graph from committed meanings in one snapshot/profile."""
from source import digest, encode, composition_refs, composition_current
from source_relations import SourceRelations


def completed_graph(revision, units, results, tasks, files):
    valid = {uid: result for uid, result in results.items()
             if uid in units and result["status"] == "submitted" and result.get("meaning")
             and not tasks.get(uid, {}).get("stale")
             and composition_current({"id":uid}, units, results)}
    # Defend against version mismatches even if an interrupted writer left a prior submission.
    versions = {uid: result.get("version") or digest(encode(result).encode())
                for uid, result in results.items()
                if uid in units and result["status"] in {"submitted", "partial"}
                and not tasks.get(uid, {}).get("stale")}
    consumers = {}
    invalid = set()
    for uid, result in valid.items():
        for ref in [*result.get("dependencies", ()), *composition_refs(result)]:
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
    visible = {uid for uid in valid if units[uid]["kind"] != "block"}
    facts = SourceRelations(units, files)
    edges = {}

    def display_unit(uid):
        unit = units[uid]
        return unit.get("partition_parent", unit["parent"]) if unit["kind"] == "block" else uid

    def add(source, target, kind, evidence):
        if source in visible and target in visible:
            edges.setdefault((source, target, kind), set()).update(
                (ref["unit"], ref["line"]) for ref in evidence if ref["unit"] in units)

    for uid in sorted(visible):
        parent = units[uid]["parent"]
        add(parent, uid, "contains", [dict(unit=uid, line=units[uid]["line"])])
        if units[uid]["kind"] == "class":
            for edge in facts.confirmed_bases(uid):
                add(uid, edge["target"], "inheritance", edge["evidence"])

    for uid, result in sorted(valid.items()):
        source = display_unit(uid)
        if source not in visible:
            continue
        for edge in result["relations"]:
            kind, target = edge["kind"], edge["target"]
            if target not in valid or edge["certainty"] != "confirmed":
                continue
            evidence = edge.get("evidence", ())
            if kind == "call":
                caller = facts.call_owner(uid, evidence)
                if caller is None or (units[target]["kind"] == "block" and display_unit(target) == caller):
                    continue
                add(caller, display_unit(target), kind, evidence)
            elif kind == "inheritance" and units[target]["kind"] == "class":
                if units[uid]["kind"] == "class" and facts.inheritance(uid, target, evidence):
                    add(uid, target, "inheritance", evidence)

    degrees = dict.fromkeys(visible, 0)
    connections = []

    def source_order(ref):
        uid, line = ref
        return units[uid]["file"], line, uid

    for (source, target, kind), evidence in sorted(edges.items()):
        degrees[source] += 1
        if source != target:
            degrees[target] += 1
        connections.append(dict(source=source, target=target, kind=kind,
                                evidence=[dict(unit=uid, line=line)
                                          for uid, line in sorted(evidence, key=source_order)]))
    nodes = [
        dict(id=uid, name=units[uid]["name"], kind=units[uid]["kind"],
             degree=degrees[uid], version=versions[uid],
             quality=tasks.get(uid, {}).get("state") == "QUALITY_VERIFIED")
        for uid in sorted(visible)
    ]
    counts = dict(total=len(units), completed=len(valid),
                  partial=sum(uid in units and result["status"] == "partial"
                              for uid, result in results.items()))
    return dict(revision=revision, nodes=nodes, edges=connections, counts=counts)
