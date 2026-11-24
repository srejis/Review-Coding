"""Validated analysis tools for a single unit and immutable snapshot."""
import ast
import json

from source import database, encode, load_snapshot, validate_meaning, validate_relations, split_blocks


def schema(description, required=(), **properties):
    return dict(description=description, inputSchema=dict(
        type="object", properties=properties, required=list(required), additionalProperties=False))


STRING = {"type": "string"}
INTEGER = {"type": "integer", "minimum": 1}
def array(items):
    return {"type": "array", "items": items, "maxItems": 150}


def object_type(**properties):
    return dict(type="object", properties=properties, required=list(properties), additionalProperties=False)


RELATION = object_type(
    kind={"type": "string", "enum": ["call", "reference", "data", "condition", "state", "contains"]},
    certainty={"type": "string", "enum": ["confirmed", "candidate", "external", "unresolved"]},
    target={"type": ["string", "null"], "description": "Exact unit ID or null. confirmed requires a local unit."},
    evidence=array(object_type(unit=STRING, line=INTEGER)), reason=STRING)
TOOLS = {
    "list_units": schema("List snapshot units in pages of 50.", page=INTEGER),
    "get_pending_tasks": schema("List pending units in pages of 50.", page=INTEGER),
    "read_unit": schema("Read a bounded page of original source with owned sites, scope and children.",
                        ("unit",), unit=STRING, start=INTEGER),
    "lookup_symbol": schema("Find candidate scoped definitions by exact symbol name.",
                            ("name",), name=STRING),
    "search_code": schema("Find literal text in the fixed Python snapshot.", ("query",), query=STRING),
    "get_relations": schema("Read previously submitted relations.", ("unit",), unit=STRING),
    "get_meaning": schema("Read previously submitted meaning.", ("unit",), unit=STRING),
    "submit_relations": schema(
        "Submit connections and exact confirmed local target IDs needed as prior meanings.",
        ("relations", "dependencies"), relations=array(RELATION), dependencies=array(STRING)),
    "submit_meaning": schema("Submit only the assigned unit's meaning.",
                             ("role", "steps", "unresolved"), role=STRING,
                             steps=array(object_type(text=STRING, sites=array(STRING))),
                             unresolved=array(STRING)),
    "revisit_connection": schema("Report a newly discovered local dependency. Does not submit meaning.",
                                ("target", "evidence", "reason"), target=STRING,
                                evidence=array(object_type(unit=STRING, line=INTEGER)), reason=STRING),
}

READ_TOOLS = {"list_units", "get_pending_tasks", "read_unit", "lookup_symbol", "search_code", "get_relations"}
PHASE_TOOLS = {
    "connection": READ_TOOLS | {"submit_relations"},
    "semantic": READ_TOOLS | {"get_meaning", "submit_meaning", "revisit_connection"},
}


class AnalysisTools:
    def __init__(self, path, revision, profile, uid, phase, dependencies=None, meaning_inputs=None):
        self.path, self.revision, self.profile, self.uid = path, revision, profile, uid
        with database(path) as db:
            _, self.snapshot = load_snapshot(db, revision)
        self.units = self.snapshot["units"]
        self.phase = phase
        self.dependencies = set(dependencies or ())
        self.meaning_inputs = meaning_inputs or {}
        self.read = {}
        self.meanings_read = set()
        self.staged = {}
        self.calls = 0
        self.trees = {}

    def call(self, name, args):
        self.calls += 1
        if self.calls > 48:
            raise ValueError("Tool call limit reached.")
        if name not in PHASE_TOOLS[self.phase]:
            raise ValueError("This tool is not available in the current phase.")
        definition = TOOLS[name]["inputSchema"]
        if set(args) - definition["properties"].keys() or set(definition["required"]) - args.keys():
            raise ValueError("Invalid tool arguments.")
        for key, value in args.items():
            prop = definition["properties"][key]
            kind = prop["type"]
            if kind == "string" and (not isinstance(value, str) or len(value) > 4000):
                raise ValueError("Invalid string.")
            if kind == "integer" and (type(value) is not int or not 1 <= value <= 1000000):
                raise ValueError("Invalid range.")
            if kind == "array" and (not isinstance(value, list) or len(value) > prop["maxItems"]
                                    or any(not isinstance(item, str if prop["items"] == STRING else dict)
                                           for item in value)):
                raise ValueError("Invalid array.")
        try:
            result = self.execute(name, args)
        except (KeyError, TypeError, ValueError) as exc:
            self.trace(dict(unit=self.uid, phase=self.phase, tool=name, arguments=args, error=str(exc)))
            raise
        self.trace(dict(unit=self.uid, phase=self.phase, tool=name, arguments=args, result=result))
        return result

    def trace(self, data):
        with database(self.path) as db:
            db.execute("INSERT INTO event(snapshot,profile,data) VALUES(?,?,?)",
                       (self.revision, self.profile, encode(data)))

    def execute(self, name, args):
        if name in {"list_units", "get_pending_tasks"}:
            done = set()
            if name == "get_pending_tasks":
                with database(self.path) as db:
                    done = {r[0] for r in db.execute(
                        "SELECT unit FROM result WHERE snapshot=? AND profile=? AND json_extract(data,'$.status')='submitted'",
                        (self.revision, self.profile))}
            units = [u for k, u in self.units.items() if k not in done]
            start = (args.get("page", 1) - 1) * 50
            return dict(total=len(units), units=[self.summary(u) for u in units[start:start+50]])
        if name == "read_unit":
            unit = self.units[args["unit"]]
            lines = self.snapshot["files"][unit["file"]]["source"].splitlines()
            start = args.get("start", unit["line"])
            if not 1 <= start <= max(1, len(lines)):
                raise ValueError("Source line outside this file.")
            end = min(start + 79, len(lines))
            if sum(len(line) for line in lines[start-1:end]) > 16000:
                while end > start and sum(len(line) for line in lines[start-1:end]) > 16000:
                    end -= 1
                if len(lines[start-1]) > 16000:
                    raise ValueError("Source line exceeds tool transport limit. Record it as unresolved.")
            self.read.setdefault(unit["id"], set()).update(range(start, end+1))
            parent = self.units.get(unit["parent"])
            effects = self.effects(unit, start, end) if self.phase == "semantic" else []
            return dict(unit=unit, parent=self.summary(parent) if parent else None, children=[self.summary(u) for u in self.units.values()
                                           if u["parent"] == unit["id"]][:50],
                        start=start, end=end, file_lines=len(lines),
                        lines=lines[start-1:end], effects=effects)
        if name == "lookup_symbol":
            return [self.summary(u) for u in self.units.values()
                    if u["name"] == args["name"] and u["kind"] != "block"][:50]
        if name == "search_code":
            query = args["query"]
            if not query.strip():
                raise ValueError("Empty search.")
            hits = []
            for file, info in self.snapshot["files"].items():
                for number, line in enumerate(info["source"].splitlines(), 1):
                    if query in line:
                        hits.append(dict(file=file, line=number))
                        if len(hits) == 50:
                            return hits
            return hits
        if name == "get_meaning":
            uid = self.units[args["unit"]]["id"]
            if uid not in self.meaning_inputs:
                raise ValueError("Only prepared dependency meanings are available.")
            self.meanings_read.add(uid)
            return self.meaning_inputs[uid]
        if name == "get_relations":
            uid = self.units[args["unit"]]["id"]
            with database(self.path) as db:
                row = db.execute("SELECT data FROM analysis_connection WHERE snapshot=? AND profile=? AND unit=?",
                                 (self.revision, self.profile, uid)).fetchone()
            return json.loads(row[0])["relations"] if row else None

        if self.uid not in self.read:
            raise ValueError("Read the assigned unit before submitting.")
        if name == "submit_relations":
            relations = args["relations"]
            validate_relations(self.units, relations)
            for relation in relations:
                if any(ref["line"] not in self.read.get(ref["unit"], set())
                       for ref in relation["evidence"]):
                    raise ValueError("Read the cited source before submitting evidence.")
                if relation["certainty"] == "confirmed" and (
                    relation["target"] not in self.read or not any(ref["unit"] == self.uid for ref in relation["evidence"])
                ):
                    raise ValueError("Read the target and cite evidence in the assigned unit before confirming.")
            confirmed = {edge["target"] for edge in relations if edge["certainty"] == "confirmed"}
            if not set(args["dependencies"]) <= confirmed:
                raise ValueError("Each meaning dependency must be an exact confirmed local target.")
            self.staged["relations"] = relations
            self.staged["dependencies"] = sorted(set(args["dependencies"]))
        if name == "submit_meaning":
            unit = self.units[self.uid]
            blocks = split_blocks(self.units, self.uid)
            if any(block["id"] not in self.meanings_read for block in blocks):
                raise ValueError("Read every prepared block meaning before composing its parent.")
            meaning = validate_meaning(unit, **args, units=self.units, block_meanings=self.meaning_inputs)
            owners = {site["id"]: (owner["id"], site["line"])
                      for owner in [unit, *blocks] for site in owner["sites"]}
            parent_lines = self.read[self.uid] if blocks else set()
            if any(owners[site][1] not in parent_lines and
                   owners[site][1] not in self.read.get(owners[site][0], ())
                   for step in meaning["steps"] for site in step["sites"]):
                raise ValueError("Read the cited source before submitting meaning.")
            if meaning["missing"] and not meaning["unresolved"]:
                raise ValueError("Cover every owned site or explain unresolved coverage.")
            self.staged["meaning"] = meaning
        if name == "revisit_connection":
            target = args["target"]
            if target in self.dependencies:
                raise ValueError("That dependency was already handled.")
            edge = dict(kind="reference", certainty="confirmed", target=target,
                        evidence=args["evidence"], reason=args["reason"])
            validate_relations(self.units, [edge])
            if target not in self.read or not any(ref["unit"] == self.uid for ref in edge["evidence"]) or any(
                ref["line"] not in self.read.get(ref["unit"], ()) for ref in edge["evidence"]
            ):
                raise ValueError("Read both units and cite the use in the assigned unit.")
            self.staged["revisit"] = target
        return {"accepted": True}

    def effects(self, unit, start, end):
        file = unit["file"]
        if file not in self.trees:
            self.trees[file] = ast.parse(self.snapshot["files"][file]["source"])
        sites = {(site["line"], site["col"]): site["id"] for site in unit["sites"]
                 if start <= site["line"] <= end}
        effects = []
        for node in ast.walk(self.trees[file]):
            if unit["kind"] == "block" and isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                first = node.body[0]
                if isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant) and isinstance(first.value.value, str):
                    site = sites.get((first.lineno, first.col_offset))
                    if site is not None:
                        effects.append(dict(site=site, facts=[
                            "This leading string is function documentation (__doc__), not an operation evaluated on each call."
                        ]))
            if not isinstance(node, ast.Expr) or not isinstance(node.value, ast.Call):
                continue
            site = sites.get((node.lineno, node.col_offset))
            if site is None:
                continue
            facts = ["The expression statement discards the call's result."]
            if isinstance(node.value.func, ast.Attribute):
                facts.insert(0, "Resolve the callable attribute before evaluating the arguments.")
            effects.append(dict(site=site, facts=facts))
        return effects

    @property
    def read_files(self):
        return {self.units[uid]["file"] for uid in self.read}

    @staticmethod
    def summary(unit):
        return {k: v for k, v in unit.items() if k != "sites"}
