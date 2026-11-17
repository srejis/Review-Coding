"""Local desktop review interface."""
import json
from pathlib import Path
import subprocess
import sys
import tkinter as tk
from tkinter import filedialog, messagebox, simpledialog, ttk

from main import export, register
from source import database, encode, load_snapshot


def review(data, db_path):
    app = tk.Tk()
    app.title("Python 코드 검수")
    app.geometry("1280x820")
    selection = tk.StringVar()
    profile_value = tk.StringVar()
    status = tk.StringVar(value="프로젝트를 선택하세요.")
    model = tk.StringVar()
    effort = tk.StringVar()
    revisions, profiles, unit_ids = {}, {}, []
    active = None
    stop_file = data / "ui-cancel"

    header = ttk.Frame(app, padding=9)
    header.pack(fill="x")
    projects = ttk.Combobox(header, state="readonly", textvariable=selection, width=41)
    projects.pack(side="left", padx=3)
    profile_select = ttk.Combobox(header, state="readonly", textvariable=profile_value, width=28)
    profile_select.pack(side="left", padx=3)

    controls = ttk.Frame(app, padding=(9, 0, 9, 8))
    controls.pack(fill="x")
    ttk.Label(controls, text="모델").pack(side="left")
    model_box = ttk.Combobox(controls, textvariable=model, width=21, state="readonly")
    model_box.pack(side="left", padx=3)
    ttk.Label(controls, text="추론").pack(side="left")
    effort_box = ttk.Combobox(controls, textvariable=effort, width=12, state="readonly")
    effort_box.pack(side="left", padx=3)
    ttk.Label(controls, textvariable=status).pack(side="left", padx=9)

    panes = ttk.Panedwindow(app, orient="horizontal")
    panes.pack(fill="both", expand=True, padx=9, pady=(0, 9))
    left = ttk.Frame(panes)
    right = ttk.Frame(panes)
    middle = ttk.Frame(panes)
    panes.add(left, weight=1)
    panes.add(middle, weight=4)
    panes.add(right, weight=4)
    ttk.Label(left, text="분석 단위").pack(anchor="w")
    units = tk.Listbox(left, exportselection=False, width=32)
    units.pack(fill="both", expand=True)

    def text(parent, title, wrap="word"):
        ttk.Label(parent, text=title).pack(anchor="w")
        view = tk.Text(parent, wrap=wrap, font=("Consolas", 10), state="disabled", height=10)
        bar = ttk.Scrollbar(parent, orient="vertical", command=view.yview)
        bar.pack(side="right", fill="y")
        view.configure(yscrollcommand=bar.set)
        view.pack(fill="both", expand=True)
        return view

    original = text(middle, "원본", "none")
    original.tag_configure("source", background="#fce5a5", foreground="#171717")
    tabs = ttk.Notebook(right)
    tabs.pack(fill="both", expand=True)
    panels = [ttk.Frame(tabs, padding=6) for _ in range(3)]
    for frame, title in zip(panels, ("설명·관계", "실행 기록", "피드백·범위")):
        tabs.add(frame, text=title)
    detail, trace, feedback = [text(panel, title) for panel, title in
                               zip(panels, ("상세 처리", "도구 호출 및 결과", "검수 기록"))]
    catalog = {}

    def current():
        return revisions.get(selection.get())

    def profile():
        return profiles.get(profile_value.get(), "")

    def put(view, content):
        view["state"] = "normal"
        view.delete("1.0", "end")
        view.insert("end", content)
        view["state"] = "disabled"

    def add_project():
        folder = filedialog.askdirectory()
        if not folder:
            return
        try:
            revision, _ = register(db_path, Path(folder))
            reload_projects(revision)
        except Exception as exc:
            messagebox.showerror("프로젝트 등록", str(exc))

    def reload_projects(preferred=None):
        preferred = preferred or current()
        with database(db_path) as db:
            rows = db.execute("SELECT id,root FROM snapshot ORDER BY rowid DESC").fetchall()
        revisions.clear()
        revisions.update({f"{Path(root).name} · {rev[:12]}": rev for rev, root in rows})
        projects["values"] = list(revisions)
        if revisions:
            selection.set(next((k for k, val in revisions.items() if val == preferred), next(iter(revisions))))
        reload_units()

    def reload_units(_event=None):
        if not current():
            return
        old = selected_unit()
        old_profile = profile_value.get()
        with database(db_path) as db:
            _, snap = load_snapshot(db, current())
            choices = db.execute("SELECT DISTINCT profile FROM event WHERE snapshot=? ORDER BY profile",
                                 (current(),)).fetchall()
            profiles.clear()
            for (key,) in choices:
                p = json.loads(key)
                profiles[f"{p['model']} / {p['effort']} · {p['prompt_hash'][:7]}"] = key
            profile_select["values"] = list(profiles)
            profile_value.set(old_profile if old_profile in profiles else next(iter(profiles), ""))
            states = {uid: json.loads(raw)["status"] for uid, raw in db.execute(
                "SELECT unit,data FROM result WHERE snapshot=? AND profile=?", (current(), profile()))}
        units.delete(0, "end")
        unit_ids[:] = list(snap["units"])
        for uid in unit_ids:
            u = snap["units"][uid]
            icon = {"submitted": "✓", "partial": "◐"}.get(states.get(uid), "○")
            units.insert("end", f"{icon} {u['kind']} · {u['name']}:{u['line']}")
        if unit_ids:
            units.selection_set(unit_ids.index(old) if old in unit_ids else 0)
        status.set(f"제출 {sum(v == 'submitted' for v in states.values())}/{len(unit_ids)}  ·  읽기·파싱 오류 {len(snap['issues'])}")
        load_detail()

    def selected_unit():
        chosen = units.curselection()
        return unit_ids[chosen[0]] if chosen else None

    def jump(line):
        original.tag_remove("source", "1.0", "end")
        original.tag_add("source", f"{line}.0", f"{line+1}.0")
        original.see(f"{line}.0")

    def navigate(uid):
        if uid in unit_ids:
            units.selection_clear(0, "end")
            index = unit_ids.index(uid)
            units.selection_set(index)
            units.see(index)
            load_detail()

    def load_detail(_event=None):
        if not current():
            return
        uid = selected_unit()
        with database(db_path) as db:
            root, snap = load_snapshot(db, current())
            result = db.execute("SELECT data FROM result WHERE snapshot=? AND profile=? AND unit=?",
                                (current(), profile(), uid)).fetchone()
            events = db.execute("SELECT time,data FROM event WHERE snapshot=? AND profile=? ORDER BY rowid DESC LIMIT 100",
                                (current(), profile())).fetchall()
            notes = db.execute("SELECT time,data FROM feedback WHERE snapshot=? AND profile=? AND unit=? ORDER BY rowid DESC",
                               (current(), profile(), uid)).fetchall()
        put(trace, "\n\n".join(f"{time}\n{json.dumps(json.loads(raw), ensure_ascii=False, indent=2)}"
                               for time, raw in reversed(events)))
        put(feedback, "\n".join(f"{time} · {json.loads(raw)['category']}: {json.loads(raw)['note']}"
                                for time, raw in notes) + f"\n\n{root}\n{current()}\n" +
            json.dumps(dict(issues=snap["issues"], excluded=snap["excluded"]), ensure_ascii=False, indent=2))
        if not uid:
            put(original, "")
            put(detail, "")
            return
        unit = snap["units"][uid]
        source = snap["files"][unit["file"]]["source"]
        put(original, "\n".join(f"{i:>5}  {line}" for i, line in enumerate(source.splitlines(), 1)))
        jump(unit["line"])
        put(detail, f"{unit['scope']}\n{unit['file']} · {unit['line']}–{unit['end']}\n\n")
        detail["state"] = "normal"

        def link(label, action):
            tag = f"link{detail.index('end-1c')}"
            detail.tag_configure(tag, foreground="#1d62a3", underline=True)
            detail.tag_bind(tag, "<Button-1>", lambda _e: action())
            detail.insert("end", label, (tag,))
            detail.insert("end", " ")

        if result:
            saved = json.loads(result[0])
            meaning = saved["meaning"]
            detail.insert("end", f"{meaning['role']}\n\n상세 처리 · 의미 정확도 미검수\n")
            sites = {site["id"]: site["line"] for site in unit["sites"]}
            for i, step in enumerate(meaning["steps"], 1):
                detail.insert("end", f"{i}. {step['text']}\n")
                for line in sorted({sites[ref] for ref in step["sites"]}):
                    link(f"{line}행", lambda line=line: jump(line))
                detail.insert("end", "\n")
            detail.insert("end", f"\n구문 대응 {len(sites)-len(meaning['missing'])}/{len(sites)}\n")
            for note in meaning["unresolved"]:
                detail.insert("end", f"미해결 · {note}\n")
            detail.insert("end", "\n인접 관계\n")
            labels = dict(confirmed="확정 제출", candidate="후보", external="외부 경계", unresolved="미해결")
            for edge in saved["relations"]:
                detail.insert("end", f"\n{labels[edge['certainty']]} · {edge['kind']} · {edge['reason']}\n")
                if edge["target"]:
                    target = edge["target"]
                    link(snap["units"][target]["scope"], lambda target=target: navigate(target))
                for ref in edge["evidence"]:
                    def show(ref=ref):
                        if ref["unit"] != uid:
                            navigate(ref["unit"])
                        jump(ref["line"])
                    link(f"{snap['units'][ref['unit']]['file']}:{ref['line']}", show)
        else:
            detail.insert("end", "분석 대기")
        children = [u for u in snap["units"].values() if u["parent"] == uid]
        if children:
            detail.insert("end", "\n\n하위 단위\n")
            for child in children:
                link(f"{child['name']} · {child['line']}행", lambda uid=child["id"]: navigate(uid))
        detail["state"] = "disabled"

    def save_feedback():
        uid = selected_unit()
        if not uid or not profile():
            return
        category = simpledialog.askstring("피드백", "유형 (설명 누락 / 잘못된 연결 / 너무 추상적 / 근거 없는 의미)")
        if not category:
            return
        note = simpledialog.askstring("피드백", "문제와 원본 위치를 적으세요.")
        if note:
            with database(db_path) as db:
                db.execute("INSERT INTO feedback(snapshot,profile,unit,data) VALUES(?,?,?,?)",
                           (current(), profile(), uid, encode(dict(category=category, note=note))))
            load_detail()
            tabs.select(panels[2])

    def save_export():
        if current():
            target = filedialog.asksaveasfilename(defaultextension=".json", filetypes=[("JSON", "*.json")])
            if target:
                path = Path(target).resolve()
                with database(db_path) as db:
                    root, _ = load_snapshot(db, current())
                if path.is_relative_to(Path(root)):
                    messagebox.showerror("내보내기", "분석 대상 밖에 저장하세요.")
                    return
                path.write_text(json.dumps(export(db_path, current()), ensure_ascii=False, indent=2), encoding="utf-8")

    def select_efforts(_event=None):
        item = catalog.get(model.get(), {})
        effort_box["values"] = item.get("efforts", [])
        effort.set(item.get("effort", ""))

    def run_command(command, *args):
        nonlocal active
        if active:
            return
        stop_file.unlink(missing_ok=True)
        status.set({"analyze": "분석 중", "login": "브라우저 로그인 대기", "status": "인증·모델 조회 중"}[command])
        data.mkdir(parents=True, exist_ok=True)
        logfile = data / "ui-command.log"
        with logfile.open("w", encoding="utf-8") as log:
            active = subprocess.Popen([sys.executable, "-B", str(Path(__file__).with_name("main.py")),
                                       "--data", str(data), command, *args],
                                      stdout=log, stderr=log, stdin=subprocess.DEVNULL,
                                      creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        def poll():
            nonlocal active
            if active.poll() is None:
                if command == "analyze":
                    reload_units()
                    status.set("분석 중 · " + status.get())
                app.after(1300, poll)
                return
            ok = active.returncode == 0
            active = None
            output = logfile.read_text(encoding="utf-8", errors="replace")
            if command == "status" and ok:
                info = json.loads(output)
                catalog.clear()
                catalog.update({m["id"]: m for m in info["models"]})
                model_box["values"] = list(catalog)
                model.set(next((m["id"] for m in catalog.values() if m["default"]), next(iter(catalog), "")))
                select_efforts()
                status.set("ChatGPT 구독 연결됨" if info["auth"] == "chatgpt" else f"인증 · {info['auth']}")
            elif command == "login" and ok:
                run_command("status")
            else:
                reload_units()
                if not ok:
                    messagebox.showerror("실행 결과", output[-4500:])
        app.after(900, poll)

    def analyze_selected():
        if current():
            args = [current(), "--cancel-file", str(stop_file)]
            if model.get():
                args += ["--model", model.get(), "--effort", effort.get()]
            run_command("analyze", *args)

    def stop():
        if active:
            stop_file.touch()
            status.set("중단 요청 · 저장된 단위 보존")

    def close():
        if active:
            stop()
            if not messagebox.askyesno("닫기", "실행 중입니다. 중단을 요청하고 화면을 닫을까요?"):
                return
        app.destroy()

    for label, callback in (("프로젝트 등록", add_project), ("로그인", lambda: run_command("login")),
                            ("인증·모델", lambda: run_command("status")),
                            ("분석·재개", analyze_selected), ("중단", stop),
                            ("피드백", save_feedback), ("JSON 내보내기", save_export)):
        ttk.Button(header, text=label, command=callback).pack(side="left", padx=2)
    projects.bind("<<ComboboxSelected>>", reload_units)
    profile_select.bind("<<ComboboxSelected>>", reload_units)
    units.bind("<<ListboxSelect>>", load_detail)
    model_box.bind("<<ComboboxSelected>>", select_efforts)
    app.protocol("WM_DELETE_WINDOW", close)
    reload_projects()
    app.mainloop()
