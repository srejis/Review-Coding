"""Immutable Python snapshots and result validation."""
import ast
import hashlib
import io
import json
import os
from pathlib import Path
import sqlite3
import tokenize
from contextlib import contextmanager

VERSION = "1"
COMPOSITION_SCHEMA = "split-meaning-v1"
RELATION_KINDS = ("call", "reference", "data", "condition", "state", "contains", "inheritance")


class AnalysisBusy(ValueError):
    pass


@contextmanager
def analysis_lock(path, revision):
    """Exclude changes to an active snapshot across CLI and desktop processes."""
    directory = path.parent / ".analysis-locks"
    directory.mkdir(parents=True, exist_ok=True)
    with (directory / digest(revision.encode())).open("a+b") as handle:
        handle.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            raise AnalysisBusy("An analysis is active for this code version.") from exc
        yield


EXCLUDED = {".git", ".venv", "venv", "__pycache__", ".codex", ".tox", ".uv-cache",
            ".pytest_cache", ".mypy_cache", "node_modules", ".agent-venv"}


def encode(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


def digest(data):
    return hashlib.sha256(data).hexdigest()


@contextmanager
def database(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path, timeout=15)
    try:
        db.executescript("""
            CREATE TABLE IF NOT EXISTS snapshot(id TEXT PRIMARY KEY, root TEXT, data TEXT);
            CREATE TABLE IF NOT EXISTS result(snapshot TEXT, profile TEXT, unit TEXT, data TEXT,
                PRIMARY KEY(snapshot,profile,unit));
            CREATE TABLE IF NOT EXISTS event(snapshot TEXT, profile TEXT, time TEXT DEFAULT CURRENT_TIMESTAMP, data TEXT);
            CREATE TABLE IF NOT EXISTS analysis_task(snapshot TEXT, profile TEXT, unit TEXT,
                state TEXT, metadata TEXT, PRIMARY KEY(snapshot,profile,unit));
            CREATE TABLE IF NOT EXISTS analysis_connection(snapshot TEXT, profile TEXT, unit TEXT,
                data TEXT, PRIMARY KEY(snapshot,profile,unit));
            CREATE TABLE IF NOT EXISTS analysis_dependency(snapshot TEXT, profile TEXT, unit TEXT,
                target TEXT, PRIMARY KEY(snapshot,profile,unit,target));
            CREATE TABLE IF NOT EXISTS feedback(snapshot TEXT, profile TEXT, unit TEXT,
                time TEXT DEFAULT CURRENT_TIMESTAMP, data TEXT);
            CREATE TABLE IF NOT EXISTS analysis_retry(snapshot TEXT, profile TEXT, unit TEXT,
                attempt INTEGER, phase TEXT, signature TEXT, data TEXT,
                PRIMARY KEY(snapshot,profile,unit,attempt));
            CREATE TABLE IF NOT EXISTS analysis_run(snapshot TEXT, profile TEXT, state TEXT, data TEXT,
                time TEXT DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(snapshot,profile));
            CREATE TABLE IF NOT EXISTS snapshot_history(snapshot TEXT PRIMARY KEY, registered TEXT);
        """)
        with db:
            yield db
    finally:
        db.close()


def index(source, filename):
    root = ast.parse(source, filename=filename)
    units = {}

    def unit(name, kind, scope, parent, line, end):
        uid = f"{filename}:{line}:{len(units)}"
        units[uid] = dict(id=uid, file=filename, name=name, kind=kind, scope=scope,
                          parent=parent, line=line, end=end, sites=[])
        return uid

    module = unit(filename, "module", filename, None, 1, max(1, len(source.splitlines())))

    def visit(node, owner):
        if isinstance(node, ast.stmt):
            current = units[owner]
            definition = isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
            line = min([node.lineno] + [d.lineno for d in getattr(node, "decorator_list", [])])
            header_end = (min(node.body[0].lineno, node.end_lineno)
                          if definition else node.end_lineno)
            units[owner]["sites"].append(dict(
                id=f"{owner}/{len(current['sites'])}", line=line, end=header_end,
                col=node.col_offset, kind=type(node).__name__))
            if definition:
                kind = ("class" if isinstance(node, ast.ClassDef) else
                        "method" if current["kind"] == "class" else "function")
                child = unit(node.name, kind, f"{current['scope']}.{node.name}",
                             owner, line, node.end_lineno)
                for statement in node.body:
                    visit(statement, child)
                return
        for child in ast.iter_child_nodes(node):
            visit(child, owner)


    def add_chunk(parent, current, sites):
        child = unit(current["name"], "block", current["scope"], parent,
                     sites[0]["line"], max(site["end"] for site in sites))
        units[child]["sites"] = sites
        units[child]["partition_parent"] = parent
    visit(root, module)
    for uid, current in list(units.items()):
        sites = current["sites"]
        if len(sites) > 32 or current["end"] - current["line"] > 300:
            chunk = []
            for site in sites:
                if chunk and (len(chunk) == 32 or site["line"] - chunk[0]["line"] > 150):
                    add_chunk(uid, current, chunk)
                    chunk = []
                chunk.append(site)
            if chunk:
                add_chunk(uid, current, chunk)
            current["sites"] = []
    describe_partitions(units)
    return units




def snapshot(root, data_dir):
    root = root.resolve(strict=True)
    data_dir = data_dir.resolve()
    if not root.is_dir() or data_dir.is_relative_to(root):
        raise ValueError("Choose a source directory outside the product data directory's ancestors.")
    files, units, issues, omitted = {}, {}, {}, {}
    def linked(path):
        return path.is_symlink() or path.is_junction() or not path.resolve().is_relative_to(root)

    def scan_error(error):
        issues[str(error.filename)] = str(error)

    for base, dirs, names in os.walk(root, onerror=scan_error):
        base = Path(base)
        for name in sorted(dirs):
            path = base / name
            if name.casefold() in EXCLUDED or linked(path):
                dirs.remove(name)
                omitted[path.relative_to(root).as_posix()] = "excluded directory or link"
        dirs.sort()
        for name in sorted(names):
            path = base / name
            rel = path.relative_to(root).as_posix()
            lower = name.casefold()
            if lower.startswith((".env", ".")) or any(
                word in lower for word in ("secret", "credential", "private_key", "api_key")
            ) or lower in {"auth.json", "id_rsa", "id_ed25519"} or path.suffix.lower() in {
                ".pem", ".key", ".p12", ".pfx", ".kdbx"
            }:
                omitted[rel] = "sensitive filename"
                continue
            if path.suffix != ".py":
                continue
            if linked(path):
                omitted[rel] = "link or outside root"
                continue
            try:
                raw = path.read_bytes()
                encoding, _ = tokenize.detect_encoding(io.BytesIO(raw).readline)
                source = raw.decode(encoding)
                files[rel] = dict(hash=digest(raw), source=source)
                units.update(index(source, rel))
            except (OSError, ValueError, SyntaxError, UnicodeError) as exc:
                issues[rel] = str(exc)
    manifest = [str(root), VERSION, {k: v["hash"] for k, v in files.items()}, issues, omitted]
    return digest(encode(manifest).encode()), dict(files=files, units=units, issues=issues,
                                                  excluded=omitted)


def split_blocks(units, uid):
    """Only structural blocks belong to a composition, never nested definitions."""
    owner = units[uid]
    if "blocks" in owner:
        return [units[child] for child in owner["blocks"]]
    return sorted((unit for unit in units.values()
                   if unit.get("kind") == "block" and unit.get("parent") == uid),
                  key=lambda block: (block["line"], int(block["sites"][0]["id"].rsplit("/", 1)[1])))


def describe_partitions(units):
    # Derive the same metadata for snapshots written before the composition fix.
    for unit in units.values():
        unit["blocks"] = []
    for block in units.values():
        if block["kind"] == "block":
            units[block["parent"]]["blocks"].append(block["id"])
    for uid, unit in units.items():
        unit["blocks"].sort(key=lambda child: (
            units[child]["line"], int(units[child]["sites"][0]["id"].rsplit("/", 1)[1])))
        for order, child in enumerate(unit["blocks"]):
            units[child]["partition_parent"] = uid
            units[child]["partition_order"] = order


def composition_refs(result):
    return result.get("meaning", {}).get("composition", {}).get("blocks", [])


def composition_current(unit, units, results):
    blocks = split_blocks(units, unit["id"])
    result = results.get(unit["id"], {})
    if not blocks or result.get("status") not in {"submitted", "partial"}:
        return True
    composition = result.get("meaning", {}).get("composition", {})
    refs = composition.get("blocks", [])
    if composition.get("schema") != COMPOSITION_SCHEMA or [ref.get("unit") for ref in refs] != [
            block["id"] for block in blocks]:
        return False
    for ref in refs:
        child = results.get(ref["unit"], {})
        if child.get("status") not in {"submitted", "partial"} or child.get("version") != ref.get("version"):
            return False
        meaning = child.get("meaning", {})
        if result["status"] == "submitted" and (
                child["status"] != "submitted" or meaning.get("missing") or meaning.get("unresolved")):
            return False
    return True


def load_snapshot(db, revision):
    row = db.execute("SELECT root, data FROM snapshot WHERE id=?", (revision,)).fetchone()
    if row is None:
        raise ValueError("Unknown snapshot.")
    data = json.loads(row[1])
    describe_partitions(data["units"])
    return row[0], data


def validate_meaning(unit, role, steps, unresolved, *, units=None, block_meanings=None):
    if not role.strip() or len(role.splitlines()) != 1:
        raise ValueError("A one-line role is required.")
    if unit.get("blocks") and units is None:
        raise ValueError("Split parents require their block ownership context.")
    blocks = split_blocks(units, unit["id"]) if units else []
    references = []
    sites = {site["id"] for site in unit["sites"]}
    if blocks:
        for block in blocks:
            saved = (block_meanings or {}).get(block["id"], {})
            if saved.get("status") not in {"submitted", "partial"} or not saved.get("version"):
                raise ValueError("Prepare every owned block meaning before composing its parent.")
            references.append(dict(unit=block["id"], version=saved["version"],
                                   status=saved["status"],
                                   sites=[site["id"] for site in block["sites"]],
                                   source=[dict(id=site["id"], line=site["line"], end=site["end"])
                                           for site in block["sites"]]))
            sites.update(site["id"] for site in block["sites"])
        if not steps and not unresolved:
            raise ValueError("A split parent needs a substantive composition or an unresolved reason.")
    covered = set()
    for step in steps:
        if set(step) != {"text", "sites"} or not isinstance(step["text"], str) or not step["text"].strip():
            raise ValueError("Each detail needs text and source site IDs.")
        refs = step["sites"]
        if not isinstance(refs, list) or not refs:
            raise ValueError("Details must cite owned source sites.")
        invalid = [ref for ref in refs if not isinstance(ref, str) or ref not in sites]
        if invalid:
            raise ValueError(f"Details must cite owned source sites for {unit['id']}; invalid IDs: {encode(invalid)}")
        covered.update(refs)
    if any(not item.strip() for item in unresolved):
        raise ValueError("Give a reason for each unresolved item.")
    meaning = dict(role=role, steps=steps, unresolved=unresolved, missing=sorted(sites-covered),
                   review="unreviewed")
    if blocks:
        meaning["composition"] = dict(schema=COMPOSITION_SCHEMA, blocks=references)
    return meaning


def validate_relations(units, relations):
    for edge in relations:
        if set(edge) != {"kind", "certainty", "target", "evidence", "reason"}:
            raise ValueError("Use kind, certainty, target, evidence and reason for each relation.")
        if edge["kind"] not in RELATION_KINDS:
            raise ValueError("Unknown relation kind.")
        certainty = edge["certainty"]
        if certainty not in {"confirmed", "candidate", "external", "unresolved"}:
            raise ValueError("Unknown certainty.")
        target = edge["target"]
        if target is not None and (not isinstance(target, str) or target not in units):
            raise ValueError("Target must be a unit in this snapshot.")
        if certainty == "confirmed" and not target:
            raise ValueError("Confirmed relations require a local target.")
        if edge["kind"] == "inheritance" and target and units[target]["kind"] != "class":
            raise ValueError("An inheritance target must be a class.")
        if not isinstance(edge["reason"], str) or not edge["reason"].strip():
            raise ValueError("A relation requires a reason.")
        if not isinstance(edge["evidence"], list) or not edge["evidence"]:
            raise ValueError("A relation requires evidence.")
        for ref in edge["evidence"]:
            if not isinstance(ref, dict) or set(ref) != {"unit", "line"}:
                raise ValueError("Each evidence entry needs a unit ID and line.")
            unit = units.get(ref["unit"]) if isinstance(ref["unit"], str) else None
            if unit is None or type(ref["line"]) is not int or not unit["line"] <= ref["line"] <= unit["end"]:
                raise ValueError("Invalid evidence location.")
