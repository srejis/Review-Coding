"""Iterative dependency scheduling over the graph discovered so far."""
from dependency_store import TERMINAL, FAILURES


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
