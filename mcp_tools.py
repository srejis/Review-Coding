"""Validated analysis tools for a single unit and immutable snapshot."""
import json

from source import database, encode, load_snapshot, validate_meaning, validate_relations


def schema(description, required=(), **properties):
    return dict(description=description, inputSchema=dict(
        type="object", properties=properties, required=list(required), additionalProperties=False))


STRING = {"type": "string"}
INTEGER = {"type": "integer", "minimum": 1}
OBJECTS = {"type": "array", "items": {"type": "object"}, "maxItems": 150}
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
        "Submit edges: kind(call/reference/data/condition/state/contains), certainty"
        "(confirmed/candidate/external/unresolved), target (unit ID or null), "
        "evidence ([{unit,line}]), reason. Include [] if none.",
        ("relations",), relations=OBJECTS),
    "submit_meaning": schema("Submit role, ordered steps [{text,sites:[id]}], and unresolved reasons.",
                             ("role", "steps", "unresolved"), role=STRING, steps=OBJECTS,
                             unresolved={"type": "array", "items": STRING, "maxItems": 150}),
}


class AnalysisTools:
    def __init__(self, path, revision, profile, uid):
        self.path, self.revision, self.profile, self.uid = path, revision, profile, uid
        with database(path) as db:
            _, self.snapshot = load_snapshot(db, revision)
        self.units = self.snapshot["units"]
        self.read = {}
        self.staged = {}
        self.calls = 0

    def call(self, name, args):
        self.calls += 1
        if self.calls > 48:
            raise ValueError("Tool call limit reached.")
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
            self.trace(dict(tool=name, arguments=args, error=str(exc)))
            raise
        self.trace(dict(tool=name, arguments=args, result=result))
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
            return dict(unit=unit, parent=self.summary(parent) if parent else None, children=[self.summary(u) for u in self.units.values()
                                           if u["parent"] == unit["id"]][:50],
                        start=start, end=end, file_lines=len(lines),
                        lines=lines[start-1:end])
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
        if name in {"get_relations", "get_meaning"}:
            uid = self.units[args["unit"]]["id"]
            with database(self.path) as db:
                row = db.execute("SELECT data FROM result WHERE snapshot=? AND profile=? AND unit=?",
                                 (self.revision, self.profile, uid)).fetchone()
            return json.loads(row[0]).get(name[4:]) if row else None

        if self.uid not in self.read:
            raise ValueError("Read the assigned unit before submitting.")
        if name == "submit_relations":
            relations = args["relations"]
            validate_relations(self.units, relations)
            for relation in relations:
                if any(ref["line"] not in self.read.get(ref["unit"], set())
                       for ref in relation["evidence"]):
                    raise ValueError("Read the cited source before submitting evidence.")
                if relation["certainty"] == "confirmed" and relation["target"] not in self.read:
                    raise ValueError("Read the target before confirming the relationship.")
            self.staged["relations"] = relations
        if name == "submit_meaning":
            unit = self.units[self.uid]
            meaning = validate_meaning(unit, **args)
            site_lines = {s["id"]: s["line"] for s in unit["sites"]}
            if any(site_lines[site] not in self.read[self.uid]
                   for step in meaning["steps"] for site in step["sites"]):
                raise ValueError("Read the cited source before submitting meaning.")
            if meaning["missing"] and not meaning["unresolved"]:
                raise ValueError("Cover every owned site or explain unresolved coverage.")
            self.staged["meaning"] = meaning
        if {"relations", "meaning"} <= self.staged.keys():
            self.staged["status"] = ("partial" if self.staged["meaning"]["missing"] else "submitted")
            with database(self.path) as db:
                db.execute("INSERT OR REPLACE INTO result VALUES(?,?,?,?)",
                           (self.revision, self.profile, self.uid, encode(self.staged)))
        return {"accepted": True, "saved": "status" in self.staged}

    @staticmethod
    def summary(unit):
        return {k: v for k, v in unit.items() if k != "sites"}
