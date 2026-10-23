/* LabDash — a private lab notebook for your phone.
   Data is encrypted on the device with a random data key (AES-GCM-256). That key is wrapped with a key
   derived from your passphrase (PBKDF2-SHA256, 600,000 rounds). Sync stores only the encrypted vault and
   encrypted photos in a PRIVATE GitHub repository; the access token lives inside this device's encrypted
   copy (docs._device) and is never synced. This public code contains no data. */
"use strict";
const $ = id => document.getElementById(id);
const te = new TextEncoder(), td = new TextDecoder();
const ITER = 600000;
const APP_VERSION = "1.5";
const WHATS_NEW = "Fixed the page sliding sideways when scrolling";
const rnd = n => crypto.getRandomValues(new Uint8Array(n));
function b64(buf) { const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf); let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s) }
function unb64(s) { const bin = atob(s); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out }
const uid = (p = "") => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const clone = o => JSON.parse(JSON.stringify(o));

/* ---------- crypto ---------- */
async function passKey(pass, salt, iter) {
  const base = await crypto.subtle.importKey("raw", te.encode(pass), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: iter, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
const importData = raw => crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
async function wrap(raw, wk) { const iv = rnd(12); return { iv: b64(iv), ct: b64(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, wk, raw)) } }
async function unwrap(w, wk) { return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(w.iv) }, wk, unb64(w.ct))) }
async function passWrap(raw, pass) { const salt = rnd(16); return { salt: b64(salt), iter: ITER, ts: Date.now(), ...(await wrap(raw, await passKey(pass, salt, ITER))) } }
async function sealObj(obj) { const iv = rnd(12); const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, S.key, te.encode(JSON.stringify(obj))); return { kind: "labdash-vault", v: 1, keys: S.keys, iv: b64(iv), ct: b64(ct), saved: Date.now() } }
async function openBody(k, rec) { return JSON.parse(td.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(rec.iv) }, k, unb64(rec.ct)))) }
async function openWithPass(rec, pass) {
  const p = rec.keys.pass; const raw = await unwrap(p, await passKey(pass, unb64(p.salt), p.iter));
  const k = await importData(raw); return { raw, key: k, docs: await openBody(k, rec) };
}
async function encBytes(bytes) { const iv = rnd(12); return { iv: b64(iv), ct: await crypto.subtle.encrypt({ name: "AES-GCM", iv }, S.key, bytes) } }
async function decBytes(rec) { return crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(rec.iv) }, S.key, rec.ct instanceof ArrayBuffer ? rec.ct : unb64(rec.ct)) }

/* ---------- IndexedDB ---------- */
let dbp = null;
function idb() {
  if (!dbp) dbp = new Promise((res, rej) => { const r = indexedDB.open("labdash", 1); r.onupgradeneeded = () => { r.result.createObjectStore("kv"); r.result.createObjectStore("files") }; r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) });
  return dbp;
}
async function tx(store, mode, fn) { const d = await idb(); return new Promise((res, rej) => { const t = d.transaction(store, mode); const s = t.objectStore(store); const r = fn(s); t.oncomplete = () => res(r && r.result); t.onerror = () => rej(t.error) }) }
const kvGet = k => tx("kv", "readonly", s => s.get(k));
const kvPut = (k, v) => tx("kv", "readwrite", s => s.put(v, k));
const kvDel = k => tx("kv", "readwrite", s => s.delete(k));
const fileGet = id => tx("files", "readonly", s => s.get(id));
const filePut = (id, v) => tx("files", "readwrite", s => s.put(v, id));

/* ---------- state ---------- */
const S = { key: null, raw: null, keys: null, docs: null, nav: [{ v: "home" }], urls: [] };
const D = () => S.docs;
function blankDocs() {
  return { projects: [], tasks: [], protocols: [], samples: [], log: [], locations: ["Bench", "Desiccator 1", "Desiccator 2", "Drying oven", "Sample cabinet", "Used up"].map(n => ({ id: uid("l"), name: n })), settings: {} };
}
function ensureShape(d) { const b = blankDocs(); for (const k of Object.keys(b)) if (!(k in d)) d[k] = b[k]; return d }
let saving = Promise.resolve();
function persist() {
  saving = saving.then(async () => { if (!S.key) return; await kvPut("vault", await sealObj(S.docs)) });
  syncSoon(2500);
  return saving.catch(e => toast("Couldn't save on this device: " + (e && e.message || e), true));
}
async function rememberDevice(on) {
  if (!on) { await kvDel("devkey"); return }
  const dk = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const iv = rnd(12); const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, dk, S.raw);
  await kvPut("devkey", { dk, iv, ct });
}

/* ---------- boot / lock ---------- */
function showOnly(id) { ["unlockForm", "startChoice", "newForm", "joinForm"].forEach(x => $(x).hidden = x !== id) }
async function boot() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).then(r => r.update()).catch(() => {});
  let vault = null; try { vault = await kvGet("vault") } catch (e) { $("lockSub").textContent = "This browser is blocking storage. Open LabDash in Safari or Chrome directly."; return }
  if (!vault) { $("lockSub").textContent = "Welcome. Set up this device:"; showOnly("startChoice"); return }
  const dev = await kvGet("devkey").catch(() => null);
  if (dev) {
    try { const raw = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: dev.iv }, dev.dk, dev.ct)); const k = await importData(raw); const docs = await openBody(k, vault); return start(raw, k, docs, vault.keys) }
    catch (e) { await kvDel("devkey") }
  }
  $("lockSub").textContent = "Locked."; showOnly("unlockForm"); $("unlockPass").focus();
}
async function start(raw, k, docs, keys) {
  S.raw = raw; S.key = k; S.docs = ensureShape(docs); S.keys = keys;
  $("lock").hidden = true; $("app").hidden = false; go("home", {}, true); setSyncUI(); syncSoon(600); flashVersion();
}
$("unlockForm").addEventListener("submit", async e => {
  e.preventDefault(); const h = $("unlockHint"); h.className = "hint"; h.textContent = "Unlocking…";
  try { const vault = await kvGet("vault"); const o = await openWithPass(vault, $("unlockPass").value); await start(o.raw, o.key, o.docs, vault.keys); await rememberDevice($("unlockRemember").checked); $("unlockPass").value = "" }
  catch (_) { h.className = "hint err"; h.textContent = "That passphrase doesn't open LabDash." }
});
$("startNew").addEventListener("click", () => showOnly("newForm"));
$("startJoin").addEventListener("click", () => showOnly("joinForm"));
document.querySelectorAll("[data-back]").forEach(b => b.addEventListener("click", () => showOnly("startChoice")));
$("newForm").addEventListener("submit", async e => {
  e.preventDefault(); const h = $("newHint"); const p1 = $("newPass").value, p2 = $("newPass2").value;
  if (p1.length < 10) { h.className = "hint err"; h.textContent = "Use at least 10 characters."; return }
  if (p1 !== p2) { h.className = "hint err"; h.textContent = "The two passphrases don't match."; return }
  h.className = "hint"; h.textContent = "Creating your encrypted notebook…";
  const raw = rnd(32); const k = await importData(raw); const keys = { pass: await passWrap(raw, p1) };
  await start(raw, k, blankDocs(), keys); await persist(); await rememberDevice($("newRemember").checked);
  $("newPass").value = $("newPass2").value = "";
});
$("joinForm").addEventListener("submit", async e => {
  e.preventDefault(); const h = $("joinHint"); h.className = "hint"; h.textContent = "Checking the repository…";
  const repo = cleanRepo($("joinRepo").value), token = $("joinToken").value.trim();
  try {
    const info = await gh({ repo, token }, "GET", ""); if (!info) throw Object.assign(new Error("x"), { status: 404 }); if (!info.private) throw new Error("public");
    const f = await ghGetFile({ repo, token }, "vault.json"); if (!f) { h.className = "hint err"; h.textContent = "There's no LabDash in that repository yet. Start a new one on your first device, then join here."; return }
    const rec = JSON.parse(f.text); let o; try { o = await openWithPass(rec, $("joinPass").value) } catch (_) { h.className = "hint err"; h.textContent = "That passphrase doesn't open the synced LabDash."; return }
    o.docs._device = { sync: { repo, token, branch: info.default_branch || "main", last: Date.now() }, base: clone(o.docs) };
    await start(o.raw, o.key, o.docs, rec.keys); await persist(); await rememberDevice($("joinRemember").checked);
    $("joinToken").value = $("joinPass").value = ""; toast("Joined. Everything is synced.");
  } catch (err) { h.className = "hint err"; h.textContent = syncError(err) }
});

/* ---------- version flash + updates ---------- */
function flashVersion() {
  let seen = null; try { seen = localStorage.getItem("labdash-version"); localStorage.setItem("labdash-version", APP_VERSION) } catch (_) {}
  const b = el("div", { class: "vflash" }, el("b", { text: "LabDash v" + APP_VERSION }), seen && seen !== APP_VERSION ? el("span", { text: "Updated · " + WHATS_NEW }) : null);
  document.body.append(b); setTimeout(() => b.classList.add("out"), seen && seen !== APP_VERSION ? 4200 : 1600); setTimeout(() => b.remove(), 5000);
}
async function forceUpdate() {
  toast("Fetching the latest version…");
  try { const regs = await navigator.serviceWorker.getRegistrations(); await Promise.all(regs.map(r => r.unregister())) } catch (_) {}
  try { const ks = await caches.keys(); await Promise.all(ks.map(k => caches.delete(k))) } catch (_) {}
  location.replace(location.pathname + "?u=" + Date.now());
}

/* ---------- helpers ---------- */
function el(tag, attrs, ...kids) {
  const n = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") n.className = v; else if (k === "text") n.textContent = v; else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (k === "style") n.style.cssText = v; else n.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return n;
}
function toast(msg, err) { const t = $("toast"); t.textContent = msg; t.className = "toast" + (err ? " err" : ""); t.hidden = false; clearTimeout(t._t); t._t = setTimeout(() => t.hidden = true, 2600) }
const pad = n => String(n).padStart(2, "0");
const todayISO = () => { const d = new Date(); return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) };
const addDays = (iso, n) => { const d = new Date(iso + "T12:00:00"); d.setDate(d.getDate() + n); return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) };
const daysBetween = (a, b) => Math.round((new Date(b + "T12:00:00") - new Date(a + "T12:00:00")) / 864e5);
const fmtDay = iso => iso ? new Date(iso + "T12:00:00").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }) : "";
const fmtWhen = ts => new Date(ts).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
const weekStart = () => { const d = new Date(); const wd = (d.getDay() + 6) % 7; d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - wd); return d.getTime() };
const proj = id => D().projects.find(p => p.id === id);
const projName = id => (proj(id) || {}).name || "No project";
const projColour = id => (proj(id) || {}).colour || "#22c55e";
const prot = id => D().protocols.find(p => p.id === id);
const sampleBy = sid => D().samples.find(s => s.sampleId === sid && !s.deleted);
/* a button that asks for a second tap before it acts */
function confirmBtn(cls, label, confirmLabel, act) {
  const b = el("button", { class: cls, type: "button", text: label });
  b.onclick = async e => { e.stopPropagation(); if (b.dataset.c !== "1") { b.dataset.c = "1"; b.textContent = confirmLabel; b.classList.add("armed"); setTimeout(() => { if (b.isConnected) { b.dataset.c = ""; b.textContent = label; b.classList.remove("armed") } }, 4000); return } await act() };
  return b;
}
async function markDeleted(o, msg) { o.deleted = true; o.updated = Date.now(); await persist(); toast(msg) }
const isArchived = id => (proj(id) || {}).status === "Archived";
const openTasks = () => D().tasks.filter(t => !t.done && !t.deleted && !isArchived(t.projectId));
function taskEvent(t, what) { (t.history = t.history || []).push({ id: uid("h"), at: Date.now(), what }); t.updated = Date.now() }
function dueText(t) {
  if (t.done) return "Done"; if (!t.due) return "No date";
  const d = daysBetween(todayISO(), t.due);
  if (d < 0) return "Overdue by " + (-d) + (d === -1 ? " day" : " days"); if (d === 0) return "Due today"; if (d === 1) return "Due tomorrow"; return "Due " + fmtDay(t.due);
}
function prefixOf(p) { return (p && p.prefix) || (p ? p.name.replace(/[^A-Za-z]/g, "").slice(0, 3).toUpperCase() : "S") }
function nextSampleId(projectId) {
  const p = proj(projectId); const pre = prefixOf(p); let max = 0;
  for (const s of D().samples) { const m = String(s.sampleId || "").match(/^(.*)-(\d+)$/); if (m && m[1] === pre) max = Math.max(max, +m[2]) }
  return pre + "-" + String(max + 1).padStart(4, "0");
}
function num(v) { if (v == null || v === "") return NaN; return Number(String(v).replace(",", ".")) }
function derivedFor(fields, values) {
  const by = name => { const f = fields.find(f => f.label.trim().toLowerCase() === name); return f ? num(values[f.key]) : NaN };
  const m = by("mass"), d = by("diameter"), h = by("height"), f = by("breaking force"); const out = [];
  if (m > 0 && d > 0 && h > 0) out.push(["Density", (m / (Math.PI * (d / 20) ** 2 * (h / 10))).toFixed(2) + " g/cm³"]);
  if (d > 0 && f > 0) out.push(["Strength (F/A)", (f / (Math.PI * (d / 2) ** 2)).toFixed(2) + " MPa"]);
  return out;
}
function sheet(title, body) { const b = $("sheetBody"); b.replaceChildren(el("h2", { text: title }), body); $("sheet").hidden = false }
function closeSheet() { $("sheet").hidden = true; $("sheetBody").replaceChildren() }
$("sheet").addEventListener("click", e => { if (e.target === $("sheet")) closeSheet() });

/* ---------- photos ---------- */
async function compress(file, max = 1600, q = 0.82) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url });
    const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement("canvas"); c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    return await new Promise(res => c.toBlob(res, "image/jpeg", q));
  } finally { URL.revokeObjectURL(url) }
}
async function storePhoto(blob) {
  const id = uid("p"); const rec = await encBytes(await blob.arrayBuffer()); rec.type = "image/jpeg";
  await filePut(id, rec); D()._device = D()._device || {}; (D()._device.pendingImgs = D()._device.pendingImgs || []).push(id); return id;
}
async function photoURL(id) {
  let rec = await fileGet(id);
  if (!rec) { const cfg = syncCfg(); if (!cfg) return null; const f = await ghGetFile(cfg, "img/" + id + ".json"); if (!f) return null; const o = JSON.parse(f.text); rec = { iv: o.iv, ct: unb64(o.ct).buffer, type: o.type }; await filePut(id, rec) }
  const u = URL.createObjectURL(new Blob([await decBytes(rec)], { type: rec.type || "image/jpeg" })); S.urls.push(u); return u;
}
function photoGrid(ids) {
  const g = el("div", { class: "photos" });
  for (const id of ids) { const b = el("button", { type: "button", "aria-label": "Open photo" }); g.append(b); photoURL(id).then(u => { if (!u) { b.textContent = "…"; return } const im = el("img", { src: u, alt: "" }); b.append(im); b.onclick = () => { $("viewerImg").src = u; $("viewer").hidden = false } }).catch(() => b.textContent = "!") }
  return g;
}
$("viewerClose").addEventListener("click", () => { $("viewer").hidden = true });
function photoPicker(state) {
  const box = el("label", { class: "photo-pick" });
  const input = el("input", { type: "file", accept: "image/*", multiple: true });
  const label = el("span", { text: "📷  Tap to take or choose photos" }); const thumbs = el("div", { class: "thumbs" });
  input.addEventListener("change", async () => {
    label.textContent = "Preparing photos…";
    for (const f of input.files) { const blob = await compress(f); state.photos.push(blob); thumbs.append(el("img", { src: URL.createObjectURL(blob), alt: "" })) }
    input.value = ""; label.textContent = state.photos.length + (state.photos.length === 1 ? " photo" : " photos") + " · tap to add more";
  });
  box.append(input, label, thumbs); return box;
}

/* ---------- navigation ---------- */
function go(v, params = {}, root = false) { if (root) S.nav = [{ v, params }]; else S.nav.push({ v, params }); render() }
function back() { if (S.nav.length > 1) { S.nav.pop(); render() } }
$("backBtn").addEventListener("click", back);
document.querySelectorAll("#tabs button").forEach(b => b.addEventListener("click", () => {
  const t = b.dataset.tab; if (t === "capture") return go("capture", {}); go(t, {}, true);
}));
function render() {
  S.urls.forEach(u => URL.revokeObjectURL(u)); S.urls = [];
  const cur = S.nav[S.nav.length - 1]; const view = $("view"); view.replaceChildren();
  $("backBtn").hidden = S.nav.length < 2;
  const root = S.nav[0].v;
  document.querySelectorAll("#tabs button[data-tab]").forEach(b => b.dataset.tab !== "capture" && (b.toggleAttribute("aria-current", b.dataset.tab === root), b.dataset.tab === root ? b.setAttribute("aria-current", "page") : b.removeAttribute("aria-current")));
  (VIEWS[cur.v] || VIEWS.home)(view, cur.params || {});
  window.scrollTo(0, 0);
}
function setTitle(t, sub) { $("title").textContent = t; $("subtitle").textContent = sub || "" }

/* ---------- views ---------- */
const VIEWS = {};
VIEWS.home = view => {
  setTitle("LabDash", new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" }));
  const wk = weekStart(), t0 = todayISO();
  const open = openTasks(); const due7 = open.filter(t => t.due && daysBetween(t0, t.due) <= 7);
  const realSamples = D().samples.filter(s => !s.deleted);
  const sWeek = realSamples.filter(s => s.created >= wk).length;
  view.append(el("div", { class: "stats" },
    el("button", { class: "stat", type: "button", onclick: () => go("list", { kind: "open" }) }, el("b", { text: open.length }), el("span", { text: "open tasks" })),
    el("button", { class: "stat", type: "button", onclick: () => go("list", { kind: "due7" }) }, el("b", { class: due7.length ? "amber-t" : "", text: due7.length }), el("span", { text: "due in 7 days" })),
    el("button", { class: "stat", type: "button", onclick: () => go("list", { kind: "samplesWeek" }) }, el("b", { class: "green-t", text: sWeek }), el("span", { text: "samples this week" }))));
  const logW = D().log.filter(l => !l.deleted && l.when >= wk).length;
  const doneW = D().tasks.filter(t => t.done && t.completed && new Date(t.completed + "T12:00:00").getTime() >= wk).length;
  const overdue = open.filter(t => t.due && t.due < t0).length;
  view.append(el("button", { class: "card green stack tapcard2", type: "button", onclick: () => go("list", { kind: "week" }) }, el("div", { class: "eyebrow", text: "This week ›" }),
    el("div", { class: "big", text: logW + " log entries · " + sWeek + " samples made" }),
    el("div", { class: "muted small", text: doneW + " tasks done · " + overdue + " overdue" })));
  const dueCard = el("div", { class: "card" }, el("div", { class: "eyebrow", text: "Due soon" }));
  const list = el("div", { class: "list" });
  const soon = open.slice().sort((a, b) => (a.due || "9999").localeCompare(b.due || "9999")).slice(0, 5);
  soon.forEach(t => list.append(taskRow(t, true))); if (!soon.length) list.append(el("p", { class: "empty", text: "Nothing open. Add tasks from a project." }));
  dueCard.append(list); view.append(dueCard);
  const recent = el("div", { class: "card" }, el("div", { class: "eyebrow", text: "Recent" }));
  const items = [...D().log.filter(l => !l.deleted).map(l => ({ ts: l.when, kind: "log", l })), ...realSamples.map(s => ({ ts: s.created, kind: "s", s }))].sort((a, b) => b.ts - a.ts).slice(0, 6);
  const rl = el("div", { class: "list" });
  items.forEach(i => {
    if (i.kind === "s") rl.append(sampleRow(i.s));
    else rl.append(entryRow(i.l));
  });
  if (!items.length) rl.append(el("p", { class: "empty", text: "No entries yet. Tap + to log something." }));
  recent.append(rl);
  if (items.length) recent.append(el("button", { class: "link", type: "button", text: "See all activity", onclick: () => go("list", { kind: "activity" }) }));
  view.append(recent);
  if (!D().projects.length) view.append(el("div", { class: "card stack" }, el("div", { class: "big", text: "Bring your data in" }), el("p", { class: "muted small", text: "Import your LabDash Excel files from Settings, or add a project yourself." }), el("button", { class: "ghost", type: "button", onclick: () => go("settings", {}, true), text: "Go to Settings" })));
};
function sampleRow(s) {
  return el("button", { class: "item tapcard", style: "border:0;padding:10px 0;background:none", onclick: () => go("sample", { id: s.id }) }, el("span", { class: "mark", style: "background:" + projColour(s.projectId) }), el("div", { class: "grow" }, el("div", { class: "t green-t", text: s.sampleId }), el("div", { class: "m", text: ((prot(s.protocolId) || {}).name || s.protocolName || "Photo log") + " · " + projName(s.projectId) + " · " + fmtWhen(s.created) })));
}
function entryRow(l) {
  return el("button", { class: "item tapcard", style: "border:0;padding:10px 0;background:none", onclick: () => go("entry", { id: l.id }) }, el("span", { class: "mark", style: "background:" + projColour(l.projectId) }), el("div", { class: "grow" }, el("div", { class: "t", text: l.title }), el("div", { class: "m", text: projName(l.projectId) + " · " + fmtWhen(l.when) + (l.photos && l.photos.length ? " · 📷 " + l.photos.length : "") })));
}
VIEWS.entry = (view, { id }) => {
  const l = D().log.find(x => x.id === id && !x.deleted); if (!l) return back();
  setTitle(l.title, projName(l.projectId));
  view.append(logCard(l), el("button", { class: "ghost", type: "button", text: "Open project " + projName(l.projectId), onclick: () => go("project", { id: l.projectId, tab: "log" }) }));
};
VIEWS.list = (view, { kind }) => {
  const wk = weekStart(), t0 = todayISO(); const box = el("div", { class: "card list" });
  const byDue = (a, b) => (a.due || "9999").localeCompare(b.due || "9999");
  const empty = t => box.append(el("p", { class: "empty", text: t }));
  if (kind === "open" || kind === "due7") {
    let ts = openTasks().sort(byDue); if (kind === "due7") ts = ts.filter(t => t.due && daysBetween(t0, t.due) <= 7);
    setTitle(kind === "open" ? "Open tasks" : "Due in 7 days", ts.length + (ts.length === 1 ? " task" : " tasks") + " · tap a task to edit");
    ts.forEach(t => box.append(taskRow(t, true))); if (!ts.length) empty("Nothing here.");
    view.append(box);
  } else if (kind === "samplesWeek") {
    const ss = D().samples.filter(s => !s.deleted && s.created >= wk).sort((a, b) => b.created - a.created);
    setTitle("Samples this week", ss.length + " since Monday");
    ss.forEach(s => box.append(sampleRow(s))); if (!ss.length) empty("No samples yet this week.");
    view.append(box);
  } else if (kind === "week") {
    setTitle("This week", "Since Monday");
    const logs = D().log.filter(l => !l.deleted && l.when >= wk).sort((a, b) => b.when - a.when);
    const ss = D().samples.filter(s => !s.deleted && s.created >= wk).sort((a, b) => b.created - a.created);
    const done = D().tasks.filter(t => !t.deleted && t.done && t.completed && new Date(t.completed + "T12:00:00").getTime() >= wk);
    const late = openTasks().filter(t => t.due && t.due < t0).sort(byDue);
    [["Log entries", logs, entryRow], ["Samples made", ss, sampleRow], ["Tasks done", done, t => taskRow(t, true)], ["Overdue", late, t => taskRow(t, true)]].forEach(([h, arr, fn]) => {
      const c = el("div", { class: "card list" }, el("div", { class: "eyebrow", text: h + " (" + arr.length + ")" })); arr.forEach(x => c.append(fn(x))); if (!arr.length) c.append(el("p", { class: "empty", text: "None." })); view.append(c) });
  } else {
    setTitle("All activity", "Log entries and samples, newest first");
    const items = [...D().log.filter(l => !l.deleted).map(l => ({ ts: l.when, n: entryRow(l) })), ...D().samples.filter(s => !s.deleted).map(s => ({ ts: s.created, n: sampleRow(s) }))].sort((a, b) => b.ts - a.ts);
    items.slice(0, 200).forEach(i => box.append(i.n)); if (!items.length) empty("No activity yet.");
    view.append(box);
  }
};
function taskRow(t, showProject) {
  const row = el("div", { class: "item" + (t.done ? " done" : "") });
  const tick = el("button", { class: "tick" + (t.done ? " on" : ""), type: "button", "aria-label": t.done ? "Mark not done" : "Mark done", text: t.done ? "✓" : "" });
  tick.onclick = async () => { t.done = !t.done; t.completed = t.done ? todayISO() : ""; taskEvent(t, t.done ? "Done" : "Reopened"); await persist(); render() };
  const due = dueText(t); const late = !t.done && t.due && t.due < todayISO();
  row.append(tick, el("div", { class: "grow" }, el("div", { class: "t", text: t.title }), el("div", { class: "m " + (late ? "red-t" : ""), text: (showProject ? projName(t.projectId) + " · " : "") + due })));
  const body = row.querySelector(".grow"); body.classList.add("tap"); body.onclick = () => editTask(t);
  if (!showProject) row.append(confirmBtn("x-btn", "✕", "Delete?", async () => { taskEvent(t, "Deleted"); await markDeleted(t, "Task deleted"); render() }));
  return row;
}
VIEWS.projects = view => {
  const live = D().projects.filter(p => !p.deleted && p.status !== "Archived"), arch = D().projects.filter(p => !p.deleted && p.status === "Archived");
  setTitle("Projects", live.filter(p => p.status !== "Done").length + " active" + (arch.length ? " · " + arch.length + " archived" : ""));
  const list = el("div", { class: "stack" });
  live.forEach(p => {
    const open = openTasks().filter(t => t.projectId === p.id).length; const ns = D().samples.filter(s => s.projectId === p.id && !s.deleted).length;
    list.append(el("button", { class: "tapcard stack", type: "button", onclick: () => go("project", { id: p.id }) },
      el("div", { class: "row between" }, el("div", { class: "row grow" }, el("span", { class: "mark", style: "background:" + (p.colour || "#22c55e") + ";height:24px" }), el("span", { class: "big", text: p.name })), el("span", { class: "big green-t", text: (p.progress || 0) + "%" })),
      el("div", { class: "bar" }, el("i", { style: "width:" + Math.min(100, p.progress || 0) + "%" })),
      el("div", { class: "small", text: p.nextStep ? "Next: " + p.nextStep : "No next step set" }),
      el("div", { class: "muted small", text: open + (open === 1 ? " open task" : " open tasks") + " · " + ns + (ns === 1 ? " sample" : " samples") + (p.status && p.status !== "Active" ? " · " + p.status : "") })));
  });
  if (!live.length) list.append(el("p", { class: "empty", text: "No projects yet." }));
  list.append(el("button", { class: "ghost", type: "button", text: "+ Add a project", onclick: () => editProject(null) }));
  view.append(list);
  if (arch.length) {
    const open = !!S.showArchived; const box = el("div", { class: "card stack" });
    box.append(el("button", { class: "link", type: "button", style: "text-align:left;padding:0", text: (open ? "▾ " : "▸ ") + "Archived projects (" + arch.length + ")", onclick: () => { S.showArchived = !open; render() } }));
    if (open) arch.forEach(p => box.append(el("div", { class: "row between" }, el("button", { class: "link", type: "button", style: "color:var(--ink);text-decoration:none;text-align:left;padding:0", text: p.name, onclick: () => go("project", { id: p.id }) }),
      el("button", { class: "ghost", type: "button", style: "width:auto;padding:8px 14px", text: "Restore", onclick: async () => { p.status = p.prevStatus || "Active"; p.updated = Date.now(); await persist(); toast(p.name + " restored"); render() } }))));
    view.append(box);
  }
};
VIEWS.project = (view, { id, tab }) => {
  const p = proj(id); if (!p) return back();
  setTitle(p.name, p.summary || "");
  const card = el("div", { class: "card stack" }, el("div", { class: "row between" }, el("div", {}, el("div", { class: "eyebrow", text: "Progress" }), el("div", { style: "font-size:32px;font-weight:800", class: "green-t", text: (p.progress || 0) + "%" })),
    el("div", { class: "pm" }, el("button", { type: "button", text: "−1", onclick: () => bump(-1) }), el("button", { class: "plus", type: "button", text: "+1", onclick: () => bump(1) }))));
  const pct = card.querySelector(".green-t");
  const slider = el("input", { type: "range", min: "0", max: "100", step: "1", value: String(p.progress || 0), class: "range", "aria-label": "Progress" });
  slider.addEventListener("input", () => { pct.textContent = slider.value + "%" });
  slider.addEventListener("change", async () => { p.progress = +slider.value; p.updated = Date.now(); await persist(); toast("Progress " + p.progress + "%") });
  card.append(slider, el("p", { class: "fine", text: "Drag to set, or use −1 / +1." }));
  if (p.status === "Archived") card.prepend(el("div", { class: "badge", style: "justify-self:start;background:#3a2e12;color:var(--amber)", text: "ARCHIVED · hidden from Home, + and Lab" }));
  async function bump(n) { p.progress = Math.max(0, Math.min(100, (p.progress || 0) + n)); p.updated = Date.now(); await persist(); render() }
  const ns = el("input", { type: "text", value: p.nextStep || "", placeholder: "What's the next step?" });
  ns.addEventListener("change", async () => { p.nextStep = ns.value.trim(); p.updated = Date.now(); await persist(); toast("Next step saved") });
  view.append(card, el("div", { class: "stack" }, el("label", { text: "NEXT STEP" }), ns));
  const cur = tab || "tasks"; const seg = el("div", { class: "seg" });
  [["tasks", "Tasks"], ["log", "Log"], ["samples", "Samples"]].forEach(([k, l]) => seg.append(el("button", { type: "button", "aria-pressed": String(cur === k), text: l, onclick: () => { S.nav[S.nav.length - 1].params.tab = k; render() } })));
  view.append(seg);
  if (cur === "tasks") {
    const inp = el("input", { type: "text", placeholder: "Add a task" }); let dueSel = 7;
    const chips = el("div", { class: "chips" });
    [["Today", 0], ["Tomorrow", 1], ["1 week", 7], ["2 weeks", 14], ["No date", null]].forEach(([l, n]) => { const c = el("button", { class: "chip", type: "button", "aria-pressed": String(n === dueSel), text: l }); c.onclick = () => { dueSel = n; chips.querySelectorAll(".chip").forEach(x => x.setAttribute("aria-pressed", String(x === c))) }; chips.append(c) });
    const add = el("button", { class: "primary", type: "button", text: "Add" });
    add.onclick = async () => { const v = inp.value.trim(); if (!v) return inp.focus(); const nt = { id: uid("t"), projectId: p.id, title: v, due: dueSel == null ? "" : addDays(todayISO(), dueSel), done: false, completed: "", priority: "Normal", notes: "", created: Date.now(), history: [] }; taskEvent(nt, "Created" + (nt.due ? ", due " + nt.due : "")); D().tasks.push(nt); await persist(); render(); toast("Task added") };
    view.append(el("div", { class: "card stack" }, el("div", { class: "inline" }, inp, add), chips));
    const list = el("div", { class: "card list" });
    const ts = D().tasks.filter(t => t.projectId === p.id && !t.deleted).sort((a, b) => (a.done - b.done) || (a.due || "9999").localeCompare(b.due || "9999"));
    ts.forEach(t => list.append(taskRow(t, false))); if (!ts.length) list.append(el("p", { class: "empty", text: "No tasks yet." }));
    view.append(list);
  } else if (cur === "log") {
    view.append(el("button", { class: "ghost", type: "button", text: "+ Log entry or photo", onclick: () => go("capture", { projectId: p.id }) }));
    const ls = D().log.filter(l => l.projectId === p.id && !l.deleted).sort((a, b) => b.when - a.when);
    ls.forEach(l => view.append(logCard(l))); if (!ls.length) view.append(el("p", { class: "empty", text: "No entries yet." }));
  } else {
    view.append(el("button", { class: "ghost", type: "button", text: "Open Lab mode", onclick: () => go("lab", {}, true) }));
    const ss = D().samples.filter(s => s.projectId === p.id && !s.deleted).sort((a, b) => b.created - a.created);
    const list = el("div", { class: "stack" });
    ss.forEach(s => list.append(el("button", { class: "tapcard", type: "button", onclick: () => go("sample", { id: s.id }) }, el("div", { class: "row between" }, el("span", { class: "big green-t", text: s.sampleId }), el("span", { class: "small", text: s.location || "No location" })), el("div", { class: "muted small", text: ((prot(s.protocolId) || {}).name || s.protocolName || "Photo log") + " · " + fmtWhen(s.created) }))));
    if (!ss.length) list.append(el("p", { class: "empty", text: "No samples yet." }));
    view.append(list);
  }
  view.append(el("button", { class: "link", type: "button", text: "Edit project details", onclick: () => editProject(p) }));
  if (p.status === "Archived") view.append(el("button", { class: "ghost", type: "button", text: "Restore project", onclick: async () => { p.status = p.prevStatus || "Active"; p.updated = Date.now(); await persist(); toast(p.name + " restored"); render() } }));
  else view.append(confirmBtn("danger", "Archive project", "Tap again to archive", async () => { p.prevStatus = p.status || "Active"; p.status = "Archived"; p.updated = Date.now(); await persist(); toast(p.name + " archived. Restore it from Projects."); go("projects", {}, true) }));
};
function editTask(t) {
  const title = el("input", { type: "text", value: t.title });
  const due = el("input", { type: "date", value: t.due || "" });
  const prio = el("select", {}, ...["Low", "Normal", "High"].map(v => el("option", { value: v, selected: (t.priority || "Normal") === v, text: v })));
  const pj = el("select", {}, ...D().projects.filter(p => !p.deleted).map(p => el("option", { value: p.id, selected: p.id === t.projectId, text: p.name })));
  const notes = el("textarea", { placeholder: "Notes" }); notes.value = t.notes || "";
  const done = el("input", { type: "checkbox" }); done.checked = !!t.done;
  const hist = el("div", { class: "stack" });
  (t.history || []).slice().sort((a, b) => b.at - a.at).slice(0, 8).forEach(h => hist.append(el("div", { class: "fine", text: fmtWhen(h.at) + " · " + h.what })));
  const body = el("div", { class: "stack" }, el("label", { text: "Task" }), title, el("label", { text: "Due date" }), due,
    el("label", { text: "Priority" }), prio, el("label", { text: "Project" }), pj, el("label", { text: "Notes" }), notes,
    el("label", { class: "check" }, done, " Done"),
    el("button", { class: "primary", type: "button", text: "Save", onclick: async () => {
      const v = title.value.trim(); if (!v) return title.focus(); const ch = [];
      if (v !== t.title) ch.push("renamed"); if (due.value !== (t.due || "")) ch.push(due.value ? "due " + due.value : "due date removed");
      if (prio.value !== (t.priority || "Normal")) ch.push("priority " + prio.value); if (pj.value !== t.projectId) ch.push("moved to " + projName(pj.value));
      if (notes.value.trim() !== (t.notes || "")) ch.push("notes edited");
      Object.assign(t, { title: v, due: due.value, priority: prio.value, projectId: pj.value, notes: notes.value.trim() });
      if (done.checked !== !!t.done) { t.done = done.checked; t.completed = t.done ? todayISO() : ""; ch.push(t.done ? "marked done" : "reopened") }
      if (ch.length) taskEvent(t, "Edited: " + ch.join(", "));
      await persist(); closeSheet(); render(); toast("Task saved") } }),
    confirmBtn("danger", "Delete task", "Tap again to delete", async () => { taskEvent(t, "Deleted"); await markDeleted(t, "Task deleted"); closeSheet(); render() }),
    el("button", { class: "link", type: "button", text: "Cancel", onclick: closeSheet }));
  if (hist.childNodes.length) body.append(el("div", { class: "eyebrow", text: "History" }), hist);
  sheet("Edit task", body);
}
function logCard(l) {
  const c = el("div", { class: "card stack" }, el("div", { class: "row between" }, el("span", { class: "big", text: l.title }), l.sampleId ? el("button", { class: "badge", type: "button", style: "border:0", text: l.sampleId, onclick: () => { const s = sampleBy(l.sampleId); if (s) go("sample", { id: s.id }) } }) : null),
    el("div", { class: "muted small", text: fmtWhen(l.when) + " · " + projName(l.projectId) }));
  if (l.note) c.append(el("p", { class: "small", text: l.note }));
  if (l.photos && l.photos.length) c.append(photoGrid(l.photos));
  if (l.onedrivePath) c.append(el("p", { class: "fine", text: "Photo in OneDrive: " + l.onedrivePath }));
  c.append(el("div", { class: "row", style: "justify-content:flex-end" }, confirmBtn("link del", "Delete entry", "Tap again to delete", async () => { await markDeleted(l, "Entry deleted"); render() })));
  return c;
}
VIEWS.sample = (view, { id }) => {
  const s = D().samples.find(x => x.id === id); if (!s) return back();
  const pr = prot(s.protocolId);
  setTitle(s.sampleId, ((pr || {}).name || s.protocolName || "Photo log") + " · " + projName(s.projectId));
  const loc = el("div", { class: "chips" });
  D().locations.forEach(L => { const c = el("button", { class: "chip", type: "button", "aria-pressed": String(s.location === L.name), text: L.name }); c.onclick = async () => { s.location = L.name; s.updated = Date.now(); await persist(); toast("Moved to " + L.name); render() }; loc.append(c) });
  view.append(el("div", { class: "card stack" }, el("div", { class: "eyebrow", text: "Stored at" }), el("div", { class: "big", text: s.location || "Not set" }), loc));
  const vals = el("div", { class: "card" }, el("div", { class: "eyebrow", text: "Measurements" }));
  const fields = pr ? pr.fields.slice().sort((a, b) => a.step - b.step) : Object.keys(s.values || {}).map(k => ({ key: k, label: k, unit: "" }));
  let any = false;
  fields.forEach(f => { const v = (s.values || {})[f.key]; if (v === undefined || v === "") return; any = true; vals.append(el("div", { class: "kv" }, el("span", { text: f.label }), el("span", { text: v + (f.unit ? " " + f.unit : "") }))) });
  derivedFor(fields, s.values || {}).forEach(([k, v]) => { any = true; vals.append(el("div", { class: "kv" }, el("span", { text: k }), el("span", { class: "green-t", text: v }))) });
  if (!any) vals.append(el("p", { class: "empty", text: "No measurements recorded." }));
  view.append(vals);
  const logs = D().log.filter(l => l.sampleId === s.sampleId && !l.deleted).sort((a, b) => b.when - a.when);
  const ph = logs.flatMap(l => l.photos || []);
  const pc = el("div", { class: "card stack" }, el("div", { class: "eyebrow", text: "Photos" }));
  if (ph.length) pc.append(photoGrid(ph)); else pc.append(el("p", { class: "empty", text: "No photos yet." }));
  pc.append(el("button", { class: "ghost", type: "button", text: "+ Add photo or note to " + s.sampleId, onclick: () => go("capture", { projectId: s.projectId, sampleId: s.sampleId }) }));
  view.append(pc);
  if (s.notes) view.append(el("div", { class: "card stack" }, el("div", { class: "eyebrow", text: "Notes" }), el("p", { text: s.notes })));
  view.append(el("p", { class: "fine", text: "Created " + fmtWhen(s.created) }));
  view.append(confirmBtn("danger", "Delete sample " + s.sampleId, "Tap again to delete " + s.sampleId, async () => { await markDeleted(s, s.sampleId + " deleted"); back() }));
  view.append(el("p", { class: "fine", text: "Deleting removes the sample and its measurements. Photo entries for it stay in the project log." }));
};
VIEWS.capture = (view, params) => {
  setTitle("New log entry", "Notes, photos and samples");
  const st = { projectId: params.projectId || "", photos: [] };
  const chips = el("div", { class: "chips" });
  const sid = el("input", { type: "text", placeholder: "Pick a project to number it", autocapitalize: "characters" });
  let manual = !!params.sampleId; if (params.sampleId) sid.value = params.sampleId;
  let mode = params.sampleId ? "sample" : (S.capMode || "sample");
  const refreshId = () => { if (!manual) sid.value = st.projectId ? nextSampleId(st.projectId) : "" };
  const modeSeg = el("div", { class: "seg" }); const sampleBox = el("div", { class: "stack" });
  const setMode = m => { mode = m; S.capMode = m; sampleBox.hidden = m !== "sample"; modeSeg.querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.m === m))) };
  [["sample", "Sample"], ["none", "Not a sample"]].forEach(([m, l]) => modeSeg.append(el("button", { type: "button", "data-m": m, text: l, onclick: () => setMode(m) })));
  sid.addEventListener("input", () => manual = true);
  D().projects.filter(p => !p.deleted && p.status !== "Done" && p.status !== "Archived").forEach(p => { const c = el("button", { class: "chip", type: "button", "aria-pressed": String(p.id === st.projectId), text: p.name }); c.onclick = () => { st.projectId = p.id; chips.querySelectorAll(".chip").forEach(x => x.setAttribute("aria-pressed", String(x === c))); refreshId(); upd() }; chips.append(c) });
  const auto = el("button", { class: "ghost", type: "button", text: "Auto" }); auto.onclick = () => { manual = false; refreshId() };
  const title = el("input", { type: "text", placeholder: "Title, e.g. Batch 3 after curing" });
  const note = el("textarea", { placeholder: "Notes" });
  const save = el("button", { class: "primary", type: "button" });
  const upd = () => { save.disabled = !st.projectId; save.textContent = st.projectId ? "Save entry" : "Pick a project first" };
  refreshId(); upd();
  save.onclick = async () => {
    if (!st.projectId) return; save.disabled = true; save.textContent = "Saving…";
    const s = mode === "sample" ? sid.value.trim() : ""; const photos = [];
    for (const b of st.photos) photos.push(await storePhoto(b));
    if (s && !sampleBy(s)) D().samples.push({ id: uid("s"), sampleId: s, projectId: st.projectId, protocolId: "", protocolName: "Photo log", created: Date.now(), location: "", status: "Logged", notes: note.value.trim(), values: {}, updated: Date.now() });
    D().log.push({ id: uid("g"), when: Date.now(), projectId: st.projectId, title: title.value.trim() || s || "Untitled", note: note.value.trim(), sampleId: s, photos, updated: Date.now() });
    await persist(); toast("Saved" + (s ? " as " + s : "")); back();
  };
  view.append(el("div", { class: "stack" }, el("label", { text: "PROJECT" }), chips),
    modeSeg, sampleBox,
    photoPicker(st), title, note, el("div", { class: "sticky-save" }, save));
  sampleBox.append(el("label", { text: "SAMPLE ID" }), el("div", { class: "inline" }, sid, auto), el("p", { class: "fine", text: "Numbered automatically for the project. Type over it to name it yourself." }));
  setMode(mode);
};
VIEWS.lab = view => {
  setTitle("Lab mode", "Pick a protocol to log samples against");
  const list = el("div", { class: "stack" });
  D().protocols.filter(p => !p.deleted && !isArchived(p.projectId)).forEach(p => list.append(el("button", { class: "tapcard stack", type: "button", onclick: () => go("run", { id: p.id }) },
    el("div", { class: "row" }, el("span", { class: "mark", style: "background:var(--green);height:22px" }), el("span", { class: "big", text: p.name })),
    el("div", { class: "green-t small", text: projName(p.projectId) + " · " + p.fields.length + " fields" }), p.description ? el("div", { class: "muted small", text: p.description }) : null)));
  if (!D().protocols.length) list.append(el("div", { class: "card stack" }, el("p", { class: "muted", text: "No protocols yet. Import your Excel files in Settings, or send Claude a protocol document and paste what it gives you into Settings → Add a protocol." })));
  view.append(list);
};
VIEWS.run = (view, { id }) => {
  const p = prot(id); if (!p) return back();
  const fields = p.fields.slice().sort((a, b) => a.step - b.step);
  S.runKeep = S.runKeep && S.runKeep.protocol === p.id ? S.runKeep : { protocol: p.id, values: {}, count: 0, location: "" };
  const K = S.runKeep; const vals = {}; fields.forEach(f => { if (f.keep && K.values[f.key] != null) vals[f.key] = K.values[f.key] });
  setTitle(p.name, projName(p.projectId) + " · " + K.count + " saved this session");
  const top = el("div", { class: "stack" });
  if (p.docLink) top.append(el("a", { class: "link", href: p.docLink, target: "_blank", rel: "noopener", text: "Open protocol document ↗" }));
  const sid = el("input", { type: "text", value: nextSampleId(p.projectId), autocapitalize: "characters", style: "font-size:20px;font-weight:700" });
  const auto = el("button", { class: "ghost", type: "button", text: "Auto", onclick: () => sid.value = nextSampleId(p.projectId) });
  const loc = el("div", { class: "chips" });
  D().locations.forEach(L => { const c = el("button", { class: "chip", type: "button", "aria-pressed": String(K.location === L.name), text: L.name }); c.onclick = () => { K.location = K.location === L.name ? "" : L.name; loc.querySelectorAll(".chip").forEach(x => x.setAttribute("aria-pressed", String(x.textContent === K.location))) }; loc.append(c) });
  top.append(el("label", { text: "SAMPLE ID" }), el("div", { class: "inline" }, sid, auto), el("label", { text: "STORED AT" }), loc);
  view.append(top);
  const form = el("div", { class: "card" }); const derived = el("div", { class: "derived" });
  const recalc = () => { derived.textContent = derivedFor(fields, vals).map(([k, v]) => k + " " + v).join("   ·   ") };
  fields.forEach(f => {
    const box = el("div", { class: "field" }, el("div", { class: "lab" }, el("span", {}, f.label + (f.unit ? " (" + f.unit + ")" : ""), f.required ? el("span", { class: "req", text: " *" }) : null), el("small", { text: f.section || "" })));
    if (f.hint || f.keep) box.append(el("div", { class: "hint2", text: [f.hint, f.keep ? "kept for the next sample" : ""].filter(Boolean).join(" · ") }));
    if (f.type === "Choice" || f.type === "Check") {
      const opts = f.type === "Check" ? ["Done"] : f.options; const ch = el("div", { class: "chips" });
      opts.forEach(o => { const c = el("button", { class: "chip", type: "button", "aria-pressed": String(vals[f.key] === o), text: o }); c.onclick = () => { vals[f.key] = vals[f.key] === o ? "" : o; ch.querySelectorAll(".chip").forEach(x => x.setAttribute("aria-pressed", String(x.textContent === vals[f.key]))) }; ch.append(c) });
      box.append(ch);
    } else {
      const inp = el("input", { type: "text", inputmode: f.type === "Number" ? "decimal" : "text", placeholder: f.type === "Number" ? "0.00" : "", value: vals[f.key] != null ? vals[f.key] : "" });
      inp.addEventListener("input", () => { vals[f.key] = inp.value.trim(); recalc() }); box.append(inp);
    }
    form.append(box);
  });
  recalc(); view.append(form, derived);
  const st = { photos: [] }; const notes = el("textarea", { placeholder: "Notes for this sample", style: "min-height:80px" });
  view.append(photoPicker(st), notes);
  const save = el("button", { class: "primary", type: "button" }); const label = () => save.textContent = "Save " + (sid.value.trim() || "sample"); label(); sid.addEventListener("input", label);
  save.onclick = async () => {
    const s = sid.value.trim(); if (!s) return toast("Give the sample an ID first", true);
    const missing = fields.filter(f => f.required && !vals[f.key]); if (missing.length) return toast(missing.length + (missing.length === 1 ? " required field is" : " required fields are") + " empty: " + missing.map(f => f.label).join(", "), true);
    if (sampleBy(s)) return toast(s + " already exists. Change the ID.", true);
    for (const f of fields) if (f.type === "Number" && vals[f.key] && isNaN(num(vals[f.key]))) return toast(f.label + " isn't a number.", true);
    save.disabled = true; save.textContent = "Saving…";
    const clean = {}; fields.forEach(f => { if (vals[f.key] != null && vals[f.key] !== "") clean[f.key] = f.type === "Number" ? num(vals[f.key]) : vals[f.key] });
    D().samples.push({ id: uid("s"), sampleId: s, projectId: p.projectId, protocolId: p.id, protocolName: p.name, created: Date.now(), location: K.location, status: "Made", notes: notes.value.trim(), values: clean, updated: Date.now() });
    if (st.photos.length) { const ids = []; for (const b of st.photos) ids.push(await storePhoto(b)); D().log.push({ id: uid("g"), when: Date.now(), projectId: p.projectId, title: s + " · " + p.name, note: notes.value.trim(), sampleId: s, photos: ids, updated: Date.now() }) }
    K.count++; K.values = {}; fields.forEach(f => { if (f.keep && vals[f.key]) K.values[f.key] = vals[f.key] });
    await persist(); toast("Saved " + s); render();
  };
  view.append(el("div", { class: "sticky-save" }, save));
};
VIEWS.settings = view => {
  setTitle("Settings", "Sync, import and protocols");
  const c = syncCfg();
  const sync = el("div", { class: "card stack" }, el("div", { class: "eyebrow", text: "Sync" }));
  if (c) {
    sync.append(el("p", { class: "small", text: "Syncing with " + c.repo + ". " + (c.last ? "Last synced " + fmtWhen(c.last) + "." : "Not synced yet.") }), c.error ? el("p", { class: "hint err", text: c.error }) : null,
      el("button", { class: "primary", type: "button", text: "Sync now", onclick: () => syncNow(true) }),
      el("button", { class: "danger", type: "button", text: "Disconnect this device", onclick: async e => { if (e.target.dataset.c !== "1") { e.target.dataset.c = "1"; e.target.textContent = "Tap again to disconnect"; return } delete D()._device.sync; delete D()._device.base; await persist(); render() } }));
  } else {
    const repo = el("input", { type: "text", placeholder: "your-username/LabDash-data", autocapitalize: "off" }); const tok = el("input", { type: "password", placeholder: "Fine-grained access token" }); const h = el("p", { class: "hint" });
    const btn = el("button", { class: "primary", type: "button", text: "Connect" });
    btn.onclick = async () => { h.className = "hint"; h.textContent = "Checking the repository…"; const r = cleanRepo(repo.value), t = tok.value.trim();
      try { const info = await gh({ repo: r, token: t }, "GET", ""); if (!info) throw Object.assign(new Error("x"), { status: 404 }); if (!info.private) throw new Error("public");
        D()._device = D()._device || {}; D()._device.sync = { repo: r, token: t, branch: info.default_branch || "main" }; delete D()._device.base; await persist(); await syncNow(true); render();
      } catch (e) { h.className = "hint err"; h.textContent = syncError(e) } };
    sync.append(el("p", { class: "muted small", text: "Keeps your phone and laptop in step through a private GitHub repository. Everything is encrypted here before upload." }), el("label", { text: "Private repository" }), repo, el("label", { text: "Access token (Contents: read and write, this repository only)" }), tok, btn, h);
  }
  view.append(sync);
  // import
  const imp = el("div", { class: "card stack" }, el("div", { class: "eyebrow", text: "Import from Excel" }), el("p", { class: "muted small", text: "Pick LabDash.xlsx and LabDashSamples.xlsx together. Projects, tasks, the log, protocols, samples, measurements and storage locations come across. Running it again updates matching items rather than duplicating them." }));
  const fin = el("input", { type: "file", accept: ".xlsx", multiple: true }); const ih = el("p", { class: "hint imp-hint" });
  fin.addEventListener("change", async () => { ih.className = "hint"; ih.textContent = "Reading…"; try { const r = await importExcel(fin.files); await persist(); render(); toast(r); const h2 = $("view").querySelector(".imp-hint"); if (h2) { h2.className = "hint ok imp-hint"; h2.textContent = r } } catch (e) { ih.className = "hint err"; ih.textContent = "Couldn't read that file: " + e.message } fin.value = "" });
  imp.append(fin, ih); view.append(imp);
  // protocols
  const pc = el("div", { class: "card stack" }, el("div", { class: "eyebrow", text: "Protocols" }));
  D().protocols.filter(p => !p.deleted).forEach(p => pc.append(el("div", { class: "row between" }, el("span", { class: "small", text: p.name + " (" + p.fields.length + " fields)" }), el("button", { class: "link", type: "button", text: "Remove", onclick: async e => { if (e.target.dataset.c !== "1") { e.target.dataset.c = "1"; e.target.textContent = "Tap again"; return } p.deleted = true; p.updated = Date.now(); await persist(); render() } }))));
  pc.append(el("button", { class: "ghost", type: "button", text: "+ Add a protocol from Claude", onclick: addProtocolSheet }));
  view.append(pc);
  // locations
  const lc = el("div", { class: "card stack" }, el("div", { class: "eyebrow", text: "Storage locations" }), el("p", { class: "small", text: D().locations.map(l => l.name).join(" · ") }));
  const ln = el("input", { type: "text", placeholder: "Add a location" });
  lc.append(el("div", { class: "inline" }, ln, el("button", { class: "ghost", type: "button", text: "Add", onclick: async () => { const v = ln.value.trim(); if (!v) return; D().locations.push({ id: uid("l"), name: v }); await persist(); render() } })));
  view.append(lc);
  // security
  view.append(el("div", { class: "card stack" }, el("div", { class: "eyebrow", text: "Security" }),
    el("button", { class: "ghost", type: "button", text: "Lock now", onclick: async () => { await rememberDevice(false); location.reload() } }),
    el("button", { class: "ghost", type: "button", text: "Download an encrypted backup", onclick: async () => { const rec = await sealObj(stripDevice(D())); const a = el("a", { href: URL.createObjectURL(new Blob([JSON.stringify(rec)], { type: "application/json" })), download: "labdash-backup-" + todayISO() + ".json" }); a.click() } }),
    el("p", { class: "fine", text: "The backup opens with your passphrase. Photos are kept in the synced repository." })));
  view.append(el("div", { class: "card stack" }, el("div", { class: "eyebrow", text: "App version" }), el("div", { class: "big", text: "v" + APP_VERSION }), el("p", { class: "muted small", text: "Latest changes: " + WHATS_NEW }),
    el("button", { class: "ghost", type: "button", text: "Check for updates", onclick: forceUpdate }), el("p", { class: "fine", text: "Reloads the newest app code. Your data stays on this device." })));
};
function editProject(p) {
  const isNew = !p; p = p || { id: uid("j"), name: "", summary: "", status: "Active", progress: 0, nextStep: "", folder: "", keywords: "", colour: "#22c55e", prefix: "" };
  const f = {}; const body = el("div", { class: "stack" });
  [["name", "Name"], ["summary", "Summary"], ["prefix", "Sample ID prefix (e.g. PEL)"], ["folder", "OneDrive folder for photos (e.g. /LabDash/My project)"], ["keywords", "Keywords"], ["colour", "Colour (hex)"]].forEach(([k, l]) => { f[k] = el("input", { type: "text", value: p[k] || "" }); body.append(el("label", { text: l }), f[k]) });
  const status = el("select", {}, ...["Active", "Paused", "Writing up", "Done", "Archived"].map(s => el("option", { value: s, selected: p.status === s, text: s }))); body.append(el("label", { text: "Status" }), status);
  body.append(el("button", { class: "primary", type: "button", text: isNew ? "Add project" : "Save", onclick: async () => { if (!f.name.value.trim()) return f.name.focus(); for (const k in f) p[k] = f[k].value.trim(); p.prefix = p.prefix.toUpperCase(); p.status = status.value; p.updated = Date.now(); if (isNew) D().projects.push(p); await persist(); closeSheet(); render() } }),
    el("button", { class: "link", type: "button", text: "Cancel", onclick: closeSheet }));
  sheet(isNew ? "New project" : "Edit project", body);
}
function addProtocolSheet() {
  const ta = el("textarea", { placeholder: "Paste the protocol text from Claude here", style: "min-height:200px;font-family:ui-monospace,monospace;font-size:13px" }); const h = el("p", { class: "hint" });
  const body = el("div", { class: "stack" }, el("p", { class: "muted small", text: "Send Claude your protocol document and ask for a LabDash protocol. Paste the result here." }), ta,
    el("button", { class: "primary", type: "button", text: "Add protocol", onclick: async () => {
      try { const o = JSON.parse(ta.value); const pr = protocolFromJson(o); const ex = D().protocols.find(x => x.name === pr.name && !x.deleted); if (ex) { pr.id = ex.id; Object.assign(ex, pr) } else D().protocols.push(pr); await persist(); closeSheet(); toast("Protocol added"); render() }
      catch (e) { h.className = "hint err"; h.textContent = "That doesn't look like a LabDash protocol: " + e.message } } }), h, el("button", { class: "link", type: "button", text: "Cancel", onclick: closeSheet }));
  sheet("Add a protocol", body);
}
function protocolFromJson(o) {
  if (!o || !o.name || !Array.isArray(o.fields)) throw new Error("needs a name and a list of fields");
  const pj = D().projects.find(p => p.name.toLowerCase() === String(o.project || "").toLowerCase());
  return { id: uid("r"), name: String(o.name), projectId: pj ? pj.id : "", description: o.description || "", docLink: o.docLink || "", updated: Date.now(),
    fields: o.fields.map((f, i) => ({ key: f.key || slug(f.label || f.field || "field" + i), step: f.step || i + 1, section: f.section || "", label: String(f.label || f.field), type: ["Number", "Text", "Choice", "Check"].includes(f.type) ? f.type : "Text", unit: f.unit || "", options: Array.isArray(f.options) ? f.options : String(f.options || "").split(";").map(s => s.trim()).filter(Boolean), required: !!f.required && String(f.required).toLowerCase() !== "no", keep: !!f.keep && String(f.keep).toLowerCase() !== "no", hint: f.hint || "" })) };
}
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "f";

/* ---------- Excel import ---------- */
function rows(wb, name) { const n = wb.SheetNames.find(s => s.toLowerCase() === name.toLowerCase()); return n ? XLSX.utils.sheet_to_json(wb.Sheets[n], { defval: "", raw: true }) : null }
function xDate(v) { if (v === "" || v == null) return ""; if (typeof v === "number") { const d = XLSX.SSF.parse_date_code(v); return d.y + "-" + pad(d.m) + "-" + pad(d.d) } const d = new Date(v); return isNaN(d) ? "" : d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) }
function xTime(v) { if (typeof v === "number") { const d = XLSX.SSF.parse_date_code(v); return new Date(d.y, d.m - 1, d.d, d.H, d.M, Math.floor(d.S)).getTime() } const d = new Date(v); return isNaN(d) ? Date.now() : d.getTime() }
const truthy = v => v === true || String(v).toLowerCase() === "true" || String(v).toLowerCase() === "yes";
async function importExcel(files) {
  if (typeof XLSX === "undefined") throw new Error("the Excel reader hasn't loaded yet, try again");
  const n = { projects: 0, tasks: 0, log: 0, protocols: 0, samples: 0, locations: 0 }; const books = [];
  for (const f of files) books.push(XLSX.read(await f.arrayBuffer(), { type: "array" }));
  const byName = name => D().projects.find(p => p.name.toLowerCase() === String(name).trim().toLowerCase());
  for (const wb of books) for (const r of rows(wb, "Projects") || []) { if (!r.Project) continue; let p = byName(r.Project); if (!p) { p = { id: uid("j") }; D().projects.push(p) }
    Object.assign(p, { name: String(r.Project).trim(), summary: r.Summary || "", status: r.Status || "Active", progress: Number(r.Progress) || 0, nextStep: r.NextStep || "", folder: r.Folder || "", keywords: r.Keywords || "", colour: r.Colour || "#22c55e", prefix: String(r.Prefix || "").toUpperCase(), updated: Date.now() }); n.projects++ }
  for (const wb of books) for (const r of rows(wb, "Locations") || []) { const v = String(r.Location || "").trim(); if (v && !D().locations.some(l => l.name === v)) { D().locations.push({ id: uid("l"), name: v }); n.locations++ } }
  for (const wb of books) for (const r of rows(wb, "Tasks") || []) { if (!r.Task || /^example/i.test(r.Task)) continue; const p = byName(r.Project); const ex = D().tasks.find(t => t.title === r.Task && t.projectId === (p && p.id));
    const t = ex || { id: uid("t") }; Object.assign(t, { projectId: p ? p.id : "", title: String(r.Task), due: xDate(r.Due), done: truthy(r.Done), completed: xDate(r.Completed) || (truthy(r.Done) ? todayISO() : ""), priority: r.Priority || "Normal", notes: r.Notes || "", updated: Date.now() }); if (!ex) D().tasks.push(t); n.tasks++ }
  for (const wb of books) { const pr = rows(wb, "Protocols"), pf = rows(wb, "ProtocolFields"); if (!pr || !pf) continue;
    for (const r of pr) { if (!r.Protocol) continue; const p = byName(r.Project); let x = D().protocols.find(q => q.name === r.Protocol && !q.deleted); if (!x) { x = { id: uid("r") }; D().protocols.push(x) }
      Object.assign(x, { name: String(r.Protocol), projectId: p ? p.id : "", description: r.Description || "", docLink: r.DocLink || "", updated: Date.now(),
        fields: pf.filter(f => f.Protocol === r.Protocol && f.Field).map(f => ({ key: slug(f.Field), step: Number(f.Step) || 0, section: f.Section || "", label: String(f.Field), type: ["Number", "Text", "Choice", "Check"].includes(f.Type) ? f.Type : "Text", unit: f.Unit || "", options: String(f.Options || "").split(";").map(s => s.trim()).filter(Boolean), required: truthy(f.Required), keep: truthy(f.Keep), hint: f.Hint || "" })) }); n.protocols++ } }
  for (const wb of books) { const sr = rows(wb, "Samples"); if (!sr) continue; const mr = rows(wb, "Measurements") || [];
    for (const r of sr) { const sid = String(r.SampleID || "").trim(); if (!sid || /^EX-/i.test(sid)) continue; const p = byName(r.Project); const pr = D().protocols.find(q => q.name === r.Protocol && !q.deleted);
      let s = sampleBy(sid); if (!s) { s = { id: uid("s"), values: {} }; D().samples.push(s) }
      Object.assign(s, { sampleId: sid, projectId: p ? p.id : "", protocolId: pr ? pr.id : "", protocolName: r.Protocol || "", created: xTime(r.Created), location: r.Location || "", status: r.Status || "", notes: r.Notes || "", updated: Date.now() });
      for (const m of mr.filter(m => m.SampleID === sid)) { const key = pr ? ((pr.fields.find(f => f.label === m.Field) || {}).key || slug(m.Field)) : slug(m.Field); s.values[key] = m.ValueNum !== "" && m.ValueNum != null ? Number(m.ValueNum) : m.ValueText }
      n.samples++ } }
  for (const wb of books) for (const r of rows(wb, "Log") || []) { if (!r.Title || /^example/i.test(r.Title)) continue; const p = byName(r.Project); const when = xTime(r.Logged);
    if (D().log.some(l => l.title === r.Title && Math.abs(l.when - when) < 60000)) continue;
    D().log.push({ id: uid("g"), when, projectId: p ? p.id : "", title: String(r.Title), note: r.Note || "", sampleId: r.Sample || "", photos: [], onedrivePath: typeof r.Photo === "string" ? r.Photo : "", updated: Date.now() }); n.log++ }
  const parts = Object.entries(n).filter(([, v]) => v).map(([k, v]) => v + " " + k);
  return parts.length ? "Imported " + parts.join(", ") + "." : "Nothing to import found in those files.";
}

/* ---------- sync through a private GitHub repository ---------- */
let syncT = null, inSync = false;
const syncCfg = () => (S.docs && S.docs._device && S.docs._device.sync) || null;
const cleanRepo = v => String(v).trim().replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "").replace(/\/$/, "");
function stripDevice(d) { const o = Object.assign({}, d); delete o._device; return o }
function syncSoon(ms) { clearTimeout(syncT); if (S.key && syncCfg()) syncT = setTimeout(() => syncNow(false), ms) }
document.addEventListener("visibilitychange", () => { if (!document.hidden && S.key) syncSoon(400) });
addEventListener("online", () => syncSoon(400));
async function gh(cfg, method, path, body) {
  const r = await fetch("https://api.github.com/repos/" + cfg.repo + path, { method, cache: "no-store", referrerPolicy: "no-referrer", credentials: "omit",
    headers: Object.assign({ Authorization: "Bearer " + cfg.token, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" }, body ? { "Content-Type": "application/json" } : {}), body: body ? JSON.stringify(body) : undefined });
  if (r.status === 404 && method === "GET") return null;
  if (!r.ok) { const e = new Error("github " + r.status); e.status = r.status; throw e }
  return r.status === 204 ? null : r.json();
}
async function ghGetFile(cfg, path) {
  const j = await gh(cfg, "GET", "/contents/" + path); if (!j) return null; let c = j.content;
  if (!c || j.encoding === "none") { const bl = await gh(cfg, "GET", "/git/blobs/" + j.sha); c = bl.content }
  return { sha: j.sha, text: td.decode(unb64(String(c).replace(/\s/g, ""))) };
}
const ghPut = (cfg, path, text, sha) => gh(cfg, "PUT", "/contents/" + path, Object.assign({ message: "LabDash sync", content: b64(te.encode(text)) }, sha ? { sha } : {}));
function canon(v) { if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]"; if (v && typeof v === "object") return "{" + Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}"; return JSON.stringify(v) }
const isObj = v => v && typeof v === "object" && !Array.isArray(v);
function mergeVal(b, l, r, depth) {
  const cb = canon(b), cl = canon(l), cr = canon(r);
  if (cl === cr) return l; if (cl === cb) return r; if (cr === cb) return l;
  if (Array.isArray(l) && Array.isArray(r) && l.concat(r).every(x => isObj(x) && x.id)) return mergeList(Array.isArray(b) ? b : [], l, r);
  if (isObj(l) && isObj(r) && depth < 4) { const o = {}; const ks = new Set([...Object.keys(l), ...Object.keys(r), ...Object.keys(isObj(b) ? b : {})]); ks.forEach(k => { const v = mergeVal(isObj(b) ? b[k] : undefined, l[k], r[k], depth + 1); if (v !== undefined) o[k] = v }); return o }
  return l !== undefined ? l : r;
}
function mergeList(b, l, r) { const by = a => Object.fromEntries(a.map(x => [x.id, x])); const B = by(b), L = by(l), R = by(r); const order = [...l.map(x => x.id), ...r.map(x => x.id).filter(id => !(id in L))]; const out = []; order.forEach(id => { const v = mergeVal(B[id], L[id], R[id], 1); if (v !== undefined) out.push(v) }); return out }
function syncError(e) {
  if (!e) return ""; if (e.status === 401) return "GitHub rejected the access token. It may have expired: make a new one and connect again.";
  if (e.status === 403 || e.status === 404) return "The token can't reach that repository. Check the name and that the token has read and write access to its contents.";
  if (e.message === "public") return "That repository is public. Make it private on GitHub first.";
  if (e.message === "otherkey") return "That repository holds a LabDash encrypted with a different passphrase. Use Join on a fresh device instead.";
  return "Couldn't reach GitHub. It will try again when you're online.";
}
function setSyncUI(state) {
  const c = syncCfg(); const p = $("syncPill"), t = $("syncText");
  if (state === "busy") { p.className = "sync-pill busy"; t.textContent = "Syncing"; return }
  if (!c) { p.className = "sync-pill"; t.textContent = "Local" } else if (c.error) { p.className = "sync-pill bad"; t.textContent = "Sync issue" } else { p.className = "sync-pill ok"; t.textContent = "Synced" }
}
$("syncPill").addEventListener("click", () => { if (syncCfg()) syncNow(true); else go("settings", {}, true) });
async function syncNow(manual) {
  const cfg = syncCfg(); if (!cfg || !S.key || inSync) return;
  if (!navigator.onLine) { if (manual) toast("You're offline. Sync will run when you're back online.", true); return }
  inSync = true; setSyncUI("busy");
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      await saving;
      const dev = D()._device;
      for (const id of (dev.pendingImgs || []).slice()) { const f = await fileGet(id); if (f) { const ex = await gh(cfg, "GET", "/contents/img/" + id + ".json"); if (!ex) await ghPut(cfg, "img/" + id + ".json", JSON.stringify({ iv: f.iv, ct: b64(f.ct), type: f.type })) } dev.pendingImgs = dev.pendingImgs.filter(x => x !== id) }
      const remote = await ghGetFile(cfg, "vault.json"); let rDocs = null, rRec = null;
      if (remote) { rRec = JSON.parse(remote.text); try { rDocs = await openBody(S.key, rRec) } catch (_) { throw new Error("otherkey") } }
      const local = clone(stripDevice(D())); const base = dev.base || null;
      const merged = rDocs ? mergeVal(base || {}, local, rDocs, 0) : local;
      if (!rDocs || canon(merged) !== canon(rDocs)) { const rec = await sealObj(merged); try { await ghPut(cfg, "vault.json", JSON.stringify(rec), remote && remote.sha) } catch (e) { if (e.status === 409 || e.status === 422) continue; throw e } }
      const nowLocal = stripDevice(D()); let fin = merged; if (canon(nowLocal) !== canon(local)) fin = mergeVal(local, clone(nowLocal), merged, 0);
      S.docs = ensureShape(clone(fin)); S.docs._device = dev; dev.base = clone(merged); dev.sync.last = Date.now(); delete dev.sync.error;
      await kvPut("vault", await sealObj(S.docs)); setSyncUI(); if (manual) toast("Synced");
      if (!document.querySelector(".sticky-save") || manual) render();
      return;
    }
    throw new Error("busy");
  } catch (e) { const c = syncCfg(); if (c) { c.error = syncError(e); await kvPut("vault", await sealObj(S.docs)) } setSyncUI(); if (manual) toast(syncError(e), true) }
  finally { inSync = false }
}

boot();
