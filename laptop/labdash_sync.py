"""LabDash laptop sync.

Downloads your encrypted LabDash from its private GitHub repository, decrypts it on this laptop and writes:
  * OneDrive/LabDash/LabDash-data.xlsx   (projects, tasks, log, samples, one sheet per protocol)
  * photos into each project's OneDrive folder, named by sample ID and date

Your passphrase and GitHub token are kept in Windows Credential Manager (via the keyring package),
never in a file. Run once with "setup", then a scheduled task runs "run" every 15 minutes.

    python labdash_sync.py setup     # asks for repo, token, passphrase, OneDrive folder; adds the scheduled task
    python labdash_sync.py run       # one sync (what the scheduled task does)
    python labdash_sync.py remove    # removes the scheduled task and stored secrets
"""
import base64, datetime as dt, getpass, json, os, re, subprocess, sys, tempfile, time, urllib.request, urllib.error
from pathlib import Path

APP = "LabDash"
STATE_DIR = Path(os.environ.get("LOCALAPPDATA", Path.home() / ".local" / "share")) / "LabDash"
STATE = STATE_DIR / "state.json"
LOG = STATE_DIR / "sync.log"


def log(msg):
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    line = dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S ") + msg
    print(line)
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(line + "\n")
    try:  # keep the log small
        if LOG.stat().st_size > 400_000:
            LOG.write_text("\n".join(LOG.read_text(encoding="utf-8").splitlines()[-1500:]) + "\n", encoding="utf-8")
    except OSError:
        pass


def load_state():
    try:
        return json.loads(STATE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def save_state(s):
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    STATE.write_text(json.dumps(s, indent=1), encoding="utf-8")


# ---------- secrets ----------
def secret(name):
    import keyring
    return keyring.get_password(APP, name)


def set_secret(name, value):
    import keyring
    keyring.set_password(APP, name, value)


# ---------- GitHub ----------
class Source:
    def __init__(self, repo, token, local_dir=None):
        self.repo, self.token, self.local = repo, token, Path(local_dir) if local_dir else None

    def get(self, path):
        """Return the file's bytes, or None if it doesn't exist."""
        if self.local:
            p = self.local / path
            return p.read_bytes() if p.exists() else None
        req = urllib.request.Request(
            f"https://api.github.com/repos/{self.repo}/contents/{path}",
            headers={"Authorization": "Bearer " + self.token, "Accept": "application/vnd.github.raw+json",
                     "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "LabDash-laptop-sync"})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            if e.code == 401:
                raise SystemExit("GitHub rejected the token. It may have expired: run setup again with a new one.")
            raise

    def repo_info(self):
        if self.local:
            return {"private": True}
        req = urllib.request.Request(f"https://api.github.com/repos/{self.repo}",
                                     headers={"Authorization": "Bearer " + self.token, "Accept": "application/vnd.github+json",
                                              "User-Agent": "LabDash-laptop-sync"})
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read())


# ---------- crypto (matches the app: PBKDF2-SHA256 -> AES-GCM-256 key wrap, AES-GCM data) ----------
def unlock(vault, passphrase):
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.exceptions import InvalidTag
    p = vault["keys"]["pass"]
    kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=base64.b64decode(p["salt"]), iterations=int(p["iter"]))
    wk = kdf.derive(passphrase.encode("utf-8"))
    try:
        raw = AESGCM(wk).decrypt(base64.b64decode(p["iv"]), base64.b64decode(p["ct"]), None)
    except InvalidTag:
        raise SystemExit("The stored passphrase doesn't open this LabDash. Run setup again.")
    key = AESGCM(raw)
    docs = json.loads(key.decrypt(base64.b64decode(vault["iv"]), base64.b64decode(vault["ct"]), None))
    return key, docs


def decrypt_image(key, rec):
    return key.decrypt(base64.b64decode(rec["iv"]), base64.b64decode(rec["ct"]), None)


# ---------- output ----------
def when(ms):
    return dt.datetime.fromtimestamp(ms / 1000) if isinstance(ms, (int, float)) and ms else None


def made_day(ms):
    w = when(ms)
    return w.date() if w else None


def day(iso):
    try:
        return dt.date.fromisoformat(iso) if iso else None
    except ValueError:
        return None


def safe(name):
    return re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", str(name)).strip(" .") or "item"


def project_dir(onedrive_root, p):
    folder = (p or {}).get("folder") or ""
    if folder.strip("/ "):
        parts = [safe(x) for x in folder.replace("\\", "/").split("/") if x.strip()]
        return onedrive_root.joinpath(*parts)
    return onedrive_root / "LabDash" / safe((p or {}).get("name") or "No project")


def derived(fields, values):
    def by(label):
        for f in fields:
            if f["label"].strip().lower() == label:
                try:
                    return float(str(values.get(f["key"], "")).replace(",", "."))
                except ValueError:
                    return None
        return None
    import math
    m, d, h, F = by("mass"), by("diameter"), by("height"), by("breaking force")
    dens = round(m / (math.pi * (d / 20) ** 2 * (h / 10)), 3) if m and d and h else None
    stren = round(1000 * F / (math.pi * (d / 2) ** 2), 1) if F and d else None
    return dens, stren


def comp_field(fields):
    """The compaction force field (in N), if the protocol has one."""
    import re
    for f in fields:
        if re.search(r"compaction|pelleti|press", f.get("label", ""), re.I) and str(f.get("unit", "")).strip() == "N":
            return f
    return None


def pressure(fields, values):
    """Compaction pressure in MPa: force (N) over the pellet face (mm²)."""
    import math
    cf = comp_field(fields)
    df = next((f for f in fields if f["label"].strip().lower() == "diameter"), None)
    try:
        F = float(str(values.get(cf["key"], "")).replace(",", ".")) if cf else None
        d = float(str(values.get(df["key"], "")).replace(",", ".")) if df else None
    except ValueError:
        return None
    return round(F / (math.pi * (d / 2) ** 2), 2) if F and d else None


def removed_text(s):
    """Why a sample (or a batch's unlogged spots) left the box, for the Removed column."""
    parts = []
    r = s.get("removed")
    if r:
        parts.append(" · ".join(x for x in [r.get("reason", ""), made_day(r.get("at")).strftime("%d/%m/%Y") if r.get("at") else "", ("was in " + r["from"]) if r.get("from") else ""] if x))
    for slot, g in sorted((s.get("gone") or {}).items()):
        parts.append(slot.split(" · ")[-1] + " " + (g.get("reason") or "emptied"))
    return "; ".join(parts)


def clean_cell(x):
    """Excel can't hold some invisible control characters or nested values; tidy them instead of failing."""
    from openpyxl.cell.cell import ILLEGAL_CHARACTERS_RE
    if isinstance(x, str):
        return ILLEGAL_CHARACTERS_RE.sub("", x)
    if isinstance(x, (list, tuple, dict, set)):
        return ILLEGAL_CHARACTERS_RE.sub("", json.dumps(x, ensure_ascii=False))
    return x


def programme_sheets(docs, samples, protos, sheet):
    """Pellet programme: one row per pellet with its condition, and a summary per condition.
    Mixtures made from the schedule carry 'prog' (condition ID) and 'progDef' (the recipe)."""
    import math
    import statistics as stx
    mixes = [s for s in samples if s.get("prog")]
    if not mixes:
        return
    by_id = {m["sampleId"]: m for m in mixes}

    def fnum(v):
        try:
            return float(str(v).replace(",", "."))
        except (TypeError, ValueError):
            return None
    rows, per = [], {}
    for p in samples:
        pr = protos.get(p.get("protocolId")) or {}
        bf = next((f for f in pr.get("fields", []) if f.get("type") == "Batch"), None)
        mix = by_id.get((p.get("values") or {}).get(bf["key"])) if bf else None
        if not mix:
            continue
        fields = pr.get("fields", [])
        lab = {f["label"].strip().lower(): f["key"] for f in fields}
        v = p.get("values") or {}
        g = lambda name: fnum(v.get(lab.get(name, ""), None))
        cf = comp_field(fields)
        d = mix.get("progDef") or {}
        green, mass, dia, hgt, res, brk = g("green mass"), g("mass"), g("diameter"), g("height"), g("resistance"), g("breaking force")
        dens, stren = derived(fields, v)
        loss = round(100 * (green - mass) / green, 2) if green and mass else None
        rho = round(res * math.pi * dia ** 2 / (40 * hgt), 4) if res and dia and hgt else None
        rem = (p.get("removed") or {}).get("reason", "")
        rows.append([p["sampleId"], mix["prog"], d.get("stage"), mix["sampleId"], d.get("size"), d.get("C"), d.get("G"),
                     (d.get("C") or 0) - (d.get("G") or 0) if d.get("C") is not None else None, fnum(v.get(cf["key"])) if cf else None, d.get("dry"),
                     made_day(p.get("created")), green, mass, dia, hgt, res, brk, v.get(lab.get("failure mode", ""), ""), loss, dens, rho, stren,
                     rem, p.get("notes", "")])
        c = per.setdefault(mix["prog"], {"stage": d.get("stage"), "mixes": set(), "made": 0, "broken": 0, "str": [], "R": []})
        c["mixes"].add(mix["sampleId"])
        c["made"] += 1
        if rem and not brk and rem.lower() not in ("used up", "spare, not needed", "lost"):
            c["broken"] += 1
        if stren:
            c["str"].append(stren)
        if res:
            c["R"].append(res)
    for m in mixes:  # pellets counted as deformed on demoulding, before they were logged
        c = per.get(m["prog"])
        if c and m.get("deformed"):
            c["made"] += m["deformed"]
            c["broken"] += m["deformed"]
    rows.sort(key=lambda r: (r[1], r[0]))
    sheet("Programme", ["Pellet", "Condition", "Stage", "Mixture", "Fly ash size", "Total carbon (%)", "Graphite (%)", "Coke (%)", "Force (N)", "Drying",
                        "Pressed", "Green mass (g)", "Dry mass (g)", "Dry D (mm)", "Dry H (mm)", "Resistance (Ω)", "Breaking force (N)", "Failure mode",
                        "Mass loss on drying (%)", "Dry density (g/cm³)", "Resistivity (Ω·cm)", "Axial strength (kPa)", "Removed", "Notes"], rows)
    sd = lambda a: round(stx.stdev(a), 3) if len(a) > 1 else None
    mn = lambda a: round(stx.mean(a), 3) if a else None
    srows = []
    for cid in sorted(per):
        c = per[cid]
        rm, rs = mn(c["R"]), sd(c["R"])
        srows.append([cid, c["stage"], ", ".join(sorted(c["mixes"])), c["made"], round((c["made"] - c["broken"]) / c["made"], 3) if c["made"] else None,
                      len(c["str"]), mn(c["str"]), sd(c["str"]), len(c["R"]), rm, rs, round(rs / rm, 3) if rm and rs else None])
    sheet("Programme summary", ["Condition", "Stage", "Mixtures", "Pressed", "Survival", "n crushed", "Mean strength (kPa)", "SD strength (kPa)",
                                "n resistance", "Mean R (Ω)", "SD R (Ω)", "CV R"], srows)


def write_workbook(docs, path):
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill
    from openpyxl.utils import get_column_letter
    projects = {p["id"]: p for p in docs.get("projects", []) if not p.get("deleted")}
    protos = {p["id"]: p for p in docs.get("protocols", []) if not p.get("deleted")}
    pname = lambda i: (projects.get(i) or {}).get("name", "")
    wb = Workbook()
    head_font, head_fill = Font(bold=True, color="FFFFFF"), PatternFill("solid", fgColor="166534")

    def sheet(title, header, rows, first=False):
        ws = wb.active if first else wb.create_sheet()
        ws.title = safe(title)[:31]
        ws.append(header)
        for c in ws[1]:
            c.font, c.fill = head_font, head_fill
        for r in rows:
            ws.append([clean_cell(x) for x in r])
        for row in ws.iter_rows(min_row=2):
            for c in row:
                if isinstance(c.value, dt.datetime):
                    c.number_format = "dd/mm/yyyy hh:mm"
                elif isinstance(c.value, dt.date):
                    c.number_format = "dd/mm/yyyy"
        ws.freeze_panes = "A2"
        for i, h in enumerate(header, 1):
            width = max([len(str(h))] + [len(str(r[i - 1])) for r in rows[:300] if i - 1 < len(r) and r[i - 1] is not None])
            ws.column_dimensions[get_column_letter(i)].width = min(60, max(10, width + 2))
        ws.auto_filter.ref = ws.dimensions
        return ws

    sheet("Projects", ["Project", "Summary", "Status", "Progress %", "Next step", "Folder", "Keywords", "Prefix"],
          [[p["name"], p.get("summary", ""), p.get("status", ""), p.get("progress", 0), p.get("nextStep", ""), p.get("folder", ""),
            p.get("keywords", ""), p.get("prefix", "")] for p in projects.values()], first=True)
    allp = {p["id"]: p for p in docs.get("projects", [])}
    pname_any = lambda i: (allp.get(i) or {}).get("name", "")

    def tstatus(t):
        if t.get("deleted"):
            return "Deleted"
        if t.get("done"):
            return "Done"
        if (allp.get(t.get("projectId")) or {}).get("status") == "Archived":
            return "Open (project archived)"
        if t.get("due") and t["due"] < dt.date.today().isoformat():
            return "Overdue"
        return "Open"
    order = {"Overdue": 0, "Open": 1, "Open (project archived)": 2, "Done": 3, "Deleted": 4}
    tasks = sorted(docs.get("tasks", []), key=lambda t: (order[tstatus(t)], t.get("due") or "9999"))
    sheet("Tasks", ["Task", "Project", "Status", "Due", "Completed", "Priority", "Created", "Last change", "Notes"],
          [[t["title"], pname_any(t.get("projectId")), tstatus(t), day(t.get("due")), day(t.get("completed")), t.get("priority", ""), when(t.get("created")),
            when(max([h.get("at", 0) for h in t.get("history") or []] or [0])), t.get("notes", "")] for t in tasks])
    events = sorted([(h.get("at", 0), t, h) for t in docs.get("tasks", []) for h in t.get("history") or []], key=lambda x: -x[0])
    sheet("Task history", ["When", "Task", "Project", "Change"], [[when(a), t["title"], pname_any(t.get("projectId")), h.get("what", "")] for a, t, h in events])
    sheet("Log", ["Logged", "Project", "Title", "Note", "Sample", "Photos"],
          [[when(l.get("when")), pname(l.get("projectId")), l.get("title", ""), l.get("note", ""), l.get("sampleId", ""), len(l.get("photos") or [])]
           for l in sorted(docs.get("log", []), key=lambda l: -(l.get("when") or 0)) if not l.get("deleted")])
    samples = sorted([s for s in docs.get("samples", []) if not s.get("deleted")], key=lambda s: s.get("created") or 0)
    sheet("Samples", ["SampleID", "Project", "Protocol", "Date", "Location", "Status", "Removed", "Notes"],
          [[s["sampleId"], pname(s.get("projectId")), (protos.get(s.get("protocolId")) or {}).get("name", s.get("protocolName", "")), made_day(s.get("created")),
            s.get("location", ""), s.get("status", ""), removed_text(s), s.get("notes", "")] for s in samples])
    for pr in protos.values():
      try:
        used = {k for s in samples if s.get("protocolId") == pr["id"] for k in (s.get("values") or {})}
        # fields removed in the app are left out unless a sample already holds a value for them
        fields = sorted([f for f in pr.get("fields", []) if not f.get("off") or f["key"] in used], key=lambda f: f.get("step") or 0)
        rows, changed = [], []
        # pellets linked to a mixture batch: flag values changed from what the batch gave them
        has_batch = any(f.get("type") == "Batch" for f in pr.get("fields", []))
        has_press = comp_field(fields) is not None and any(f["label"].strip().lower() == "diameter" for f in fields)
        label = {f["key"]: f["label"] for f in fields}
        for s in samples:
            if s.get("protocolId") != pr["id"]:
                continue
            v = s.get("values") or {}
            dens, stren = derived(fields, v)
            diff = s.get("batchDiff") or {}
            extra = [pressure(fields, v)] if has_press else []
            flag = ["; ".join(f"{label.get(k, k)}: {v.get(k, '') if v.get(k) is not None else ''} (batch {b if b != '' else 'blank'})" for k, b in diff.items())] if has_batch else []
            rows.append([s["sampleId"], made_day(s.get("created")), s.get("location", "")] + [v.get(f["key"]) for f in fields] + extra + [dens, stren] + flag + [s.get("notes", "")])
            changed.append([i for i, f in enumerate(fields) if f["key"] in diff])
        header = (["SampleID", "Date", "Location"] + [f["label"] + (f" ({f['unit']})" if f.get("unit") else "") for f in fields]
                  + (["Compaction pressure (MPa)"] if has_press else []) + ["Density (g/cm³)", "Strength F/A (kPa)"]
                  + (["Changed from batch"] if has_batch else []) + ["Notes"])
        ws = sheet(pr["name"], header, rows)
        if any(changed):
            from openpyxl.styles import PatternFill
            amber = PatternFill("solid", fgColor="FDE68A")
            for r, cols in enumerate(changed, start=2):
                for i in cols:
                    ws.cell(row=r, column=4 + i).fill = amber
      except Exception as e:  # one odd protocol shouldn't stop the whole workbook
        log(f"Skipped the sheet for protocol {pr.get('name')!r}: {e!r}")
    try:
        programme_sheets(docs, samples, protos, sheet)
    except Exception as e:  # never let the programme sheet stop the rest of the workbook
        log(f"Skipped the Programme sheet: {e!r}")
    sheet("Links", ["Project", "Name", "Link", "Added"],
          [[p["name"], k.get("title", ""), k.get("url", ""), when(k.get("added"))] for p in projects.values() for k in p.get("links") or []])
    for ws in wb.worksheets:
        if ws.title == "Links":
            for r in ws.iter_rows(min_row=2, min_col=3, max_col=3):
                for c in r:
                    if c.value:
                        c.hyperlink = c.value
                        c.style = "Hyperlink"
    sheet("Locations", ["Location", "Type"], [[l["name"], "Tray (A–D × 1–6)" if l.get("tray") else "Place"] for l in docs.get("locations", []) if not l.get("deleted")])
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(suffix=".xlsx", dir=path.parent)
    os.close(fd)
    wb.save(tmp)
    latest = path.with_name(path.stem + " (latest).xlsx")
    try:
        os.replace(tmp, path)
        try:
            latest.unlink()  # the main file is up to date again, so the stand-in copy isn't needed
        except OSError:
            pass
        return True
    except PermissionError:
        # the main file is open in Excel: put the up-to-date version next to it instead of skipping
        try:
            os.replace(tmp, latest)
            log(f"LabDash-data.xlsx is open in Excel, so the up-to-date version was saved as {latest.name}. Close Excel and the next sync updates the main file.")
        except PermissionError:
            os.remove(tmp)
            log("LabDash-data.xlsx and its (latest) copy are both open in Excel, so nothing was updated this time.")
        return False


class RunLock:
    """Stops two syncs (the scheduled one and a manual one) running at once and saving photos twice."""
    def __init__(self):
        self.path = STATE_DIR / "sync.lock"
        self.held = False

    def __enter__(self):
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        try:
            if self.path.exists() and time.time() - self.path.stat().st_mtime > 300:
                self.path.unlink()  # left behind by a sync that crashed
            fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.write(fd, str(os.getpid()).encode())
            os.close(fd)
            self.held = True
        except FileExistsError:
            pass
        return self

    def __exit__(self, *a):
        if self.held:
            try:
                self.path.unlink()
            except OSError:
                pass


def sync(src, passphrase, onedrive_root):
    with RunLock() as lock:
        if not lock.held:
            log("Another sync is already running, so this one was skipped.")
            return
        _sync(src, passphrase, onedrive_root)


def _sync(src, passphrase, onedrive_root):
    raw = src.get("vault.json")
    if raw is None:
        log("No LabDash in the repository yet. Set it up on your phone first.")
        return
    key, docs = unlock(json.loads(raw), passphrase)
    st = load_state()
    done = set(st.get("photos", []))
    projects = {p["id"]: p for p in docs.get("projects", [])}
    new = 0
    for l in docs.get("log", []):
        if l.get("deleted"):
            continue
        stamp = (when(l.get("when")) or dt.datetime.now()).strftime("%Y-%m-%d_%H%M")
        base = safe(l.get("sampleId") or l.get("title") or "photo")[:60]
        for n, pid in enumerate(l.get("photos") or [], 1):
            if pid in done:
                continue
            blob = src.get(f"img/{pid}.json")
            if blob is None:
                continue  # not uploaded yet; try next time
            folder = project_dir(onedrive_root, projects.get(l.get("projectId")))
            folder.mkdir(parents=True, exist_ok=True)
            name = f"{base}_{stamp}" + (f"_{n}" if len(l["photos"]) > 1 else "") + ".jpg"
            data = decrypt_image(key, json.loads(blob))
            target = folder / name
            i = 2
            while target.exists() and target.read_bytes() != data:
                target = folder / f"{Path(name).stem}~{i}.jpg"
                i += 1
            if not target.exists():
                target.write_bytes(data)
                new += 1
            done.add(pid)
            st["photos"] = sorted(done)
            save_state(st)  # record each photo straight away
    wrote = write_workbook(docs, onedrive_root / "LabDash" / "LabDash-data.xlsx")
    st["photos"] = sorted(done)
    st["last"] = time.time()
    save_state(st)
    log(f"Synced: {len(docs.get('samples', []))} samples, {len(docs.get('tasks', []))} tasks, {new} new photos" + ("" if wrote else " (workbook skipped)"))


def default_onedrive():
    for k in ("OneDriveConsumer", "OneDrive", "OneDriveCommercial"):
        if os.environ.get(k):
            return os.environ[k]
    return str(Path.home() / "OneDrive")


def setup():
    print("LabDash laptop sync setup\n")
    repo = input("Private data repository (e.g. your-username/LabDash-data): ").strip()
    repo = re.sub(r"^https?://github\.com/", "", repo).rstrip("/").removesuffix(".git")
    print("Paste the GitHub token below. In this window, paste with a RIGHT-CLICK (Ctrl+V may not work), then press Enter.")
    token = input("GitHub access token: ").strip()
    if not token.startswith("github_pat_"):
        raise SystemExit("That doesn't look like a fine-grained token (they start with github_pat_). Run install.bat again and paste it with a right-click.")
    src = Source(repo, token)
    try:
        info = src.repo_info()
    except urllib.error.HTTPError as e:
        raise SystemExit(f"GitHub said {e.code}. Check the repository name and that the token can read it.")
    if not info.get("private"):
        raise SystemExit("That repository is public. Make it private on GitHub first.")
    passphrase = getpass.getpass("LabDash passphrase (type it; nothing shows as you type, then press Enter): ")
    raw = src.get("vault.json")
    if raw is None:
        raise SystemExit("There's no LabDash in that repository yet. Set it up on your phone and sync first.")
    unlock(json.loads(raw), passphrase)
    od = input(f"OneDrive folder [{default_onedrive()}]: ").strip() or default_onedrive()
    set_secret("repo", repo)
    set_secret("token", token)
    set_secret("passphrase", passphrase)
    set_secret("onedrive", od)
    print("\nSaved to Windows Credential Manager. Running a first sync...")
    sync(src, passphrase, Path(od))
    if os.name == "nt":
        pyw = Path(sys.executable).with_name("pythonw.exe")
        exe = pyw if pyw.exists() else Path(sys.executable)
        cmd = f'"{exe}" "{Path(__file__).resolve()}" run'
        r = subprocess.run(["schtasks", "/Create", "/F", "/SC", "MINUTE", "/MO", "15", "/TN", "LabDash sync", "/TR", cmd], capture_output=True, text=True)
        print("Scheduled task added: runs every 15 minutes." if r.returncode == 0 else "Couldn't add the scheduled task:\n" + r.stdout + r.stderr)
    print(f"\nDone. Your workbook: {Path(od) / 'LabDash' / 'LabDash-data.xlsx'}\nLog: {LOG}")


def run():
    repo, token, pw, od = secret("repo"), secret("token"), secret("passphrase"), secret("onedrive")
    if not (repo and token and pw and od):
        raise SystemExit("Not set up yet: run  python labdash_sync.py setup")
    try:
        sync(Source(repo, token), pw, Path(od))
    except urllib.error.URLError as e:
        log(f"Offline or GitHub unreachable ({e}). Will try again next time.")


def remove():
    import keyring
    for n in ("repo", "token", "passphrase", "onedrive"):
        try:
            keyring.delete_password(APP, n)
        except Exception:
            pass
    if os.name == "nt":
        subprocess.run(["schtasks", "/Delete", "/F", "/TN", "LabDash sync"])
    print("Removed the scheduled task and stored secrets. Your OneDrive files are untouched.")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "run"
    if cmd == "setup":
        try:
            setup()
        except KeyboardInterrupt:
            print("\nSetup was cancelled (that happens if Ctrl+C is pressed). Run install.bat again.")
        except SystemExit as e:
            if e.code and not isinstance(e.code, int):
                print("\nSetup stopped: " + str(e.code))
        except Exception as e:
            print(f"\nSetup hit an error: {e!r}\nSend Claude a screenshot of this window.")
    elif cmd == "run":
        try:
            run()
        except SystemExit as e:
            if e.code and not isinstance(e.code, int):
                log(str(e.code))
            raise
        except Exception as e:  # keep a record when running hidden from the scheduler
            log(f"Error: {e!r}")
            raise
    elif cmd == "remove":
        remove()
    elif cmd == "test-local":  # developer check: python labdash_sync.py test-local <repo-dir> <passphrase> <out-dir>
        sync(Source("", "", sys.argv[2]), sys.argv[3], Path(sys.argv[4]))
    else:
        print(__doc__)
