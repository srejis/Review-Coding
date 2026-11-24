"""Read call ownership and statically identifiable class bases from frozen source."""
import ast
from collections import defaultdict
from functools import lru_cache
from pathlib import PurePosixPath


DEFINITIONS = (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)


@lru_cache(maxsize=256)
def parse(source):
    try:
        return ast.parse(source)
    except SyntaxError:
        return None


def module_name(file):
    path = PurePosixPath(file)
    return ".".join(path.parent.parts if path.name == "__init__.py" else path.with_suffix("").parts)


class FileRelations:
    def __init__(self, file, tree, units):
        self.file = file
        self.calls = defaultdict(set)
        self.classes = {}
        self.bindings = defaultdict(lambda: defaultdict(list))
        self.wildcards = set()
        self.definitions = {(u["parent"], u["line"], u["name"]): u["id"]
                            for u in units if u["kind"] not in {"module", "block"}}
        self.module = next(u["id"] for u in units if u["kind"] == "module")
        self.suites = {self.module: set(tree.body)}
        self.visit(tree, self.module)

    def visit(self, node, owner):
        if isinstance(node, ast.Call):
            for line in range(node.lineno, node.end_lineno + 1):
                self.calls[line].add(owner)
        self.record_binding(owner, node)
        if isinstance(node, DEFINITIONS):
            start = min([node.lineno, *(item.lineno for item in node.decorator_list)])
            uid = self.definitions.get((owner, start, node.name))
            if isinstance(node, ast.ClassDef) and uid is not None:
                self.classes[uid] = node
            for field, value in ast.iter_fields(node):
                if field == "body" or field == "type_params":
                    continue
                for child in value if isinstance(value, list) else [value]:
                    if isinstance(child, ast.AST):
                        self.visit(child, owner)
            if uid is not None:
                self.suites[uid] = set(node.body)
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    for argument in ast.iter_child_nodes(node.args):
                        if isinstance(argument, ast.arg):
                            self.bindings[uid][argument.arg].append(argument)
                for statement in node.body:
                    self.visit(statement, uid)
            return
        for child in ast.iter_child_nodes(node):
            self.visit(child, owner)

    def record_binding(self, owner, node):
        bindings = self.bindings[owner]
        if isinstance(node, DEFINITIONS):
            bindings[node.name].append(node)
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            for alias in node.names:
                if alias.name == "*":
                    self.wildcards.add(owner)
                else:
                    name = alias.asname or alias.name.split(".")[0]
                    bindings[name].append(node)
        elif isinstance(node, ast.Name) and isinstance(node.ctx, (ast.Store, ast.Del)):
            bindings[node.id].append(node)
        elif isinstance(node, (ast.ExceptHandler, ast.MatchAs, ast.MatchStar)) and node.name:
            bindings[node.name].append(node)
        elif isinstance(node, ast.MatchMapping) and node.rest:
            bindings[node.rest].append(node)
        elif isinstance(node, (ast.Global, ast.Nonlocal)):
            for name in node.names:
                bindings[name].append(node)

    def binding(self, owner, name):
        matches = self.bindings[owner].get(name, ())
        if owner not in self.wildcards and len(matches) == 1 and matches[0] in self.suites[owner]:
            return matches[0]
        return None


class SourceRelations:
    def __init__(self, units, files):
        self.units = units
        self.files = files
        self.by_file = defaultdict(list)
        for unit in units.values():
            self.by_file[unit["file"]].append(unit)
        self.modules = defaultdict(list)
        for file in self.by_file:
            self.modules[module_name(file)].append(file)
        self.parsed = {}

    def file(self, name):
        if name not in self.parsed:
            tree = parse(self.files[name]["source"])
            self.parsed[name] = FileRelations(name, tree, self.by_file[name]) if tree else None
        return self.parsed[name]

    def call_owner(self, uid, evidence):
        file = self.units[uid]["file"]
        facts = self.file(file)
        owners = set()
        if facts:
            for ref in evidence:
                if ref["unit"] == uid:
                    owners.update(facts.calls.get(ref["line"], ()))
        return next(iter(owners)) if len(owners) == 1 else None

    def inheritance(self, uid, target, evidence):
        unit = self.units[uid]
        facts = self.file(unit["file"])
        node = facts.classes.get(uid) if facts else None
        if node is None:
            return False
        lines = {ref["line"] for ref in evidence if ref["unit"] == uid}
        for base in node.bases:
            if not any(base.lineno <= line <= base.end_lineno for line in lines):
                continue
            if target is None or self.resolve_base(facts, uid, base) == target:
                return True
        return False

    def confirmed_bases(self, uid):
        unit = self.units[uid]
        facts = self.file(unit["file"])
        node = facts.classes.get(uid) if facts else None
        if node is None:
            return
        for base in node.bases:
            target = self.resolve_base(facts, uid, base)
            if target:
                yield dict(kind="inheritance", certainty="confirmed", target=target,
                           evidence=[dict(unit=uid, line=base.lineno),
                                     dict(unit=target, line=self.units[target]["line"])],
                           reason="Explicit base expression resolves to this local class.")

    def resolve_base(self, facts, uid, base):
        owner = self.units[uid]["parent"]
        child = facts.classes[uid]
        # Only a unique, unconditional binding in the same suite proves a relationship.
        if child not in facts.suites[owner]:
            return None
        parts = []
        while isinstance(base, ast.Attribute):
            parts.insert(0, base.attr)
            base = base.value
        if not isinstance(base, ast.Name):
            return None
        binding = facts.binding(owner, base.id)
        if binding is None or binding.lineno >= child.lineno:
            return None
        if isinstance(binding, ast.ClassDef) and not parts:
            return self.class_id(facts, owner, binding)
        return self.resolve_import(facts, base.id, parts, binding, set())

    def resolve_import(self, facts, name, parts, binding, seen):
        if isinstance(binding, ast.ImportFrom):
            package = PurePosixPath(facts.file).parent.parts
            if binding.level > len(package) + ("" in self.modules):
                return None
            prefix = package[:len(package) + 1 - binding.level] if binding.level else ()
            module = ".".join([*prefix, *([binding.module] if binding.module else [])])
            for alias in binding.names:
                if (alias.asname or alias.name) == name:
                    if parts and (len(parts) != 1 or not self.can_import_submodule(module, alias.name)):
                        return None
                    return self.imported_class([module, alias.name, *parts], seen)
        if isinstance(binding, ast.Import):
            for alias in binding.names:
                if alias.asname == name and len(parts) == 1:
                    return self.imported_class([alias.name, *parts], seen)
                prefix = alias.name.split(".")
                if not alias.asname and parts and [name, *parts[:-1]] == prefix:
                    return self.imported_class([alias.name, parts[-1]], seen)
        return None

    def can_import_submodule(self, module, name):
        files = self.modules.get(module, ())
        if not files:
            return True
        if len(files) != 1 or PurePosixPath(files[0]).name != "__init__.py":
            return False
        facts = self.file(files[0])
        return facts and facts.module not in facts.wildcards and name not in facts.bindings[facts.module]

    def imported_class(self, parts, seen):
        if len(parts) < 2:
            return None
        module = ".".join(part for part in parts[:-1] if part)
        name = parts[-1]
        key = module, name
        if key in seen:
            return None
        seen.add(key)
        files = self.modules.get(module, ())
        if len(files) == 1:
            facts = self.file(files[0])
            binding = facts.binding(facts.module, name) if facts else None
            if isinstance(binding, ast.ClassDef):
                return self.class_id(facts, facts.module, binding)
            if binding:
                return self.resolve_import(facts, name, [], binding, seen)
        return None

    @staticmethod
    def class_id(facts, owner, node):
        # A decorator or explicit metaclass can replace the bound class object.
        if node.decorator_list or any(keyword.arg in {"metaclass", None} for keyword in node.keywords):
            return None
        return facts.definitions.get((owner, node.lineno, node.name))
