"""Iterative dependency scheduling over the graph discovered so far."""
from dependency_store import TERMINAL, FAILURES
from source import digest, encode

RETRY_LIMIT = 2
RETRYABLE = {"agent_limit", "no_tool_call", "non_progress", "repeated_call", "tool_limit",
             "stream_interrupted", "incomplete", "timeout", "transient_provider",
             "legacy_failure", "rejected_submission"}


def repair_reasons(uid, saved, metadata, invalid_evidence=False):
    meaning = saved.get("meaning", {})
    reasons = []
    if meaning.get("missing"):
        reasons.append(dict(code="missing_sites", sites=meaning["missing"]))
    if meaning.get("unresolved"):
        reasons.append(dict(code="unresolved_meaning", details=meaning["unresolved"]))
    blocks = {ref["unit"] for ref in meaning.get("composition", {}).get("blocks", ())}
    for item in saved.get("boundaries", ()):
        kind = item["kind"]
        if kind == "partial_dependency" and item.get("unit") in blocks:
            kind = "partial_block"
        reasons.append(dict(code=kind, unit=item.get("unit"), detail=item.get("reason")))
    if invalid_evidence:
        reasons.append(dict(code="invalid_connection_evidence"))
    failure = metadata.get("code")
    if failure:
        reasons.append(dict(code=failure, detail=metadata.get("error")))
    if metadata.get("failed_dependencies"):
        reasons.append(dict(code="blocked_dependency", units=metadata["failed_dependencies"]))
    return reasons


def next_repair(roots, states, connections, deps, results, metadata, history, invalid_evidence):
    """Pick a bounded retry, visiting dependent inputs before their consumers."""
    stack, visited = [(uid, False) for uid in reversed(roots)], set()
    while stack:
        uid, expanded = stack.pop()
        if not expanded:
            if uid in visited:
                continue
            visited.add(uid)
            stack.append((uid, True))
            stack.extend((target, False) for target in reversed(deps.get(uid, ())))
            continue
        state, saved = states.get(uid), results.get(uid, {})
        attempts = history.get(uid, ())
        if len(attempts) >= RETRY_LIMIT or state not in {"SEMANTIC_PARTIAL", *FAILURES}:
            continue
        meta = metadata.get(uid, {})
        reasons = repair_reasons(uid, saved, meta, uid in invalid_evidence)
        codes = {reason["code"] for reason in reasons}
        inputs = deps.get(uid, ())
        if codes & {"candidate", "unresolved", "invalid_connection_evidence"}:
            phase = "connection"
        elif state == "BLOCKED_DEPENDENCY":
            phase = "semantic" if uid in connections else "connection"
        elif state == "FAILED" and meta.get("code") not in RETRYABLE:
            continue
        elif meta.get("code") in RETRYABLE:
            phase = meta.get("phase", "connection")
        elif codes & {"missing_sites", "unresolved_meaning"} or (meta.get("seeded") and "external" in codes):
            phase = "semantic"
        else:
            continue
        if phase == "semantic" and uid not in connections:
            phase = "connection"
        if phase == "semantic" and any(states.get(target) in FAILURES for target in inputs):
            continue
        signature = digest(encode([phase, sorted(codes), saved.get("meaning", {}).get("missing", ()),
                                    sorted((str(reason.get("unit")), reason["code"]) for reason in reasons),
                                    [(target, states.get(target), results.get(target, {}).get("version"))
                                     for target in inputs]]).encode())
        limit = 2 if meta.get("code") in {"timeout", "transient_provider", "stream_interrupted"} else 1
        if sum(item["signature"] == signature for item in attempts) >= limit:
            continue
        return uid, phase, signature, reasons, len(attempts) + 1
    return None


def components(graph):
    """Kosaraju with explicit stacks, including edges to unconnected units."""
    nodes = list(dict.fromkeys([*graph, *(target for edges in graph.values() for target in edges)]))
    reverse = {node: [] for node in nodes}
    for node, edges in graph.items():
        for target in edges:
            reverse[target].append(node)
    seen, order = set(), []
    for node in nodes:
        if node in seen:
            continue
        seen.add(node)
        stack = [(node, iter(graph.get(node, ())))]
        while stack:
            current, edges = stack[-1]
            target = next(edges, None)
            if target is None:
                order.append(current)
                stack.pop()
            elif target not in seen:
                seen.add(target)
                stack.append((target, iter(graph.get(target, ()))))
    assigned = {}
    for node in reversed(order):
        if node in assigned:
            continue
        found, stack = {node}, [node]
        while stack:
            for target in reverse[stack.pop()]:
                if target not in found and target not in assigned:
                    found.add(target)
                    stack.append(target)
        group = tuple(sorted(found))
        assigned.update((member, group) for member in group)
    return assigned


def next_action(root, states, deps, partitions=None):
    """Return one phase, its dependency path, waiting frames, and SCC members."""
    partitions = partitions or {}
    terminal = TERMINAL | FAILURES
    groups = components(deps)
    stack = [(root, (root,), False)]
    seen, waiting = set(), {}
    while stack:
        uid, path, after_children = stack.pop()
        group = groups.get(uid, (uid,))
        cycle = group if len(group) > 1 or uid in deps.get(uid, ()) else ()
        ordered = (uid, *(member for member in group if member != uid))
        if after_children:
            # A block may call its owning function recursively. Compose the parent
            # after the blocks even when they share a runtime dependency SCC.
            for member in sorted(ordered, key=lambda member: bool(partitions.get(member))):
                if states.get(member) not in terminal:
                    return "semantic", member, path if member == uid else (*path, member), waiting, cycle
            continue
        if group in seen:
            continue
        seen.add(group)
        if all(states.get(member) in terminal for member in group):
            continue
        for member in ordered:
            if member not in deps or states.get(member) in {"NEW", "CONNECTING"}:
                return "connection", member, path if member == uid else (*path, member), waiting, cycle
        children = {}
        for member in ordered:
            for target in deps[member]:
                if target not in group and states.get(target) not in terminal:
                    children.setdefault(target, member)
                    waiting.setdefault(member, []).append(target)
        stack.append((uid, path, True))
        for child, member in reversed(list(children.items())):
            prefix = path if member == uid else (*path, member)
            stack.append((child, (*prefix, child), False))
    return None
