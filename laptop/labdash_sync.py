"""LabDash laptop sync.

Downloads your encrypted LabDash from its private GitHub repository, decrypts it on this laptop and writes:
  * OneDrive/LabDash/LabDash-data.xlsx   (projects, tasks, log, samples, one sheet per protocol)
  * photos into each project's OneDrive folder, named by sample ID and date

Your passphrase and GitHub token are kept in Windows Credential Manager (via the keyring package),
never in a file. Run once with "setup", then a scheduled task syncs every 10 minutes from 07:00 to 17:00
(laptop time) and once an hour outside those hours.

    python labdash_sync.py setup     # asks for repo, token, passphrase, OneDrive folder; adds the scheduled task
    python labdash_sync.py run       # one sync now
    python labdash_sync.py schedule  # (re)creates the scheduled task with the timetable above
    python labdash_sync.py remove    # removes the scheduled task and stored secrets
    python labdash_sync.py write-access  # stores a token that can WRITE to the data repository (needed for the Inbox)
    python labdash_sync.py inbox-check   # shows what the files in OneDrive/LabDash/Inbox would change, without changing anything

Inbox: save an edited copy of LabDash-data.xlsx into OneDrive/LabDash/Inbox. The next sync writes the cells you changed on the
protocol sheets (measurements and Notes) into LabDash, then moves the file to Inbox/Done with a report of what it did.
"""
import base64, datetime as dt, getpass, json, os, re, socket, subprocess, sys, tempfile, threading, time, urllib.request, urllib.error
from pathlib import Path

APP = "LabDash"
STATE_DIR = Path(os.environ.get("LOCALAPPDATA", Path.home() / ".local" / "share")) / "LabDash"
STATE = STATE_DIR / "state.json"
LOG = STATE_DIR / "sync.log"
TASK = "LabDash sync"
BUSY_FROM, BUSY_TO = 7, 17   # every 10 minutes between these hours (laptop time), hourly otherwise
MAX_RUN = 8 * 60             # a sync that takes longer than this is stopped and logged
socket.setdefaulttimeout(60)
STAGE = ["starting"]         # what the sync is doing right now, for the log if it gets stuck


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

    def get_vault(self):
        """vault.json's bytes and its git sha (the sha lets the upload be refused if the phone saved in between)."""
        if self.local:
            p = self.local / "vault.json"
            if not p.exists():
                return None, None
            data = p.read_bytes()
            import hashlib
            return data, hashlib.sha1(data).hexdigest()
        h = {"Authorization": "Bearer " + self.token, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "LabDash-laptop-sync"}
        try:
            with urllib.request.urlopen(urllib.request.Request(f"https://api.github.com/repos/{self.repo}/contents/vault.json",
                                                               headers=dict(h, Accept="application/vnd.github.object+json")), timeout=60) as r:
                sha = json.loads(r.read())["sha"]
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None, None
            if e.code == 401:
                raise SystemExit("GitHub rejected the token. It may have expired: run setup again with a new one.")
            raise
        with urllib.request.urlopen(urllib.request.Request(f"https://api.github.com/repos/{self.repo}/git/blobs/{sha}",
                                                           headers=dict(h, Accept="application/vnd.github.raw+json")), timeout=120) as r:
            return r.read(), sha

    def put_vault(self, data, sha, write_token):
        """Upload a new vault.json. Returns False if it changed on GitHub since it was downloaded."""
        if self.local:
            p = self.local / "vault.json"
            import hashlib
            if hashlib.sha1(p.read_bytes()).hexdigest() != sha:
                return False
            p.write_bytes(data)
            return True
        body = json.dumps({"message": "LabDash sync (laptop inbox)", "content": base64.b64encode(data).decode(), "sha": sha}).encode()
        req = urllib.request.Request(f"https://api.github.com/repos/{self.repo}/contents/vault.json", data=body, method="PUT",
                                     headers={"Authorization": "Bearer " + write_token, "Accept": "application/vnd.github+json",
                                              "Content-Type": "application/json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "LabDash-laptop-sync"})
        try:
            with urllib.request.urlopen(req, timeout=120):
                return True
        except urllib.error.HTTPError as e:
            if e.code in (409, 422):
                return False
            if e.code in (401, 403, 404):
                raise SystemExit("GitHub refused the upload. The write token may have expired or can't write to the repository: run  python labdash_sync.py write-access  again.")
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


def seal(key, vault, docs):
    """Encrypt the notebook again exactly as the app does (same data key, fresh IV)."""
    iv = os.urandom(12)
    ct = key.encrypt(iv, json.dumps(docs, ensure_ascii=False, separators=(",", ":")).encode("utf-8"), None)
    return json.dumps({"kind": vault.get("kind", "labdash-vault"), "v": vault.get("v", 1), "keys": vault["keys"],
                       "iv": base64.b64encode(iv).decode(), "ct": base64.b64encode(ct).decode(),
                       "saved": int(time.time() * 1000)}).encode("utf-8")


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
        off = mix.get("progOff")
        rows.append([p["sampleId"], mix["prog"] + (" (not counted)" if off else ""), d.get("stage"), mix["sampleId"], d.get("size"), d.get("C"), d.get("G"),
                     (d.get("C") or 0) - (d.get("G") or 0) if d.get("C") is not None else None, fnum(v.get(cf["key"])) if cf else None, d.get("dry"),
                     made_day(p.get("created")), green, mass, dia, hgt, res, brk, v.get(lab.get("failure mode", ""), ""), loss, dens, rho, stren,
                     rem, p.get("notes", "")])
        if off:  # made wrong: in the pellet list, not in the condition's results
            continue
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
        if c and m.get("deformed") and not m.get("progOff"):
            c["made"] += m["deformed"]
            c["broken"] += m["deformed"]
    rows.sort(key=lambda r: (r[1], r[0]))
    # stocks the mixtures were made from
    stk = {s["sampleId"]: s for s in samples if (protos.get(s.get("protocolId")) or {}).get("kind") == "fjhstock"}
    for r in rows:
        mv = (by_id.get(r[3]) or {}).get("values") or {}
        r.insert(10, ", ".join(f'{(stk.get(mv.get(f"stock{i}")) or {}).get("values", {}).get("stk_code", mv.get(f"stock{i}"))} {mv.get(f"stock{i}_g")} g'
                                for i in (1, 2, 3) if mv.get(f"stock{i}")))
    sheet("Programme", ["Pellet", "Condition", "Stage", "Mixture", "Coke size", "Total carbon (% of mix)", "Graphite (% of mix)", "Coke (% of mix)", "Force (N)", "Drying", "Stocks",
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


# ---------- inbox: edited copies of the workbook flow back into LabDash ----------
# Put an edited copy of LabDash-data.xlsx in OneDrive\LabDash\Inbox. On the next sync, every cell on a protocol sheet that you
# typed a new value into is written to that sample in LabDash, then the file moves to Inbox\Done with a report next to it.
# Blank cells never clear anything, calculated columns are ignored, and a value that LabDash itself held earlier (an
# out-of-date copy) is not written back over a newer one.
INBOX_TYPES = {"Number", "Text", "Choice", "Check", "Stock", "Calc"}
CLEAR = "(clear)"  # type this in a cell to blank that value in LabDash


def _num(v):
    try:
        return float(str(v).replace(",", ".").strip())
    except (TypeError, ValueError):
        return None


def same_val(a, b):
    """The app's own comparison: equal as text, or equal as numbers."""
    a = "" if a is None else str(a).strip()
    b = "" if b is None else str(b).strip()
    if a == b:
        return True
    x, y = _num(a), _num(b)
    return x is not None and y is not None and x == y


def vkey(v):
    """A stable text form of a value, for remembering what LabDash has held."""
    n = _num(v)
    return repr(n) if n is not None else ("" if v is None else str(v).strip())


def remember_values(docs, st):
    """Note every value LabDash holds now, so an older copy of the workbook can't put an old value back."""
    seen = st.setdefault("seen", {})
    for s in docs.get("samples", []):
        if s.get("deleted"):
            continue
        rec = seen.setdefault(s.get("id", ""), {})
        for k, v in list((s.get("values") or {}).items()) + [("__notes", s.get("notes", ""))]:
            lst = rec.setdefault(k, [])
            kv = vkey(v)
            if kv not in lst:
                lst.append(kv)
                del lst[:-12]


def inbox_files(onedrive_root):
    box = onedrive_root / "LabDash" / "Inbox"
    box.mkdir(parents=True, exist_ok=True)
    return sorted(p for p in box.glob("*.xlsx") if not p.name.startswith("~$"))


def plan_inbox(docs, st, path):
    """Work out what an edited workbook changes. Returns (changes, notes) without touching anything."""
    from openpyxl import load_workbook
    wb = load_workbook(path, data_only=True, read_only=True)
    protos = [p for p in docs.get("protocols", []) if not p.get("deleted")]
    samples = [s for s in docs.get("samples", []) if not s.get("deleted")]
    seen = st.get("seen", {})
    changes, notes = [], []
    for pr in protos:
        title = safe(pr["name"])[:31]
        if title not in wb.sheetnames:
            continue
        rows = list(wb[title].iter_rows(values_only=True))
        if not rows:
            continue
        header = [str(h).strip() if h is not None else "" for h in rows[0]]
        cols = {}
        for f in pr.get("fields", []):
            name = f["label"] + (f" ({f['unit']})" if f.get("unit") else "")
            if name in header:
                cols[header.index(name)] = f
        notes_col = header.index("Notes") if "Notes" in header else None
        by_sid = {s["sampleId"]: s for s in samples if s.get("protocolId") == pr["id"]}
        for r in rows[1:]:
            if not r or r[0] is None:
                continue
            sid = str(r[0]).strip()
            s = by_sid.get(sid)
            if not s:
                notes.append(f"{title}: {sid} isn't a {pr['name']} sample in LabDash, so its row was skipped.")
                continue
            vals = s.get("values") or {}
            hist = seen.get(s["id"], {})
            todo = [(i, f) for i, f in cols.items()] + ([(notes_col, None)] if notes_col is not None else [])
            for i, f in todo:
                new = r[i] if i < len(r) else None
                if new is None or str(new).strip() == "":
                    continue  # blank cells never clear anything; type (clear) to blank a value
                key = f["key"] if f else "__notes"
                label = f["label"] if f else "Notes"
                old = vals.get(key) if f else s.get("notes", "")
                if str(new).strip().lower() == CLEAR:
                    if old is not None and str(old).strip() != "":
                        changes.append({"sample": s, "key": key, "label": label, "old": old, "new": None})
                    continue
                if same_val(new, old):
                    continue
                if vkey(new) in hist.get(key, []):
                    notes.append(f"{sid} {label}: your copy has {new!r}, an older value. LabDash now has {old!r}, so it was kept.")
                    continue
                if f:
                    ftype = f.get("type", "Text")
                    if ftype not in INBOX_TYPES:
                        notes.append(f"{sid} {label}: this is a {ftype} field, which can only be changed in the app.")
                        continue
                    if f.get("showIf") and str(vals.get(f["showIf"].get("key"), "")) != str(f["showIf"].get("equals")):
                        notes.append(f"{sid} {label}: this field is hidden for this sample in the app, so it was skipped.")
                        continue
                    if ftype == "Stock" and not any(x.get("sampleId") == str(new).strip() for x in samples):
                        notes.append(f"{sid} {label}: {new!r} isn't a stock in LabDash, so it was skipped.")
                        continue
                    if ftype in ("Number", "Calc"):
                        n = _num(new)
                        if n is None:
                            notes.append(f"{sid} {label}: {new!r} isn't a number, so it was skipped.")
                            continue
                        new = int(n) if n.is_integer() else n
                    else:
                        new = str(new).strip()
                        opts = f.get("options") or []
                        if ftype in ("Choice", "Check") and opts and new not in opts:
                            notes.append(f"{sid} {label}: {new!r} isn't one of the choices ({', '.join(map(str, opts))}), so it was skipped.")
                            continue
                else:
                    new = str(new).strip()
                changes.append({"sample": s, "key": key, "label": label, "old": old, "new": new})
    wb.close()
    return changes, notes


def apply_changes(changes):
    now = int(time.time() * 1000)
    for c in changes:
        s = c["sample"]
        if c["key"] == "__notes":
            s["notes"] = c["new"] or ""
        elif c["new"] is None:  # (clear)
            (s.get("values") or {}).pop(c["key"], None)
        else:
            s.setdefault("values", {})[c["key"]] = c["new"]
            diff = s.get("batchDiff")
            if isinstance(diff, dict) and c["key"] in diff:  # keep the "changed from batch" flag honest
                if same_val(c["new"], diff[c["key"]]):
                    del diff[c["key"]]
                if not diff:
                    s.pop("batchDiff", None)
        s["edited"] = s["updated"] = now


def describe(changes, notes):
    def show(v):
        return "(blank)" if v is None or str(v).strip() == "" else str(v)
    lines = [f"{c['sample']['sampleId']}  {c['label']}: {show(c['old'])} -> {show(c['new'])}" for c in changes]
    return lines + ([""] + ["Not applied:"] + ["  " + n for n in notes] if notes else [])


def process_inbox(src, key, vault, docs, sha, st, onedrive_root):
    """Apply edited workbooks from the Inbox. Returns the notebook as it now stands."""
    files = inbox_files(onedrive_root)
    if not files:
        return docs
    wt = secret("write_token") if not src.local else "local"
    if not wt:
        log(f"{len(files)} file(s) waiting in the LabDash Inbox. To let the laptop write to LabDash, run  python labdash_sync.py write-access  once.")
        return docs
    done = onedrive_root / "LabDash" / "Inbox" / "Done"
    done.mkdir(parents=True, exist_ok=True)
    stamp = dt.datetime.now().strftime("%Y-%m-%d_%H%M")
    for path in files:
        STAGE[0] = f"reading {path.name} from the Inbox"
        try:
            changes, notes = plan_inbox(docs, st, path)
        except PermissionError:
            log(f"{path.name} is open in Excel, so the Inbox will pick it up next time.")
            continue
        except Exception as e:
            log(f"Couldn't read {path.name} from the Inbox: {e!r}")
            continue
        if changes:
            apply_changes(changes)
            STAGE[0] = f"uploading {len(changes)} change(s) from {path.name}"
            if not src.put_vault(seal(key, vault, docs), sha, wt):
                log(f"LabDash changed on GitHub while {path.name} was being applied (probably your phone syncing). It will be tried again next time.")
                raise _Retry()
            _, sha = src.get_vault()
        report = [f"{path.name}  ·  applied {dt.datetime.now():%d/%m/%Y %H:%M}", f"{len(changes)} change(s) written to LabDash:", ""] + describe(changes, notes)
        target = done / f"{path.stem} {stamp}.xlsx"
        try:
            os.replace(path, target)
        except OSError:
            target = path
        target.with_name(target.stem + " - report.txt").write_text("\n".join(report) + "\n", encoding="utf-8")
        log(f"Inbox: {path.name} gave {len(changes)} change(s), {len(notes)} skipped. Report in Inbox\\Done.")
    return docs


class _Retry(Exception):
    pass


class RunLock:
    """Stops two syncs (the scheduled one and a manual one) running at once and saving photos twice."""
    def __init__(self):
        self.path = STATE_DIR / "sync.lock"
        self.held = False

    def __enter__(self):
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        try:
            if self.path.exists() and time.time() - self.path.stat().st_mtime > MAX_RUN + 120:
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
        timer = watchdog(lock.path)
        try:
            _sync(src, passphrase, onedrive_root)
        finally:
            timer.cancel()


def watchdog(lock_path):
    """If a sync hangs (usually a network call that never answers), log where it stopped and end it."""
    def fire():
        log(f"Sync stopped after {MAX_RUN // 60} minutes stuck at: {STAGE[0]}. Will try again next time.")
        try:
            lock_path.unlink()
        except OSError:
            pass
        os._exit(3)
    t = threading.Timer(MAX_RUN, fire)
    t.daemon = True
    t.start()
    return t


def _sync(src, passphrase, onedrive_root):
    t0 = time.time()
    STAGE[0] = "downloading vault.json from GitHub"
    raw, sha = src.get_vault()
    if raw is None:
        log("No LabDash in the repository yet. Set it up on your phone first.")
        return
    STAGE[0] = f"decrypting vault.json ({len(raw) // 1024} KB)"
    vault = json.loads(raw)
    key, docs = unlock(vault, passphrase)
    st = load_state()
    remember_values(docs, st)
    try:
        docs = process_inbox(src, key, vault, docs, sha, st, onedrive_root)
    except _Retry:
        save_state(st)
        return
    remember_values(docs, st)
    save_state(st)
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
            STAGE[0] = f"downloading photo {pid} ({new} new photos saved so far)"
            blob = src.get(f"img/{pid}.json")
            if blob is None:
                continue  # not uploaded yet; try next time
            folder = project_dir(onedrive_root, projects.get(l.get("projectId")))
            folder.mkdir(parents=True, exist_ok=True)
            name = f"{base}_{stamp}" + (f"_{n}" if len(l["photos"]) > 1 else "") + ".jpg"
            STAGE[0] = f"saving photo {name} to OneDrive"
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
    STAGE[0] = "writing LabDash-data.xlsx"
    wrote = write_workbook(docs, onedrive_root / "LabDash" / "LabDash-data.xlsx")
    st["photos"] = sorted(done)
    st["last"] = time.time()
    save_state(st)
    log(f"Synced: {len(docs.get('samples', []))} samples, {len(docs.get('tasks', []))} tasks, {new} new photos" + ("" if wrote else " (workbook skipped)")
        + (f" in {time.time() - t0:.0f} s" if time.time() - t0 > 60 else ""))


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
    schedule()
    print(f"\nDone. Your workbook: {Path(od) / 'LabDash' / 'LabDash-data.xlsx'}\nLog: {LOG}")


def schedule():
    """The task fires every 10 minutes; outside BUSY_FROM-BUSY_TO, run --scheduled only syncs once an hour."""
    if os.name != "nt":
        return
    pyw = Path(sys.executable).with_name("pythonw.exe")
    exe = pyw if pyw.exists() else Path(sys.executable)
    cmd = f'"{exe}" "{Path(__file__).resolve()}" run --scheduled'
    r = subprocess.run(["schtasks", "/Create", "/F", "/SC", "MINUTE", "/MO", "10", "/TN", TASK, "/TR", cmd], capture_output=True, text=True)
    print(f"Scheduled task set: every 10 minutes {BUSY_FROM:02d}:00-{BUSY_TO:02d}:00, hourly otherwise."
          if r.returncode == 0 else "Couldn't set the scheduled task:\n" + r.stdout + r.stderr)


def due(st, now=None):
    """Scheduled runs: always during working hours, otherwise once an hour."""
    now = now or dt.datetime.now()
    if BUSY_FROM <= now.hour < BUSY_TO:
        return True
    return time.time() - st.get("tried", 0) >= 55 * 60


def run(scheduled=False):
    if scheduled:
        st = load_state()
        if not due(st):
            return
        st["tried"] = time.time()
        save_state(st)
    repo, token, pw, od = secret("repo"), secret("token"), secret("passphrase"), secret("onedrive")
    if not (repo and token and pw and od):
        raise SystemExit("Not set up yet: run  python labdash_sync.py setup")
    try:
        sync(Source(repo, token), pw, Path(od))
    except urllib.error.URLError as e:
        log(f"Offline or GitHub unreachable ({e}). Will try again next time.")


def write_access():
    repo = secret("repo")
    if not repo:
        raise SystemExit("Not set up yet: run install.bat first.")
    print(f"The Inbox needs a GitHub token that can READ AND WRITE {repo}.")
    print("On GitHub: Settings > Developer settings > Fine-grained tokens > Generate new token.")
    print(f"  Repository access: Only select repositories > {repo}")
    print("  Permissions: Contents > Read and write")
    print("Paste the token below with a RIGHT-CLICK, then press Enter.")
    token = input("GitHub write token: ").strip()
    if not token.startswith("github_pat_"):
        raise SystemExit("That doesn't look like a fine-grained token (they start with github_pat_). Try again and paste it with a right-click.")
    req = urllib.request.Request(f"https://api.github.com/repos/{repo}", headers={"Authorization": "Bearer " + token,
                                 "Accept": "application/vnd.github+json", "User-Agent": "LabDash-laptop-sync"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            info = json.loads(r.read())
    except urllib.error.HTTPError as e:
        raise SystemExit(f"GitHub said {e.code}. Check the token can reach {repo}.")
    if not (info.get("permissions") or {}).get("push"):
        raise SystemExit("That token can read the repository but not write to it. Give it Contents: Read and write.")
    set_secret("write_token", token)
    print("Saved to Windows Credential Manager. Files you put in OneDrive\\LabDash\\Inbox will now be applied at each sync.")


def inbox_check():
    repo, token, pw, od = secret("repo"), secret("token"), secret("passphrase"), secret("onedrive")
    if not (repo and token and pw and od):
        raise SystemExit("Not set up yet: run install.bat first.")
    raw, _ = Source(repo, token).get_vault()
    _, docs = unlock(json.loads(raw), pw)
    st = load_state()
    remember_values(docs, st)
    files = inbox_files(Path(od))
    if not files:
        print("The Inbox is empty: " + str(Path(od) / "LabDash" / "Inbox"))
    for f in files:
        changes, notes = plan_inbox(docs, st, f)
        print(f"\n{f.name}: {len(changes)} change(s) would be written")
        print("\n".join("  " + x for x in describe(changes, notes)))
    if files and not secret("write_token"):
        print("\nNothing will be written until you run  python labdash_sync.py write-access")


def remove():
    import keyring
    for n in ("repo", "token", "passphrase", "onedrive", "write_token"):
        try:
            keyring.delete_password(APP, n)
        except Exception:
            pass
    if os.name == "nt":
        subprocess.run(["schtasks", "/Delete", "/F", "/TN", TASK])
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
            run(scheduled="--scheduled" in sys.argv[2:])
        except SystemExit as e:
            if e.code and not isinstance(e.code, int):
                log(str(e.code))
            raise
        except Exception as e:  # keep a record when running hidden from the scheduler
            log(f"Error: {e!r}")
            raise
    elif cmd == "schedule":
        schedule()
    elif cmd == "write-access":
        try:
            write_access()
        except SystemExit as e:
            if e.code and not isinstance(e.code, int):
                print("\nStopped: " + str(e.code))
    elif cmd == "inbox-check":
        inbox_check()
    elif cmd == "remove":
        remove()
    elif cmd == "test-local":  # developer check: python labdash_sync.py test-local <repo-dir> <passphrase> <out-dir>
        sync(Source("", "", sys.argv[2]), sys.argv[3], Path(sys.argv[4]))
    else:
        print(__doc__)
