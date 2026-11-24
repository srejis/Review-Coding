"""Persistent dependency checkpoints and source-version invalidation."""
import json

from source import (database, digest, encode, load_snapshot, split_blocks,
                    composition_refs, composition_current, validate_meaning)

TERMINAL = {"SEMANTIC_SUBMITTED", "SEMANTIC_PARTIAL", "QUALITY_VERIFIED"}
FAILURES = {"FAILED", "BLOCKED_DEPENDENCY"}
ENGINE = "python-dependency-v3"


def read_state(db, revision, profile):
    key = (revision, profile)
    tasks = dict(db.execute("SELECT unit,state FROM analysis_task WHERE snapshot=? AND profile=?", key))
    connections = {uid: json.loads(raw) for uid, raw in db.execute(
        "SELECT unit,data FROM analysis_connection WHERE snapshot=? AND profile=?", key)}
    deps = {uid: [] for uid in connections}
    for uid, target in db.execute(
        "SELECT unit,target FROM analysis_dependency WHERE snapshot=? AND profile=? ORDER BY target", key):
        deps[uid].append(target)
    results = {uid: json.loads(raw) for uid, raw in db.execute(
        "SELECT unit,data FROM result WHERE snapshot=? AND profile=?", key)}
    _, snapshot = load_snapshot(db, revision)
    for uid in connections:
        # Structural prerequisites are derived from ownership, not model relations.
        blocks = [block["id"] for block in split_blocks(snapshot["units"], uid)]
        deps[uid] = list(dict.fromkeys([*blocks, *deps[uid]]))
    return tasks, connections, deps, results


class Checkpoints:
    def __init__(self, path, revision, profile):
        self.path, self.revision, self.profile = path, revision, profile

    def read(self):
        with database(self.path) as db:
            state = read_state(db, self.revision, self.profile)
            _, snapshot = load_snapshot(db, self.revision)
            invalid = {uid for uid, unit in snapshot["units"].items()
                       if not composition_current(unit, snapshot["units"], state[3])}
            if invalid:
                consumers = {uid: [ref["unit"] for ref in [
                    *saved.get("dependencies", []), *composition_refs(saved)]]
                    for uid, saved in state[3].items()}
                for uid in ancestors(consumers, invalid):
                    mark_stale(db, self.revision, self.profile, uid, state[3].get(uid),
                               keep_connections=True)
                state = read_state(db, self.revision, self.profile)
            return state

    def state(self, uid, state, **metadata):
        with database(self.path) as db:
            set_state(db, self.revision, self.profile, uid, state, metadata)

    def connect(self, uid, submission, reads):
        with database(self.path) as db:
            save_connection(db, self.revision, self.profile, uid, submission, reads)

    def revisit(self, uid, target):
        with database(self.path) as db:
            _, connections, deps, results = read_state(db, self.revision, self.profile)
            affected = ancestors(deps, {uid})
            for unit in affected:
                mark_stale(db, self.revision, self.profile, unit, results.get(unit))
            previous = connections.pop(uid)
            save_connection(db, self.revision, self.profile, uid,
                            dict(previous, revisit=target, reconsidered=[*previous.get("reconsidered", []), target]),
                            previous["reads"])
            set_state(db, self.revision, self.profile, uid, "NEW", {"revisit": target})

    def semanticize(self, uid, meaning, connections, refs, boundaries, reads):
        key = (self.revision, self.profile)
        with database(self.path) as db:
            # Keep version validation and the parent commit in the same write transaction.
            db.execute("BEGIN IMMEDIATE")
            _, _, deps, results = read_state(db, *key)
            _, snapshot = load_snapshot(db, self.revision)
            blocks = split_blocks(snapshot["units"], uid)
            if blocks:
                validated = validate_meaning(snapshot["units"][uid],
                    meaning["role"], meaning["steps"], meaning["unresolved"],
                    units=snapshot["units"], block_meanings=results)
                if meaning.get("composition") != validated.get("composition"):
                    raise ValueError("Block meaning versions changed before parent submission.")
                meaning = validated
            partial_blocks = any(results[block["id"]]["status"] != "submitted" or
                                 results[block["id"]]["meaning"]["missing"] or
                                 results[block["id"]]["meaning"]["unresolved"] for block in blocks)
            status = "partial" if meaning["missing"] or meaning["unresolved"] or boundaries or partial_blocks else "submitted"
            result = dict(status=status, relations=connections["relations"], meaning=meaning,
                          dependencies=refs, boundaries=boundaries, reads=sorted(reads))
            result["version"] = digest(encode(result).encode())
            previous = results.get(uid)
            if previous and previous.get("version") != result["version"]:
                consumers = {parent: [ref["unit"] for ref in [
                    *saved.get("dependencies", ()), *composition_refs(saved)]]
                             for parent, saved in results.items()}
                for parent in ancestors(consumers, {uid}) - {uid}:
                    if results[parent].get("status") in {"submitted", "partial"}:
                        mark_stale(db, *key, parent, results[parent], keep_connections=True)
            db.execute("INSERT OR REPLACE INTO result VALUES(?,?,?,?)", (*key, uid, encode(result)))
            set_state(db, *key, uid, "SEMANTIC_PARTIAL" if status == "partial" else "SEMANTIC_SUBMITTED")
        return result


def set_state(db, revision, profile, uid, state, metadata=None):
    db.execute("INSERT OR REPLACE INTO analysis_task VALUES(?,?,?,?,?)",
               (revision, profile, uid, state, encode(metadata or {})))


def save_connection(db, revision, profile, uid, submission, reads):
    key = (revision, profile, uid)
    data = dict(relations=submission["relations"], reads=sorted(reads),
                reconsidered=submission.get("reconsidered", []))
    if submission.get("revisit"):
        data["revisit"] = submission["revisit"]
    db.execute("INSERT OR REPLACE INTO analysis_connection VALUES(?,?,?,?)", (*key, encode(data)))
    if "dependencies" in submission:
        db.execute("DELETE FROM analysis_dependency WHERE snapshot=? AND profile=? AND unit=?", key)
        db.executemany("INSERT INTO analysis_dependency VALUES(?,?,?,?)",
                       ((*key, target) for target in submission["dependencies"]))
    set_state(db, *key, "WAITING_DEPENDENCIES")


def mark_stale(db, revision, profile, uid, result, keep_connections=False):
    if result:
        stale = dict(result, status="stale")
        db.execute("INSERT OR REPLACE INTO result VALUES(?,?,?,?)",
                   (revision, profile, uid, encode(stale)))
    set_state(db, revision, profile, uid,
              "WAITING_DEPENDENCIES" if keep_connections else "NEW", {"stale": True})


def ancestors(deps, changed):
    reverse = {}
    for source, targets in deps.items():
        for target in targets:
            reverse.setdefault(target, []).append(source)
    found, stack = set(changed), list(changed)
    while stack:
        for parent in reverse.get(stack.pop(), ()):
            if parent not in found:
                found.add(parent)
                stack.append(parent)
    return found


def inherit(db, revision, root, snapshot):
    """Carry forward unaffected checkpoints only. Historical results are immutable."""
    previous = db.execute(
        "SELECT id FROM snapshot WHERE root=? AND id<>? ORDER BY rowid DESC LIMIT 1",
        (root, revision)).fetchone()
    if not previous:
        return
    old_revision = previous[0]
    _, old = load_snapshot(db, old_revision)
    files, old_files = snapshot["files"], old["files"]
    changed = {name for name in files.keys() | old_files.keys()
               if files.get(name, {}).get("hash") != old_files.get(name, {}).get("hash")}
    profiles = db.execute("SELECT DISTINCT profile FROM analysis_task WHERE snapshot=?", (old_revision,)).fetchall()
    for (profile,) in profiles:
        tasks, connections, deps, results = read_state(db, old_revision, profile)
        units = snapshot["units"]
        affected = ancestors(deps, {
            uid for uid in tasks if uid not in units or
            changed.intersection({units[uid]["file"], *connections.get(uid, {}).get("reads", ()),
                                  *results.get(uid, {}).get("reads", ())}) or
            (changed and any(edge["certainty"] == "candidate" or edge["certainty"] == "unresolved"
                             for edge in connections.get(uid, {}).get("relations", ())))
        })
        for uid, state in tasks.items():
            if uid not in units or old["units"][uid]["scope"] != units[uid]["scope"]:
                continue
            result = results.get(uid)
            if uid in affected:
                mark_stale(db, revision, profile, uid, result)
                continue
            if uid in connections:
                save_connection(db, revision, profile, uid,
                                dict(connections[uid], dependencies=[
                                    target for target in deps[uid]
                                    if target not in {block["id"] for block in split_blocks(units, uid)}]),
                                connections[uid]["reads"])
            if result:
                db.execute("INSERT OR REPLACE INTO result VALUES(?,?,?,?)",
                           (revision, profile, uid, encode(result)))
            resumed = {"CONNECTING": "NEW", "SEMANTICIZING": "WAITING_DEPENDENCIES"}.get(state, state)
            if resumed == "QUALITY_VERIFIED":
                resumed = "SEMANTIC_SUBMITTED"
            set_state(db, revision, profile, uid, resumed, {"reused_snapshot": old_revision})
