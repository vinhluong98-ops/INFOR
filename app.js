/* Project Board v1 — xem tài liệu dự án từ Google Drive (_BOARD/board.json) */
(() => {
"use strict";
const CFG = window.BOARD_CONFIG || {};
const $ = (s) => document.querySelector(s);
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
const SCOPES = "https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email";
const params = new URLSearchParams(location.search);

/* ---------------- trạng thái ---------------- */
let token = null, tokenExp = 0, tokenClient = null, me = null;
let src = null;            // nguồn dữ liệu: Drive hoặc local (?local=URL để thử)
let origReady = null;
let board = null, index = null, notes = {}, myNotesFileId = null;
let view = { x: 40, y: 40, s: 0.1 };
const world = $("#world"), vp = $("#viewport");
const pageEls = [];        // {it, el, img, level}
let cropTarget = null, cropFromPopup = false;
let tool = "select";
let baseBoard = null, L = null, layoutOwner = "base", editMode = false;
const sel = new Set(), nodeEls = new Map();

/* ---------------- tiện ích ---------------- */
function fail(msg) {
  console.error(msg);
  $("#empty").classList.remove("hidden");
  $("#emptyMsg").textContent = "⚠ " + msg;
  $("#emptyMsg").style.color = "#b91c1c";
  status(msg, 8000);
}
let stTimer;
function status(msg, ms = 2500) { const s = $("#status"); s.textContent = msg; s.classList.add("show"); clearTimeout(stTimer); if (ms) stTimer = setTimeout(() => s.classList.remove("show"), ms); }
const norm = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase();
// chuẩn hoá từng ký tự, giữ nguyên độ dài để tô sáng đúng vị trí
function normC(s) { let o = ""; for (const c of s) { const n = norm(c); o += n.length === 1 ? n : (n ? n[0] : c); } return o; }
function folderIdFrom(s) { if (!s) return ""; const m = s.match(/folders\/([\w-]{10,})/) || s.match(/[?&]id=([\w-]{10,})/) || s.match(/^([\w-]{10,})$/); return m ? m[1] : ""; }

/* ---------------- Google đăng nhập ---------------- */
function initAuth() {
  if (!CFG.clientId) { $("#emptyMsg").textContent = "Chưa cấu hình clientId trong config.js."; return; }
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CFG.clientId, scope: SCOPES,
    error_callback: (e) => {
      const t = e && e.type;
      fail(t === "popup_failed_to_open" ? "Trình duyệt chặn cửa sổ đăng nhập Google. Hãy cho phép popup cho trang này rồi bấm lại."
        : t === "popup_closed" ? "Cửa sổ đăng nhập Google đã bị đóng. Bấm lại để đăng nhập."
        : "Đăng nhập lỗi: " + (t || "không rõ"));
      if (pendingReject) { const f = pendingReject; pendingReject = null; pendingAuth = null; f(new Error("đăng nhập chưa xong")); }
    },
    callback: async (r) => {
      if (r.error) { fail("Đăng nhập lỗi: " + r.error + (r.error_description ? " – " + r.error_description : "")); return; }
      token = r.access_token; tokenExp = Date.now() + (r.expires_in - 60) * 1000;
      $("#btnLogin").classList.add("hidden");
      if (!me) { try { me = await (await gfetch("https://www.googleapis.com/oauth2/v3/userinfo")).json(); $("#user").textContent = me.email; } catch (e) {} }
      if (pendingAuth) { const f = pendingAuth; pendingAuth = null; pendingReject = null; f(); }
    }
  });
  $("#btnLogin").onclick = () => tokenClient.requestAccessToken({ prompt: "" });
}
let pendingAuth = null, pendingReject = null;
function ensureToken() {
  if (token && Date.now() < tokenExp) return Promise.resolve();
  if (!tokenClient) return Promise.reject(new Error("Chưa nạp được đăng nhập Google. Tải lại trang (Ctrl+F5) rồi thử lại."));
  $("#emptyMsg").style.color = ""; $("#emptyMsg").textContent = "Đang chờ đăng nhập Google… (nếu không thấy cửa sổ, hãy cho phép popup)";
  return new Promise((res, rej) => { pendingAuth = res; pendingReject = rej; tokenClient.requestAccessToken({ prompt: token ? "" : undefined }); });
}
async function gfetch(url, opt = {}) {
  await ensureToken();
  opt.headers = Object.assign({}, opt.headers, { Authorization: "Bearer " + token });
  let r = await fetch(url, opt);
  if (r.status === 401) { token = null; await ensureToken(); opt.headers.Authorization = "Bearer " + token; r = await fetch(url, opt); }
  if (!r.ok) throw new Error(r.status + " " + (await r.text()).slice(0, 200));
  return r;
}

/* ---------------- nguồn Drive ---------------- */
function DriveSource(rootId) {
  const paths = {};  // đường dẫn tương đối -> id
  const fmeta = {};
  let lastErr = "";
  const API = "https://www.googleapis.com/drive/v3/files";
  const q = (s) => encodeURIComponent(s);
  async function list(folderId) {
    let out = [], pt = "";
    do {
      const r = await (await gfetch(`${API}?q=${q(`'${folderId}' in parents and trashed=false`)}&fields=nextPageToken,files(id,name,mimeType,size,modifiedTime)&pageSize=1000&supportsAllDrives=true&includeItemsFromAllDrives=true${pt ? "&pageToken=" + pt : ""}`)).json();
      out = out.concat(r.files); pt = r.nextPageToken;
    } while (pt);
    return out;
  }
  async function walk(prefix, folderId, onlyBoard) {
    const queue = [[prefix, folderId]];
    let running = 0;
    await new Promise((done) => {
      const next = () => {
        if (!queue.length && !running) return done();
        while (queue.length && running < 6) {
          const [pre, id] = queue.shift(); running++;
          list(id).then((fs) => {
            for (const f of fs) {
              const p = pre ? pre + "/" + f.name : f.name;
              if (f.mimeType === "application/vnd.google-apps.folder") {
                if (onlyBoard && !pre && f.name !== "_BOARD") continue;
                if (!onlyBoard && !pre && f.name === "_BOARD") continue;
                if (/^(pages|text)$/.test(f.name) && pre === "_BOARD") { paths[p + "/"] = f.id; if (f.name === "pages") queue.push([p, f.id]); continue; }
                paths[p + "/"] = f.id; queue.push([p, f.id]);
              } else { paths[p] = f.id; fmeta[p] = { size: +f.size || 0, mt: f.modifiedTime || "" }; }
            }
          }).catch((e) => { lastErr = e.message; status("Lỗi đọc Drive: " + e.message, 6000); }).finally(() => { running--; next(); });
        }
      };
      next();
    });
  }
  let wbsFolderP = null;
  const textCache = {};
  return {
    kind: "drive", lastError: () => lastErr,
    async init() { await walk("", rootId, true); },
    async indexOriginals() { await walk("", rootId, false); },
    has: (p) => !!paths[p],
    id: (p) => paths[p],
    async json(p) { if (!paths[p]) throw new Error("Không thấy " + p); return (await gfetch(`${API}/${paths[p]}?alt=media&supportsAllDrives=true`)).json(); },
    async blobUrl(p) { if (!paths[p]) throw new Error("Không thấy " + p); return URL.createObjectURL(await (await gfetch(`${API}/${paths[p]}?alt=media&supportsAllDrives=true`)).blob()); },
    async text(docId) {
      if (textCache[docId]) return textCache[docId];
      const tf = paths["_BOARD/text/"];
      const r = await (await gfetch(`${API}?q=${q(`'${tf}' in parents and name='${docId}.json' and trashed=false`)}&fields=files(id)&supportsAllDrives=true&includeItemsFromAllDrives=true`)).json();
      if (!r.files.length) return null;
      return (textCache[docId] = await (await gfetch(`${API}/${r.files[0].id}?alt=media&supportsAllDrives=true`)).json());
    },
    async pdfData(p, onProg) {
      await (origReady || Promise.resolve());
      if (!paths[p]) throw new Error("Chưa thấy file gốc trên Drive: " + p);
      const r = await gfetch(`${API}/${paths[p]}?alt=media&supportsAllDrives=true`);
      const total = +r.headers.get("content-length") || 0;
      if (!r.body || !total) return r.arrayBuffer();
      const rd = r.body.getReader(), chunks = []; let got = 0;
      for (;;) { const { done, value } = await rd.read(); if (done) break; chunks.push(value); got += value.length; onProg && onProg(got, total); }
      const out = new Uint8Array(got); let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; }
      return out.buffer;
    },
    openUrl(p) { const id = paths[p]; return id ? `https://drive.google.com/file/d/${id}/view` : null; },
    async saveImage(blob) {
      let f = paths["_BOARD/wbsimg/"];
      if (!f) {
        wbsFolderP = wbsFolderP || (async () => {
          const r = await (await gfetch(API + "?supportsAllDrives=true", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "wbsimg", mimeType: "application/vnd.google-apps.folder", parents: [paths["_BOARD/"]] }) })).json();
          if (!r.id) throw new Error("không tạo được thư mục hình"); return (paths["_BOARD/wbsimg/"] = r.id);
        })();
        try { f = await wbsFolderP; } catch (e) { wbsFolderP = null; throw e; }
      }
      const fd = new FormData();
      fd.append("metadata", new Blob([JSON.stringify({ name: "wbs_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5) + ".jpg", parents: [f], mimeType: "image/jpeg" })], { type: "application/json" }));
      fd.append("file", blob);
      const r = await (await gfetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true", { method: "POST", body: fd })).json();
      if (!r.id) throw new Error("Drive không nhận hình"); return r.id;
    },
    async imageUrl(id) { return URL.createObjectURL(await (await gfetch(`${API}/${id}?alt=media&supportsAllDrives=true`)).blob()); },
    async files() { await (origReady || Promise.resolve()); return Object.keys(fmeta).filter((p) => !p.startsWith("_BOARD/")).map((p) => ({ path: p, size: fmeta[p].size, mt: fmeta[p].mt })); },
    async loadNotes() {
      const nf = paths["_BOARD/notes/"]; if (!nf) return {};
      const fs = await list(nf), out = {};
      await Promise.all(fs.filter((f) => f.name.endsWith(".json")).map(async (f) => {
        try { const d = await (await gfetch(`${API}/${f.id}?alt=media`)).json(); out[f.name.replace(/\.json$/, "")] = d; if (me && f.name === me.email + ".json") myNotesFileId = f.id; } catch (e) {}
      }));
      return out;
    },
    async saveNotes(data) {
      const body = JSON.stringify(data);
      if (myNotesFileId) {
        await gfetch(`https://www.googleapis.com/upload/drive/v3/files/${myNotesFileId}?uploadType=media`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body });
        return;
      }
      let nf = paths["_BOARD/notes/"];
      if (!nf) {
        const r = await (await gfetch(API + "?supportsAllDrives=true", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "notes", mimeType: "application/vnd.google-apps.folder", parents: [paths["_BOARD/"]] }) })).json();
        nf = paths["_BOARD/notes/"] = r.id;
      }
      const meta = { name: me.email + ".json", parents: [nf], mimeType: "application/json" };
      const fd = new FormData();
      fd.append("metadata", new Blob([JSON.stringify(meta)], { type: "application/json" }));
      fd.append("file", new Blob([body], { type: "application/json" }));
      const r = await (await gfetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true", { method: "POST", body: fd })).json();
      myNotesFileId = r.id;
    }
  };
}

/* ---------------- nguồn local (thử nghiệm: ?local=<url thư mục dự án>) ---------------- */
const localImgs = new Map();
function LocalSource(base) {
  base = base.replace(/\/$/, "") + "/";
  const enc = (p) => p.split("/").map(encodeURIComponent).join("/");
  const textCache = {};
  return {
    kind: "local", async init() {}, async indexOriginals() {}, has: () => true,
    async json(p) { return (await fetch(base + enc(p))).json(); },
    async blobUrl(p) { return base + enc(p); },
    async pdfData(p) { return (await fetch(base + enc(p))).arrayBuffer(); },
    async text(id) { return textCache[id] || (textCache[id] = await (await fetch(base + "_BOARD/text/" + id + ".json")).json()); },
    openUrl(p) { return base + enc(p); },
    async saveImage(blob) { const id = "L" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5); localImgs.set(id, blob); return id; },
    async imageUrl(id) { const b = localImgs.get(id); return b ? URL.createObjectURL(b) : ""; },
    async files() { try { return await (await fetch(base + "_BOARD/filelist.json")).json(); } catch (e) { return []; } },
    async loadNotes() { try { return JSON.parse(localStorage.getItem("pb_notes") || "{}"); } catch (e) { return {}; } },
    async saveNotes(d) { const all = JSON.parse(localStorage.getItem("pb_notes") || "{}"); all[me.email] = d; localStorage.setItem("pb_notes", JSON.stringify(all)); }
  };
}

/* ---------------- mở bảng ---------------- */
async function openBoard() {
  $("#empty").classList.add("hidden");
  status("Đang đọc danh sách file…", 0);
  await src.init();
  if (src.kind === "drive" && !src.has("_BOARD/board.json")) throw new Error((src.lastError() ? "Drive báo lỗi: " + src.lastError() + " — " : "") + "Không thấy _BOARD/board.json trong thư mục. Hãy dán link đúng thư mục dự án (thư mục chứa _BOARD) và đảm bảo tài khoản đang đăng nhập có quyền xem.");
  status("Đang tải bố cục…", 0);
  baseBoard = await src.json("_BOARD/board.json"); L = null; layoutOwner = "base";
  try { coll = JSON.parse(localStorage.getItem("pb_coll") || "{}"); } catch (e) { coll = {}; }
  $("#projName").textContent = baseBoard.project;
  document.title = baseBoard.project + " – Project Board";
  rebuildBoard();
  fitAll();
  status(`Đã mở: ${Object.keys(board.docs).length} tài liệu, ${board.items.filter((i) => i.type === "page").length} trang`);
  src.json("_BOARD/index.json").then((d) => { index = d.pages; index.forEach((p) => { p.text = p.text.normalize("NFC"); p.n = normC(p.text); }); index.push(...pendingIdx); pendingIdx = []; $("#q").placeholder = `Tìm trong ${index.length} trang… (Ctrl+F)`; }).catch(() => status("Chưa có index.json – không tìm kiếm được", 5000));
  src.json("_BOARD/wbs.json").then((w) => { if (w && w.zones) { wbs = w; $("#btnWbs").classList.remove("hidden"); document.querySelector("[data-tab=wbs]").classList.remove("hidden"); renderWbs(); } }).catch(() => {});
  origReady = src.indexOriginals();
  origReady.then(async () => { origDone = true; try { files = await src.files(); } catch (e) { files = []; } scheduleRebuild(); });
  src.loadNotes().then((n) => { notes = n; initLayoutAfterNotes(); }).catch((e) => console.warn(e));
}

/* ---------------- vẽ / tải ảnh theo màn hình ---------------- */
let rafPending = false;
function apply() {
  world.style.transform = `translate(${view.x}px,${view.y}px) scale(${view.s})`;
  world.style.setProperty("--inv", (1 / view.s).toFixed(4));
  $("#zoomInfo").textContent = Math.round(view.s * 1000) / 10 + "%";
  if (!rafPending) { rafPending = true; requestAnimationFrame(() => { rafPending = false; updateImages(); }); }
}
const cache = new Map(); // path -> url
let inflight = 0; const queue = [];
function loadImg(path, cb) {
  if (cache.has(path)) { const u = cache.get(path); cache.delete(path); cache.set(path, u); return cb(u); }
  queue.push([path, cb]); pump();
}
function pump() {
  while (inflight < 6 && queue.length) {
    const [path, cb] = queue.pop(); // ưu tiên yêu cầu mới nhất
    inflight++;
    src.blobUrl(path).then((u) => { cache.set(path, u); trim(); cb(u); }).catch(() => {}).finally(() => { inflight--; pump(); });
  }
}
function trim() {
  let full = [...cache.keys()].filter((k) => !k.endsWith("_t.webp"));
  while (full.length > 60) { const k = full.shift(); const u = cache.get(k); cache.delete(k); if (u.startsWith("blob:")) URL.revokeObjectURL(u); }
}
function updateImages() {
  if (!board) return;
  scheduleHi();
  const W = vp.clientWidth, H = vp.clientHeight, m = 300;
  queue.length = 0;
  for (const p of pageEls) {
    const it = p.it;
    const sx = it.x * view.s + view.x, sy = it.y * view.s + view.y, sw = it.w * view.s, sh = it.h * view.s;
    const vis = sx + sw > -m && sx < W + m && sy + sh > -m && sy < H + m;
    if (!vis) continue;
    if (it.kind === "sheet") { if (!p.built) buildSheetEl(p); continue; }
    if (it.kind === "pdf") { if (p.level < 1 && !p.failed) queueRender(p); continue; }
    const want = sw > 480 ? 2 : 1;
    if (p.level >= want) continue;
    const path = want === 2 ? it.src : it.thumb;
    loadImg(path, (u) => { if (p.level < want) { p.img.src = u; p.level = want; } });
  }
}

/* ---------------- PDF gốc: vẽ lại nét khi phóng to ---------------- */
const pdfDocs = new Map(), pdfFail = new Set();
if (window.pdfjsLib) pdfjsLib.GlobalWorkerOptions.workerSrc = "lib/pdf.worker.min.js?v=3";
function getPdf(docId) {
  if (pdfDocs.has(docId)) { const e = pdfDocs.get(docId); pdfDocs.delete(docId); pdfDocs.set(docId, e); return e.promise; }
  const d = board.docs[docId];
  const promise = (async () => {
    status(`Đang tải file gốc: ${d.name} …`, 0);
    try {
      const buf = await src.pdfData(d.path, (g, t) => status(`Đang tải file gốc: ${d.name} – ${Math.round(g / 1048576)}/${Math.round(t / 1048576)} MB`, 0));
      const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buf), isEvalSupported: false }).promise;
      status("Đã tải xong: " + d.name, 1500);
      return pdf;
    } catch (e) { pdfFail.add(docId); pdfDocs.delete(docId); status("Không mở được file gốc " + d.name + ": " + e.message, 6000); throw e; }
  })();
  pdfDocs.set(docId, { promise });
  while (pdfDocs.size > 3) { const k = pdfDocs.keys().next().value; const e = pdfDocs.get(k); pdfDocs.delete(k); e.promise.then((p) => p.destroy()).catch(() => {}); }
  return promise;
}
function dropHi(p) { if (p.canvas) { p.canvas.remove(); p.canvas = null; } p.hiW = 0; p.job = 0; }
let hiTimer, jobSeq = 0, hiBusy = false;
function scheduleHi() { clearTimeout(hiTimer); hiTimer = setTimeout(doHi, 300); }
async function doHi() {
  if (!board || !window.pdfjsLib) return;
  if (hiBusy) { scheduleHi(); return; }
  const W = vp.clientWidth, H = vp.clientHeight, dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cands = [];
  for (const p of pageEls) {
    const it = p.it, d = board.docs[it.doc];
    if (!d || d.kind !== "pdf" || it.kind === "sheet" || pdfFail.has(it.doc)) continue;
    const sx = it.x * view.s + view.x, sy = it.y * view.s + view.y, sw = it.w * view.s, sh = it.h * view.s;
    const vw = Math.min(sx + sw, W) - Math.max(sx, 0), vh = Math.min(sy + sh, H) - Math.max(sy, 0);
    if (vw <= 0 || vh <= 0 || sw < 650) { if (p.canvas) dropHi(p); continue; }
    cands.push({ p, sw, area: vw * vh });
  }
  cands.sort((a, b) => b.area - a.area);
  hiBusy = true;
  try {
    for (const { p, sw } of cands.slice(0, 3)) {
      const it = p.it, need = Math.min(sw * dpr, 7000);
      if (p.hiW && p.hiW >= need * 0.85) continue;
      const job = (p.job = ++jobSeq);
      let pdf, page;
      try { pdf = await getPdf(it.doc); page = await pdf.getPage(it.page); } catch (e) { continue; }
      const v0 = page.getViewport({ scale: 1 });
      const scale = Math.min(need / v0.width, 7000 / Math.max(v0.width, v0.height));
      let v = page.getViewport({ scale });
      const maxPx = 36e6; if (v.width * v.height > maxPx) v = page.getViewport({ scale: scale * Math.sqrt(maxPx / (v.width * v.height)) });
      const cv = document.createElement("canvas"); cv.width = Math.floor(v.width); cv.height = Math.floor(v.height);
      const ctx = cv.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, cv.width, cv.height);
      await page.render({ canvasContext: ctx, viewport: v }).promise;
      if (p.job !== job) continue; // đã có yêu cầu mới hơn
      cv.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%;display:block";
      if (p.canvas) p.canvas.remove();
      p.el.insertBefore(cv, p.img.nextSibling); p.canvas = cv; p.hiW = cv.width;
    }
  } catch (e) { console.warn("hi-res:", e); }
  hiBusy = false;
}

/* ---------------- điều hướng ---------------- */
function zoomAt(f, cx, cy) {
  const ns = Math.min(8, Math.max(0.005, view.s * f));
  view.x = cx - (cx - view.x) * (ns / view.s); view.y = cy - (cy - view.y) * (ns / view.s); view.s = ns; apply();
}
function focusRect(r, pad = 0.05, anim = true) {
  const W = vp.clientWidth, H = vp.clientHeight;
  // chừa chỗ cho thanh danh mục / kết quả tìm kiếm đang mở
  const L = $("#side").classList.contains("hidden") ? 0 : $("#side").offsetWidth;
  const R = Math.max($("#results").classList.contains("hidden") ? 0 : $("#results").offsetWidth, $("#wbsd").classList.contains("hidden") ? 0 : $("#wbsd").offsetWidth);
  const AW = Math.max(200, W - L - R), CX = L + AW / 2;
  const s = Math.min(AW / (r.w * (1 + 2 * pad)), H / (r.h * (1 + 2 * pad)));
  const tgt = { s, x: CX - (r.x + r.w / 2) * s, y: H / 2 - (r.y + r.h / 2) * s };
  if (!anim) { view = tgt; return apply(); }
  const a = { ...view }, t0 = performance.now();
  const step = (t) => { const k = Math.min(1, (t - t0) / 350), e = 1 - Math.pow(1 - k, 3);
    const ls = Math.exp(Math.log(a.s) + (Math.log(tgt.s) - Math.log(a.s)) * e);
    // nội suy theo tâm màn hình để không bị lệch
    const ca = { x: (W / 2 - a.x) / a.s, y: (H / 2 - a.y) / a.s }, ct = { x: (W / 2 - tgt.x) / tgt.s, y: (H / 2 - tgt.y) / tgt.s };
    const cx = ca.x + (ct.x - ca.x) * e, cy = ca.y + (ct.y - ca.y) * e;
    view = { s: ls, x: W / 2 - cx * ls, y: H / 2 - cy * ls }; apply(); if (k < 1) requestAnimationFrame(step); };
  requestAnimationFrame(step);
}
function fitAll() {
  if (!board || !board.groups.length) return;
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const g of board.groups) { x0 = Math.min(x0, g.x); y0 = Math.min(y0, g.y); x1 = Math.max(x1, g.x + g.w); y1 = Math.max(y1, g.y + g.h); }
  y0 -= 260; // chừa chỗ cho nút điều khiển phía trên vùng
  focusRect({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, 0.02);
}

/* chuột & cảm ứng */
let drag = null, spaceDown = false;
const pointers = new Map();
vp.addEventListener("wheel", (e) => {
  e.preventDefault();
  const r = vp.getBoundingClientRect();
  if (e.ctrlKey || !e.deltaX && Math.abs(e.deltaY) >= 50 && e.deltaMode === 0 && Number.isInteger(e.deltaY)) zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), e.clientX - r.left, e.clientY - r.top);
  else if (e.deltaMode === 1) zoomAt(Math.exp(-e.deltaY * 0.05), e.clientX - r.left, e.clientY - r.top);
  else { view.x -= e.deltaX; view.y -= e.deltaY; apply(); }
}, { passive: false });
vp.addEventListener("pointerdown", (e) => {
  if (!e.target.closest(".pin")) world.querySelectorAll(".pin.open").forEach((x) => x.classList.remove("open"));
  if (e.button === 0 && !spaceDown) {
    if (e.target.closest("#world button")) return;
    if (e.target.closest(".note,.pin")) return;
    if (e.target.closest(".tx") && !e.target.closest(".txh")) return;
    if (!editMode && e.target.closest(".lnk")) return;
  }
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (e.button === 0 && !spaceDown && pointers.size === 1) {
    if (tool === "note") { e.preventDefault(); pointers.delete(e.pointerId); addNoteAt(e); return; }
    if (tool === "pin") { e.preventDefault(); pointers.delete(e.pointerId); addPinAt(e); return; }
    if (DRAW[tool]) { e.preventDefault(); if (!startDraw(e)) pointers.delete(e.pointerId); return; }
    if (shapePointerDown(e)) return;
    if (editMode && me && editPointerDown(e)) return;
  }
  vp.setPointerCapture(e.pointerId);
  if (pointers.size === 1) { drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false }; vp.classList.add("panning"); }
  else drag = null;
});
vp.addEventListener("pointermove", (e) => {
  if (!pointers.has(e.pointerId)) return;
  const prev = pointers.get(e.pointerId); pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (eDrag) { if (e.pointerId === eDrag.pid) eDragMove(e); return; }
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()]; const pa = e.pointerId === [...pointers.keys()][0] ? prev : a, pb = e.pointerId === [...pointers.keys()][1] ? prev : b;
    const d0 = Math.hypot(pa.x - pb.x, pa.y - pb.y), d1 = Math.hypot(a.x - b.x, a.y - b.y);
    const r = vp.getBoundingClientRect(), cx = (a.x + b.x) / 2 - r.left, cy = (a.y + b.y) / 2 - r.top;
    view.x += ((a.x + b.x) - (pa.x + pb.x)) / 2; view.y += ((a.y + b.y) - (pa.y + pb.y)) / 2;
    if (d0 > 0) zoomAt(d1 / d0, cx, cy); else apply();
  } else if (drag) { view.x = drag.vx + e.clientX - drag.x; view.y = drag.vy + e.clientY - drag.y; drag.moved = true; apply(); }
});
const up = (e) => {
  if (eDrag && e.pointerId === eDrag.pid) eDragEnd(e, e.type === "pointercancel");
  else if (drag && e.type === "pointerup" && e.button === 0 && !spaceDown && pointers.size === 1 && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 4) boardClick(e);
  pointers.delete(e.pointerId); if (!pointers.size) { drag = null; vp.classList.remove("panning"); }
};
vp.addEventListener("pointerup", up); vp.addEventListener("pointercancel", up);
window.addEventListener("keydown", (e) => {
  const typing = e.target.closest("input,textarea,[contenteditable=true]");
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") { e.preventDefault(); $("#q").focus(); $("#q").select(); return; }
  if (typing) { if (e.key === "Escape") e.target.blur(); return; }
  if (!$("#modal").classList.contains("hidden")) { if (e.key === "Escape") closeModal(); return; }
  if (me && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (me && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); return; }
  if (selShape && (e.key === "Delete" || e.key === "Backspace")) { e.preventDefault(); deleteShape(); return; }
  if (editMode && sel.size && (e.key === "Delete" || e.key === "Backspace")) { e.preventDefault(); deleteSelection(); return; }
  if (editMode && sel.size && e.key.startsWith("Arrow")) { e.preventDefault(); nudgeSel(e.key, e.shiftKey ? 100 : 10); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (!e.ctrlKey && !e.metaKey && e.key.toLowerCase() === "b") { $("#dbToggle").click(); return; }
  if (e.key === " ") spaceDown = true;
  if (e.shiftKey && (e.key === "!" || e.code === "Digit1")) { e.preventDefault(); fitAll(); }
  else if (e.key === "v" || e.key === "V") setTool("select");
  else if (e.key === "n" || e.key === "N") setTool("note");
  else if (e.key === "p" || e.key === "P") setTool("pin");
  else if (e.key === "c" || e.key === "C") setTool("cloud");
  else if (e.key === "r" || e.key === "R") setTool("rect");
  else if (e.key === "a" || e.key === "A") setTool("arrow");
  else if (e.key === "t" || e.key === "T") setTool("text");
  else if (e.key === "h" || e.key === "H") setTool("hl");
  else if (e.key === "x" || e.key === "X") setTool("crop");
  else if (e.key === "e" || e.key === "E") setEditMode(!editMode);
  else if (e.key === "\\") $("#side").classList.toggle("hidden");
  else if (e.key === "Escape") { setTool("select"); clearHl(); if (sel.size) { sel.clear(); applySelection(); } if (selShape) { selShape = null; placeShapes(); } }
  else if (e.key === "Enter" || e.key === "F3") stepResult(e.shiftKey ? -1 : 1);
  else if (e.key === "+" || e.key === "=") zoomAt(1.25, vp.clientWidth / 2, vp.clientHeight / 2);
  else if (e.key === "-") zoomAt(0.8, vp.clientWidth / 2, vp.clientHeight / 2);
});
window.addEventListener("keyup", (e) => { if (e.key === " ") spaceDown = false; });
window.addEventListener("resize", apply);
function setTool(t) { tool = t; if (t !== "crop") { cropTarget = null; cropFromPopup = false; } document.querySelectorAll("[data-tool]").forEach((b) => b.classList.toggle("on", b.dataset.tool === t)); vp.classList.toggle("tool-note", t !== "select"); }
document.querySelectorAll("[data-tool]").forEach((b) => (b.onclick = () => setTool(b.dataset.tool)));
$("#btnFit").onclick = fitAll;
$("#btnSide").onclick = () => $("#side").classList.toggle("hidden");
$("#btnNotes").onclick = () => { world.classList.toggle("hide-notes"); status(world.classList.contains("hide-notes") ? "Đã ẩn ghi chú, ghim, hình vẽ" : "Hiện ghi chú, ghim, hình vẽ"); };

/* ---------------- tìm kiếm ---------------- */
let results = [], cur = -1, hlEls = [];
let qTimer;
$("#q").addEventListener("input", () => { clearTimeout(qTimer); qTimer = setTimeout(search, 200); });
$("#q").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); stepResult(e.shiftKey ? -1 : 1); } if (e.key === "Escape") { $("#q").value = ""; search(); } });
$("#rClose").onclick = () => { $("#results").classList.add("hidden"); clearHl(); };
function terms(q) { return norm(q).split(/\s+/).filter((t) => t.length > 0); }
function search() {
  const q = $("#q").value.trim(); clearHl();
  if (!q || !index) { results = []; $("#results").classList.add("hidden"); $("#qInfo").textContent = ""; return; }
  const nq = norm(q), ts = terms(q), phrase = ts.length > 1;
  results = [];
  for (const p of index) {
    let score = 0;
    if (phrase && p.n.includes(nq)) score += 100;
    let all = true;
    for (const t of ts) { const c = p.n.split(t).length - 1; if (!c) { all = false; break; } score += Math.min(c, 10); }
    if (all) results.push({ p, score });
  }
  results.sort((a, b) => b.score - a.score);
  $("#qInfo").textContent = results.length ? `${results.length} trang` : "Không thấy";
  const list = $("#rList"); list.innerHTML = "";
  $("#rCount").textContent = `${results.length} trang có “${q}”`;
  results.slice(0, 300).forEach((r, i) => {
    const d = board.docs[r.p.doc];
    const row = el("div", "res");
    row.appendChild(el("div", "rt", `${d.name} — tr. ${r.p.page}`));
    const sn = el("div", "rs"); sn.innerHTML = snippet(r.p.text, ts); row.appendChild(sn);
    row.onclick = () => goResult(i);
    list.appendChild(row);
  });
  $("#results").classList.toggle("hidden", !results.length); if (results.length) $("#wbsd").classList.add("hidden");
  cur = -1;
}
function esc(s) { return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function snippet(text, ts) {
  const n = normC(text); let i = n.indexOf(ts[0]); if (i < 0) i = 0;
  const a = Math.max(0, i - 60), b = Math.min(text.length, i + 140);
  let s = text.slice(a, b), ns = n.slice(a, b), out = "", k = 0;
  // tô sáng theo vị trí trên chuỗi đã chuẩn hoá (cùng độ dài với chuỗi gốc sau NFC)
  const marks = [];
  for (const t of ts) { let j = ns.indexOf(t); while (j >= 0) { marks.push([j, j + t.length]); j = ns.indexOf(t, j + t.length); } }
  marks.sort((x, y) => x[0] - y[0]);
  for (const [x, y] of marks) { if (x < k) continue; out += esc(s.slice(k, x)) + "<mark>" + esc(s.slice(x, y)) + "</mark>"; k = y; }
  return (a ? "…" : "") + out + esc(s.slice(k)) + (b < text.length ? "…" : "");
}
function stepResult(dir) { if (!results.length) return; goResult((cur + dir + results.length) % results.length); }
async function goResult(i) {
  cur = i; const r = results[i];
  document.querySelectorAll(".res").forEach((e, j) => e.classList.toggle("cur", j === i));
  const row = document.querySelectorAll(".res")[i]; if (row) row.scrollIntoView({ block: "nearest" });
  const pe = await revealPage(r.p.doc, r.p.page); if (!pe) return;
  clearHl(); pe.el.classList.add("focus");
  const t = await src.text(r.p.doc).catch(() => null);
  const ts = terms($("#q").value);
  let boxes = [];
  if (t && t.pages[r.p.page - 1]) {
    for (const w of t.pages[r.p.page - 1]) { const nw = norm(w[4]); if (ts.some((x) => nw.includes(x) || (x.includes(nw) && nw.length > 2))) boxes.push(w); }
  }
  for (const w of boxes) {
    const h = el("div", "hl"); Object.assign(h.style, { left: w[0] * 100 + "%", top: w[1] * 100 + "%", width: (w[2] - w[0]) * 100 + "%", height: (w[3] - w[1]) * 100 + "%" });
    pe.el.appendChild(h); hlEls.push(h);
  }
  hlEls.push(pe.el);
  const it = pe.it;
  if (boxes.length) {
    // phóng tới vùng có từ khoá (rộng ít nhất 1/3 trang)
    let x0 = Math.min(...boxes.map((b) => b[0])), y0 = Math.min(...boxes.map((b) => b[1])), x1 = Math.max(...boxes.map((b) => b[2])), y1 = Math.max(...boxes.map((b) => b[3]));
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, ww = Math.max(x1 - x0 + 0.1, 0.5), hh = Math.max(y1 - y0 + 0.1, 0.5);
    focusRect({ x: it.x + (cx - ww / 2) * it.w, y: it.y + (cy - hh / 2) * it.h, w: ww * it.w, h: hh * it.h }, 0.05);
  } else focusRect(it, 0.04);
}
function clearHl() { for (const h of hlEls) { if (h.classList.contains("pg")) h.classList.remove("focus"); else h.remove(); } hlEls = []; }

/* ---------------- ghi chú ---------------- */
let saveTimer;
function myNotes() { const k = me ? me.email : "local"; if (!notes[k]) notes[k] = { author: me ? (me.name || me.email) : "local", notes: [], wbs: {} }; return notes[k]; }
function toWorld(e) { const r = vp.getBoundingClientRect(); return { x: (e.clientX - r.left - view.x) / view.s, y: (e.clientY - r.top - view.y) / view.s }; }
function addNoteAt(e) {
  if (!me) { status("Cần đăng nhập để ghi chú", 3000); return; }
  const p = toWorld(e);
  const n = { id: Date.now().toString(36), x: Math.round(p.x), y: Math.round(p.y), s: Math.round(1 / view.s * 100) / 100, text: "", t: new Date().toISOString() };
  myNotes().notes.push(n); renderNotes(); setTool("select");
  setTimeout(() => { const t = world.querySelector(`.note[data-id="${n.id}"] .txt`); if (t) t.focus(); }, 0);
}
function renderNotes() {
  world.querySelectorAll(".note").forEach((e) => e.remove());
  for (const [owner, d] of Object.entries(notes)) {
    const mine = me && owner === me.email;
    for (const n of d.notes || []) {
      const box = el("div", "note" + (mine ? " mine" : "")); box.dataset.id = n.id;
      Object.assign(box.style, { left: n.x + "px", top: n.y + "px", transform: `scale(${n.s || 1})` });
      const t = el("div", "txt"); t.textContent = n.text; t.contentEditable = mine ? "true" : "false";
      t.addEventListener("input", () => { n.text = t.innerText; n.t = new Date().toISOString(); queueSave(); });
      box.appendChild(t);
      box.appendChild(el("div", "au", (d.author || owner) + " · " + (n.t || "").slice(0, 10)));
      if (mine) {
        const del = el("button", "del", "✕"); del.title = "Xoá ghi chú";
        del.onclick = () => { if (!confirm("Xoá ghi chú này?")) return; d.notes = d.notes.filter((x) => x !== n); renderNotes(); queueSave(); };
        box.appendChild(del);
        // kéo ghi chú bằng phần chân
        box.addEventListener("pointerdown", (e) => {
          if (e.target === t || e.target === del) return;
          e.stopPropagation(); box.setPointerCapture(e.pointerId);
          const sx = e.clientX, sy = e.clientY, ox = n.x, oy = n.y;
          const mv = (ev) => { n.x = Math.round(ox + (ev.clientX - sx) / view.s); n.y = Math.round(oy + (ev.clientY - sy) / view.s); box.style.left = n.x + "px"; box.style.top = n.y + "px"; };
          const upf = () => { box.removeEventListener("pointermove", mv); box.removeEventListener("pointerup", upf); queueSave(); };
          box.addEventListener("pointermove", mv); box.addEventListener("pointerup", upf);
        });
      }
      world.appendChild(box);
    }
  }
}
function queueSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try { await src.saveNotes(myNotes()); status("Đã lưu ghi chú", 1200); } catch (e) { status("Lưu ghi chú lỗi: " + e.message, 6000); }
  }, 1200);
}


/* ---------------- WBS Dictionary ---------------- */
let wbs = null, wbsCur = null, wbsOnlyWarn = false, wbsQ = "";
const CHK = [["spec", "Đã đối chiếu BOQ ↔ SPEC"], ["dwg", "Đã đối chiếu BOQ ↔ bản vẽ"], ["ok", "Đã duyệt hạng mục (đủ thông tin)"]];
function wbsState(id) { const w = (myNotes().wbs = myNotes().wbs || {}); return (w[id] = w[id] || { chk: {}, links: {}, note: "" }); }
function wbsPeers(id) { // ai đã duyệt hạng mục này
  const out = [];
  for (const [owner, d] of Object.entries(notes)) { const r = d.wbs && d.wbs[id]; if (r && r.chk && r.chk.ok) out.push((d.author || owner)); }
  return out;
}
function allWbsItems() { const o = []; for (const z of wbs.zones) for (const p of z.packages) for (const it of p.items) o.push({ z, p, it }); return o; }
function setSideTab(t) {
  document.querySelectorAll("#sideTabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === t));
  $("#toc").classList.toggle("hidden", t !== "toc"); $("#wbsList").classList.toggle("hidden", t !== "wbs");
  $("#side").classList.toggle("wide", t === "wbs");
  if (t !== "wbs") closeWbsd();
}
document.querySelectorAll("#sideTabs button").forEach((b) => (b.onclick = () => setSideTab(b.dataset.tab)));
$("#btnClaude").onclick = () => {
  // gọi script ClaudeDock trên máy (giao thức claudedock://, cài bằng Cai_dat.bat). Lần đầu Chrome hỏi → tick "luôn cho phép".
  const a = document.createElement("a"); a.href = "claudedock://toggle"; document.body.appendChild(a); a.click(); a.remove();
  if (!localStorage.getItem("pb_dock_hint")) { localStorage.setItem("pb_dock_hint", "1"); status("Nếu Chrome hỏi mở ứng dụng: tick 'luôn cho phép'. Chưa có gì xảy ra → chạy Cai_dat.bat của ClaudeDock.", 9000); }
};
$("#btnWbs").onclick = () => {
  const open = !$("#side").classList.contains("hidden") && !$("#wbsList").classList.contains("hidden");
  if (open) { $("#side").classList.add("hidden"); closeWbsd(); } else { $("#side").classList.remove("hidden"); setSideTab("wbs"); }
};
$("#wbsdClose").onclick = closeWbsd;
function closeWbsd() { $("#wbsd").classList.add("hidden"); wbsCur = null; if (typeof renderSelBar === "function") renderSelBar(); document.querySelectorAll(".wi.cur").forEach((e) => e.classList.remove("cur")); clearHl(); }
function renderWbs() {
  const box = $("#wbsList"); box.innerHTML = "";
  const f = el("div"); f.id = "wbsFilter";
  const q = el("input"); q.type = "search"; q.placeholder = "Lọc hạng mục…"; q.value = wbsQ; q.oninput = () => { wbsQ = q.value; renderWbs(); const i2 = box.querySelector("input"); i2.focus(); i2.setSelectionRange(wbsQ.length, wbsQ.length); };
  const lb = el("label"); const cb = el("input"); cb.type = "checkbox"; cb.checked = wbsOnlyWarn; cb.onchange = () => { wbsOnlyWarn = cb.checked; renderWbs(); };
  lb.append(cb, document.createTextNode(" Chỉ có cảnh báo")); f.append(q, lb); box.appendChild(f);
  const nq = norm(wbsQ);
  for (const z of wbs.zones) {
    const zh = el("div", "wz", z.title); zh.title = z.note || ""; box.appendChild(zh);
    for (const p of z.packages) {
      const ph = el("div", "wp", p.title); ph.appendChild(el("small", null, (p.area_m2 ? p.area_m2 + " m² · " : "") + p.items.length + " dòng BOQ")); box.appendChild(ph);
      let lastCat = null;
      const byCat = {}; for (const it of p.items) (byCat[it.cat] = byCat[it.cat] || []).push(it);
      for (const [cat, its] of Object.entries(byCat)) {
        const rows = its.filter((it) => (!wbsOnlyWarn || it.warnings.length) && (!nq || norm(codeOf(it.id) + " " + it.name + " " + it.cat + " " + it.specs.map((s) => s.code).join(" ")).includes(nq)));
        if (!rows.length) continue;
        box.appendChild(el("div", "wc", cat));
        for (const it of rows) {
          const r = el("div", "wi"); r.dataset.id = it.id; if (wbsCur === it.id) r.classList.add("cur");
          r.appendChild(el("span", "n", it.stt));
          const ci = el("input", "cdin sm"); ci.placeholder = "mã"; ci.value = codeOf(it.id); ci.disabled = !me; ci.title = me ? "Nhập mã code của hạng mục" : "Đăng nhập để nhập mã";
          ci.onclick = (e) => e.stopPropagation(); ci.onkeydown = (e) => { e.stopPropagation(); if (e.key === "Enter") ci.blur(); };
          ci.oninput = () => { const s2 = wbsState(it.id); s2.code = ci.value.trim(); touchSt(s2); queueSave(); };
          r.appendChild(ci);
          const t = el("span", "t", it.name);
          if (it.warnings.length) { const b = el("span", "bdg " + (it.matrix === "Central" ? "r" : "w"), "⚠" + it.warnings.length); t.appendChild(b); }
          if (wbsPeers(it.id).length) t.appendChild(el("span", "bdg ok", "✓"));
          r.appendChild(t); r.appendChild(el("span", "q", it.qty != null ? it.qty.toLocaleString("vi-VN") + " " + it.unit : ""));
          r.onclick = () => openWbsItem(it.id); box.appendChild(r);
        }
      }
    }
    if (z.spec_unlinked && z.spec_unlinked.length) {
      box.appendChild(el("div", "wc", "Có trong SPEC nhưng chưa thấy dòng BOQ"));
      for (const u of z.spec_unlinked) {
        const r = el("div", "wi"); r.appendChild(el("span", "n", "·")); r.appendChild(el("span", "t", u.code + " – " + u.desc + " (" + u.loc + ")")); r.appendChild(el("span", "q", "tr." + u.page));
        r.onclick = () => goPage(u.doc, u.page); box.appendChild(r);
      }
    }
  }
}
async function goPage(doc, page) {
  const pe = await revealPage(doc, page); if (!pe) return status("Không thấy trang này trên bảng", 3000);
  clearHl(); pe.el.classList.add("focus"); hlEls.push(pe.el); focusRect(pe.it, 0.04);
}
function openWbsItem(id, noFocus) {
  const f = allWbsItems().find((x) => x.it.id === id); if (!f) return; const { z, p, it } = f; wbsCur = id;
  $("#results").classList.add("hidden"); $("#wbsd").classList.remove("hidden");
  document.querySelectorAll(".wi").forEach((e) => e.classList.toggle("cur", e.dataset.id === id));
  const st = me ? wbsState(id) : { chk: {}, links: {}, note: "" };
  const B = $("#wbsdBody"); B.innerHTML = ""; $("#wbsdTitle").textContent = z.title + " · " + p.title;
  B.appendChild(el("h3", null, it.stt + ". " + it.name));
  B.appendChild(el("div", "sub", it.cat + (it.qty != null ? " · " + it.qty.toLocaleString("vi-VN") + " " + it.unit : "") + " · BOQ NEM mục: " + it.boq_group));
  // phạm vi
  B.appendChild(el("h4", null, "Phạm vi"));
  const sc = el("div", "wbox" + (it.matrix === "NEM" ? "" : " err"));
  sc.className = "wbox" + (it.matrix === "NEM" ? "" : it.matrix === "Central" ? " err" : " warn");
  sc.textContent = "Báo giá (BOQ): NEM · Ma trận phạm vi cho '" + it.cat + "': " + it.matrix + (it.matrix === "NEM" ? " ✓ khớp" : it.matrix === "Central" ? " ✗ không khớp" : " (chưa có nhà thầu trong ma trận)"); B.appendChild(sc);
  if (it.desc) { B.appendChild(el("h4", null, "Mô tả vật liệu theo BOQ")); const d = el("div", "wbox"); d.style.whiteSpace = "pre-wrap"; d.textContent = it.desc; B.appendChild(d); }
  if (it.warnings.length) { B.appendChild(el("h4", null, "Cần rà soát")); for (const w of it.warnings) B.appendChild(el("div", "wbox warn", "⚠ " + w)); }
  const linkRow = (key, title, sub, click, conf, pg) => {
    const r = el("div", "lk"); const c = el("div", "c"); c.appendChild(el("b", null, title)); if (sub) c.appendChild(el("small", null, sub)); if (conf) c.appendChild(el("small", "cf", conf));
    r.appendChild(c); r.onclick = click;
    if (pg && me) { const m0 = mainOf(id), on = m0 && m0.doc === pg.doc && m0.page === pg.page; const sb = el("button", "v" + (on ? " ok" : ""), "★"); sb.title = on ? "Đang là bản vẽ minh họa" : "Đặt làm bản vẽ minh họa của hạng mục"; sb.onclick = (e) => { e.stopPropagation(); setMain(id, pg.doc, pg.page); }; r.appendChild(sb); }
    if (key) {
      const v = el("button", "v", "?"); const paint = () => { const s = st.links[key]; v.className = "v" + (s === "ok" ? " ok" : s === "no" ? " no" : ""); v.textContent = s === "ok" ? "✓" : s === "no" ? "✗" : "?"; v.title = "Bấm để duyệt: ? → ✓ đúng → ✗ sai"; };
      paint(); v.onclick = (e) => { e.stopPropagation(); if (!me) return status("Cần đăng nhập để duyệt", 3000); st.links[key] = !st.links[key] ? "ok" : st.links[key] === "ok" ? "no" : ""; paint(); queueSave(); };
      r.appendChild(v);
    }
    return r;
  };
  B.appendChild(mainBox(id, it));
  B.appendChild(el("h4", null, "SPEC (" + it.specs.length + ")"));
  if (!it.specs.length) B.appendChild(el("div", "wbox warn", "Chưa có mã SPEC gắn với dòng này."));
  for (const s of it.specs) B.appendChild(linkRow("s:" + s.code, s.code + " · " + s.desc, s.loc + " · " + s.product + " · NCC: " + s.supplier, () => goPage(s.doc, s.page), s.conf === "cao" ? "Gợi ý: khớp tên" : "Gợi ý: tham khảo, cần xác nhận", { doc: s.doc, page: s.page }));
  B.appendChild(el("h4", null, "Bản vẽ (" + it.drawings.length + ")"));
  if (!it.drawings.length) B.appendChild(el("div", "wbox warn", "Chưa có bản vẽ DD cho dòng này."));
  for (const d of it.drawings) B.appendChild(linkRow("d:" + d.page, d.label, "Trang " + d.page + " – DD 1st Submission", () => goPage(d.doc, d.page), null, { doc: d.doc, page: d.page }));
  { // trang người dùng tự gắn từ bảng
    const ex = [];
    for (const [owner, d] of Object.entries(notes)) { const r = d.wbs && d.wbs[id]; if (r && r.extra) for (const x of r.extra) ex.push({ x, owner, d, mine: !!me && owner === me.email }); }
    B.appendChild(el("h4", null, "Trang gắn thêm từ bảng (" + ex.length + ")"));
    if (!ex.length) B.appendChild(el("div", "wbox", "Chọn trang trên bảng rồi bấm “＋ WBS” để gắn vào hạng mục này."));
    for (const e2 of ex) {
      const dd = board.docs[e2.x.doc];
      const r = linkRow(null, (dd ? dd.name : e2.x.doc) + " · tr." + e2.x.page, e2.mine ? "Bạn gắn" : "Bởi " + (e2.d.author || e2.owner), () => goPage(e2.x.doc, e2.x.page), null, { doc: e2.x.doc, page: e2.x.page });
      if (e2.mine) { const rm = el("button", "v", "✕"); rm.title = "Bỏ gắn"; rm.onclick = (ev) => { ev.stopPropagation(); st.extra = st.extra.filter((q) => q !== e2.x); queueSave(); openWbsItem(id, true); }; r.appendChild(rm); }
      B.appendChild(r);
    }
  }
  if (it.files.length) {
    B.appendChild(el("h4", null, "File CAD"));
    for (const f2 of it.files) B.appendChild(linkRow(null, f2.label, f2.path.split("/").pop(), () => { const u = src.openUrl(f2.path); if (u) window.open(u, "_blank"); else status("Chưa tìm thấy file trên Drive", 3000); }));
  }
  B.appendChild(el("h4", null, "Rà soát"));
  for (const [k, lab] of CHK) {
    const l = el("label"); const c = el("input"); c.type = "checkbox"; c.checked = !!st.chk[k]; c.disabled = !me;
    c.onchange = () => { st.chk[k] = c.checked; st.by = me.name || me.email; st.at = new Date().toISOString().slice(0, 10); queueSave(); renderWbs(); };
    l.append(c, document.createTextNode(" " + lab)); B.appendChild(l);
  }
  const ta = el("textarea"); ta.placeholder = me ? "Ghi chú của bạn… (Ctrl+V để dán hình)" : "Đăng nhập để ghi chú"; ta.value = st.note || ""; ta.disabled = !me;
  ta.oninput = () => { st.note = ta.value; st.by = me.name || me.email; st.at = new Date().toISOString().slice(0, 10); queueSave(); };
  B.appendChild(ta);
  { // hình mô tả tình trạng: dán Ctrl+V vào ô ghi chú, thêm file, hoặc cắt từ bảng
    const holder = el("div"), redraw = () => { holder.innerHTML = ""; holder.appendChild(thumbs(id, redraw)); renderWbs(); };
    const bar = el("div", "wnb"), fi = el("input"); fi.type = "file"; fi.accept = "image/*"; fi.multiple = true; fi.style.display = "none";
    fi.onchange = async () => { await pasteFiles(id, [...fi.files], redraw); fi.value = ""; };
    const b1 = el("button", null, "＋ Thêm ảnh"), b3 = el("button", null, "✂ Cắt hình từ bảng"); b1.onclick = () => fi.click(); b3.onclick = () => startCrop(id, false);
    b3.title = "Kéo chọn vùng trên một trang của bảng để thêm vào hạng mục này";
    if (!me) { b1.disabled = true; b3.disabled = true; }
    bar.append(b1, b3, el("small", null, "Hoặc bấm Ctrl+V trong ô ghi chú để dán hình"), fi); B.appendChild(bar);
    ta.addEventListener("paste", (e) => { const fl = [...(e.clipboardData ? e.clipboardData.files : [])].filter((x) => /^image\//.test(x.type)); if (fl.length) { e.preventDefault(); pasteFiles(id, fl, redraw); } });
    holder.appendChild(thumbs(id, redraw)); B.appendChild(holder);
  }
  const peers = wbsPeers(id); if (peers.length) B.appendChild(el("div", "who", "Đã duyệt bởi: " + peers.join(", ")));
  for (const [owner, d] of Object.entries(notes)) { const r = d.wbs && d.wbs[id]; if (r && r.note && !(me && owner === me.email)) B.appendChild(el("div", "wbox", (d.author || owner) + ": " + r.note)); }
  // đưa bản vẽ chính lên màn hình
  const first = mainOf(id) || it.drawings[0] || it.specs[0]; if (first && !noFocus) goPage(first.doc, first.page);
  renderSelBar();
}

/* ================= BỐ CỤC 4 CỘT: BOQ · BẢN VẼ · SPEC · CÁC HS KHÁC ================= */
// Mỗi file = 1 "bộ" (tiêu đề + line đậm + nút ẩn/hiện). File mới trên Drive tự hiện ra.
// Bố cục sửa riêng của mỗi người: notes[email].layout (v2). Trạng thái ẩn/hiện: notes[email].coll.
const clone = (o) => JSON.parse(JSON.stringify(o));
const BASE_COLS = [{ id: "BOQ", title: "BOQ" }, { id: "DWG", title: "BẢN VẼ" }, { id: "SPEC", title: "SPEC" }, { id: "OTH", title: "CÁC HS KHÁC" }];
const K = { colW: 2240, colGap: 160, colHead: 230, pad: 40, setHead: 120, setGap: 50, gap: 15, tableK: 1 };
const keyOf = (it) => it.type === "link" ? "K:" + it.path : it.doc + "#" + it.page;
const isPageKey = (k) => !k.startsWith("K:");
const MK = { red: ["#dc2626", "Cần sửa"], amber: ["#f59e0b", "Cần xem lại"], green: ["#16a34a", "Đã duyệt"], blue: ["#2563eb", "Quan trọng"] };
const hashStr = (s2) => { let h = 5381; for (let i = 0; i < s2.length; i++) h = ((h << 5) + h + s2.charCodeAt(i)) | 0; return Math.abs(h).toString(36); };
const r1 = (v) => Math.round(v * 10) / 10;
let files = [], origDone = false, docsAll = {}, SETS = new Map(), coll = {}, pendingIdx = [];
const docMeta = {}, sheetCache = {}, loadP = new Map(), loadErr = {}, setEls = new Map();

function classify(path, kind) {
  const p = norm(path);
  if (/boq|bao gia|du toan|budget|khoi luong|ngan sach/.test(p)) return "BOQ";
  if (kind === "xlsx") return /tien do|schedule|nhan su|danh sach/.test(p) ? "OTH" : "BOQ";
  if (/spec|material|finish|furniture|vat lieu|ff&e|catalog/.test(p)) return "SPEC";
  if (/dwg|drawing|ban ve|\bdd\b|\bsd\b|tkkt|layout|shop ?drawing|mat bang|\b3d\b/.test(p)) return "DWG";
  return "OTH";
}
function collectSets() {
  const S = new Map(), known = new Set(); let ord = 0;
  const GM = { A: "DWG", F: "DWG", B: "SPEC", C: "OTH", D: "OTH" };
  docsAll = clone(baseBoard.docs);
  for (const d of Object.values(baseBoard.docs)) { known.add(d.path); (d.dupes || []).forEach((p) => known.add(typeof p === "string" ? p : p.path)); }
  for (const it of baseBoard.items) {
    if (it.type !== "page") continue;
    const d = baseBoard.docs[it.doc]; let s = S.get(it.doc);
    if (!s) S.set(it.doc, s = { id: it.doc, title: d.name, path: d.path, kind: "pdf", pre: true, col: GM[d.group] || classify(d.path, "pdf"), ord: ord++, pages: [] });
    s.pages.push({ page: it.page, w: it.w, h: it.h, src: it.src, thumb: it.thumb });
  }
  const addFile = (path, size, mt, isNew) => {
    if (known.has(path) || /(^|\/)~\$/.test(path) || path.startsWith("_BOARD/")) return;
    const e = ((path.match(/\.(\w+)$/) || [])[1] || "").toLowerCase();
    if (!/^(pdf|xlsx|xlsm|xls)$/.test(e)) return;
    known.add(path);
    const kind = e === "pdf" ? "pdf" : "xlsx", id = "x" + hashStr(path), name = path.split("/").pop();
    S.set(id, { id, title: name, path, kind, col: classify(path, kind), ord: ord++, size, mt, isNew });
    const m = docMeta[id] || cachedMeta(path, mt); if (m) docMeta[id] = m;
    docsAll[id] = { name, path, pages: m ? m.n : (sheetCache[id] ? sheetCache[id].sheets.length : 0), kind, group: "", dupes: [], scanned: false };
  };
  const att = {};
  for (const it of baseBoard.items) {
    if (it.type !== "link") continue;
    if (/^xls/i.test(it.ext)) { addFile(it.path, it.size || 0, "", false); continue; }
    const g = baseBoard.groups.find((g2) => it.x >= g2.x && it.x <= g2.x + g2.w && it.y >= g2.y && it.y <= g2.y + g2.h);
    const col = (g && GM[g.id]) || "OTH", id = "att-" + col;
    if (!att[id]) S.set(id, att[id] = { id, title: "Tệp đính kèm (CAD, ZIP…)", kind: "links", col, ord: 5000 + ord++, links: [] });
    att[id].links.push(it);
  }
  for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path))) addFile(f.path, f.size, f.mt, true);
  return S;
}
function cachedMeta(path, mt) { try { const v = localStorage.getItem("pb_pm:" + path + "|" + (mt || "")); return v ? JSON.parse(v) : null; } catch (e) { return null; } }
function defCollapsed(s) { return (s.kind === "pdf" && !s.pre && (s.size || 0) > 20e6) || (s.kind === "xlsx" && (s.size || 0) > 8e6); }
const isCollapsed = (s) => (s.id in coll ? !!coll[s.id] : defCollapsed(s));

function normL(l) {
  if (!l || l.v !== 2) l = { v: 2 };
  l.cols = l.cols || {}; l.extra = l.extra || []; l.colOrder = l.colOrder || []; l.sets = l.sets || {}; l.o = l.o || {}; l.hide = l.hide || []; l.hideSets = l.hideSets || [];
  return l;
}
function hasLayout(d) { const l = d && d.layout; return !!l && l.v === 2 && (Object.keys(l.cols || {}).length + (l.extra || []).length + (l.colOrder || []).length + Object.keys(l.sets || {}).length + Object.keys(l.o || {}).length + (l.hide || []).length + (l.hideSets || []).length) > 0; }
function colList() {
  const l = L || normL(null), ids = [...BASE_COLS.map((c) => c.id), ...l.extra.map((c) => c.id)];
  const order = l.colOrder.filter((id) => ids.includes(id)); for (const id of ids) if (!order.includes(id)) order.push(id);
  return order.map((id) => { const b = BASE_COLS.find((c) => c.id === id), x = b || l.extra.find((c) => c.id === id), o = l.cols[id] || {}; return { id, title: o.title || x.title, w: o.w || K.colW, base: !!b }; });
}
const setColOf = (s, cols) => { const o = L && L.sets[s.id]; return o && cols.some((c) => c.id === o.col) ? o.col : s.col; };
const ordOf = (s) => { const o = L && L.sets[s.id]; return o && o.ord != null ? o.ord : s.ord; };
function rawItems(s, iw) {
  const fit = (w, h) => { const f = Math.min(1, iw / w); return [r1(w * f), r1(h * f)]; };
  if (s.kind === "links") return s.links.map((l) => ({ type: "link", path: l.path, name: l.name, ext: l.ext, w: 230, h: 46 }));
  if (s.pre) return s.pages.map((p) => { const [w, h] = fit(p.w, p.h); return { type: "page", kind: "img", page: p.page, w, h, src: p.src, thumb: p.thumb }; });
  if (loadErr[s.id]) return null;
  if (s.kind === "pdf") { const m = docMeta[s.id]; if (!m) return null; return m.sz.map((wh, i) => { const [w, h] = fit(wh[0], wh[1]); return { type: "page", kind: "pdf", page: i + 1, w, h }; }); }
  const c = sheetCache[s.id]; if (!c) return null;
  return c.sheets.map((sh, i) => { const k = Math.min(K.tableK, iw / sh.pw); return { type: "page", kind: "sheet", page: i + 1, name: sh.name, w: r1(sh.pw * k), h: r1(sh.ph * k), k, sh }; });
}
function layoutBoard() {
  const cols = colList(), l = L || normL(null), hideS = new Set(l.hideSets), hide = new Set(l.hide), O = l.o;
  const groups = [], sets = [], items = [], all = [...SETS.values()]; let x = 0;
  for (const c of cols) {
    const list = all.filter((s) => !hideS.has(s.id) && setColOf(s, cols) === c.id).sort((a, b) => ordOf(a) - ordOf(b));
    let y = K.colHead;
    for (const s of list) {
      const sx = x + K.pad, sw = c.w - 2 * K.pad, cx = sx + 20, cy = y + K.setHead + 16, iw = sw - 40;
      const st = { id: s.id, s, x: sx, y, w: sw, col: c.id, cx, cy, collapsed: isCollapsed(s), state: "ok", n: 0 };
      let h = K.setHead;
      if (!st.collapsed) {
        const raw = rawItems(s, iw);
        if (!raw) { st.state = loadErr[s.id] ? "err" : "need"; h = K.setHead + 180; }
        else {
          let rx = 0, ry = 0, rh = 0, bottom = 0;
          for (const r of raw) {
            r.doc = s.id; const key = keyOf(r);
            if (hide.has(key)) continue;
            if (rx > 0 && rx + r.w > iw) { rx = 0; ry += rh + K.gap; rh = 0; }
            let px = rx, py = ry; rx += r.w + K.gap; rh = Math.max(rh, r.h);
            const o = O[key]; if (o) { px = o.x; py = o.y; }
            Object.assign(r, { x: r1(cx + px), y: r1(cy + py), ox: cx, oy: cy, set: s.id });
            items.push(r); bottom = Math.max(bottom, py + r.h); st.n++;
          }
          h = Math.max(K.setHead + 16 + bottom + 30, K.setHead + 70);
        }
      }
      st.h = h; sets.push(st); y += h + K.setGap;
    }
    groups.push({ id: c.id, title: c.title, base: c.base, x, y: 0, w: c.w, h: Math.max(y + K.pad, 1600) });
    x += c.w + K.colGap;
  }
  return { groups, sets, items };
}
function rebuildBoard() {
  SETS = collectSets();
  const lay = layoutBoard();
  board = { project: baseBoard.project, docs: docsAll, groups: lay.groups, sets: lay.sets, items: lay.items };
  build(); applySelection(); renderAnnotations();
  for (const st of board.sets) if (st.state === "need") ensureLoaded(st.s);
}
let rbT = 0;
function scheduleRebuild() {
  clearTimeout(rbT);
  rbT = setTimeout(() => { const a = document.activeElement; if (eDrag || (a && world.contains(a) && a.isContentEditable)) return scheduleRebuild(); rebuildBoard(); }, 150);
}
function infoText(st) {
  const s = st.s; let t;
  if (s.kind === "links") t = s.links.length + " tệp";
  else if (s.kind === "xlsx") t = sheetCache[s.id] ? sheetCache[s.id].sheets.length + " sheet" : "Excel";
  else t = (docsAll[s.id] && docsAll[s.id].pages ? docsAll[s.id].pages + " trang" : "PDF");
  if (s.size && !s.pre) t += " · " + (s.size / 1048576).toFixed(1) + " MB";
  if (st.collapsed) t += " · đang ẩn";
  return t;
}

/* ----- dựng phần tử trên bảng ----- */
function build() {
  world.innerHTML = ""; pageEls.length = 0; nodeEls.clear(); setEls.clear();
  const B = (cls, txt, title, fn) => { const b = el("button", cls, txt); b.title = title; b.onclick = fn; return b; };
  for (const g of board.groups) {
    const d = el("div", "grp"); d.dataset.gid = g.id; Object.assign(d.style, { left: g.x + "px", top: g.y + "px", width: g.w + "px", height: g.h + "px" });
    d.appendChild(el("div", "gt", g.title));
    const c = el("div", "gctl");
    c.append(B(null, "⊟", "Ẩn tất cả các bộ trong vùng này", () => collapseCol(g.id, true)), B(null, "⊞", "Hiện tất cả các bộ trong vùng này", () => collapseCol(g.id, false)));
    c.append(B("eo", "✎", "Đổi tên vùng", () => renameCol(g.id)));
    if (!g.base) c.append(B("eo danger", "✕", "Xoá vùng (các bộ bên trong trở về vùng mặc định)", () => deleteCol(g.id)));
    const gm = el("div", "gm eo", "✥"); gm.title = "Kéo để đổi thứ tự vùng";
    c.prepend(gm); d.appendChild(c);
    const gw = el("div", "gw eo"); gw.title = "Kéo để đổi độ rộng vùng"; d.appendChild(gw);
    world.appendChild(d);
  }
  for (const st of board.sets) {
    const d = el("div", "set" + (st.collapsed ? " col" : "")); d.dataset.sid = st.id;
    Object.assign(d.style, { left: st.x + "px", top: st.y + "px", width: st.w + "px", height: st.h + "px" });
    const h = el("div", "sh"); h.title = st.s.path || "";
    h.appendChild(B("tg", st.collapsed ? "▸ Hiện" : "▾ Ẩn", st.collapsed ? "Hiện bộ hồ sơ này" : "Ẩn bộ này (chỉ còn tiêu đề) cho nhẹ bảng", () => toggleSet(st.id)));
    h.appendChild(el("b", null, st.s.title));
    if (st.s.isNew) h.appendChild(el("span", "new", "MỚI"));
    h.appendChild(el("small", null, infoText(st)));
    const bs = el("span", "sb");
    if (st.s.path) bs.appendChild(B(null, "📂", "Mở file gốc trên Drive", () => openPath(st.s.path)));
    bs.appendChild(B("eo danger", "✕", "Gỡ bộ này khỏi bảng (khôi phục được)", () => removeSet(st.id)));
    h.appendChild(bs); d.appendChild(h);
    if (!st.collapsed && st.state !== "ok") d.appendChild(el("div", "ph", st.state === "err" ? "⚠ Không đọc được file: " + loadErr[st.id] : "Đang tải " + (st.s.kind === "xlsx" ? "Excel" : "PDF") + "…"));
    world.appendChild(d); setEls.set(st.id, { st, el: d });
  }
  for (const it of board.items) {
    const k = keyOf(it);
    if (it.type === "page") {
      const d = el("div", "pg" + (it.kind === "sheet" ? " sheet" : "")); Object.assign(d.style, { left: it.x + "px", top: it.y + "px", width: it.w + "px", height: it.h + "px" });
      d.dataset.doc = it.doc; d.dataset.page = it.page; d.dataset.k = k;
      const img = el("img"); img.alt = ""; img.draggable = false; if (it.kind !== "sheet") d.appendChild(img);
      d.appendChild(el("span", "pn", it.kind === "sheet" ? it.name : it.page + "/" + ((board.docs[it.doc] || {}).pages || "?")));
      world.appendChild(d); pageEls.push({ it, el: d, img, level: 0, want: 0 });
      nodeEls.set(k, { it, el: d });
    } else {
      const d = el("div", "lnk"); Object.assign(d.style, { left: it.x + "px", top: it.y + "px", width: it.w + "px", height: it.h + "px" });
      d.dataset.path = it.path; d.dataset.k = k; d.title = it.path + "\n(bấm để mở)";
      if (origDone && src.has && !src.has(it.path)) d.classList.add("nf");
      d.appendChild(el("span", "ext " + it.ext, it.ext)); d.appendChild(el("span", "nm", it.name));
      d.addEventListener("click", () => { if (editMode) return; openPath(it.path); });
      world.appendChild(d); nodeEls.set(k, { it, el: d });
    }
  }
  const g2 = el("div"); g2.id = "insbar"; g2.className = "hidden"; world.appendChild(g2);
  buildToc(); apply();
}
function openPath(p) { const u = src.openUrl(p); if (u) window.open(u, "_blank"); else status("Chưa tìm thấy file trên Drive (đang đồng bộ?)", 4000); }
function buildToc() {
  const toc = $("#toc"); toc.innerHTML = "";
  for (const g of board.groups) {
    const box = el("div", "tg"), h = el("div", "th", g.title); h.onclick = () => focusRect(g, 0.02); box.appendChild(h);
    for (const st of board.sets.filter((t) => t.col === g.id)) {
      const r = el("div", "td" + (st.collapsed ? " off" : "")), eye = el("span", "eye", st.collapsed ? "▸" : "▾");
      eye.title = st.collapsed ? "Hiện bộ này" : "Ẩn bộ này"; eye.onclick = (ev) => { ev.stopPropagation(); toggleSet(st.id); };
      r.append(eye, document.createTextNode(" " + st.s.title + " "), el("small", null, infoText(st)));
      r.title = st.s.path || ""; r.onclick = () => { if (st.collapsed) { coll[st.id] = false; saveColl(); rebuildBoard(); } const t = board.sets.find((x) => x.id === st.id); if (t) focusRect(t, 0.03); };
      box.appendChild(r);
    }
    toc.appendChild(box);
  }
}
function saveColl() {
  if (me) { myNotes().coll = coll; queueSave(); }
  try { localStorage.setItem("pb_coll", JSON.stringify(coll)); } catch (e) {}
}
function toggleSet(id) { const s = SETS.get(id); if (!s) return; coll[id] = !isCollapsed(s); saveColl(); rebuildBoard(); }
function collapseCol(gid, v) { for (const st of board.sets) if (st.col === gid) coll[st.id] = v; saveColl(); rebuildBoard(); status(v ? "Đã ẩn các bộ trong vùng" : "Đã hiện các bộ trong vùng", 2000); }
async function revealPage(doc, page) {
  const s = SETS.get(doc); if (!s) return null;
  if (L && L.hideSets.includes(doc)) { status("Bộ này đang bị gỡ khỏi bảng (khôi phục trong chế độ Sửa bảng)", 4000); return null; }
  if (isCollapsed(s)) { coll[doc] = false; saveColl(); rebuildBoard(); }
  let pe = pageEls.find((p) => p.it.doc === doc && p.it.page === page);
  if (!pe && !s.pre) { await ensureLoaded(s); rebuildBoard(); pe = pageEls.find((p) => p.it.doc === doc && p.it.page === page); }
  return pe || null;
}

/* ----- nạp PDF mới / Excel ----- */
function ensureLoaded(s) {
  if (loadP.has(s.id)) return loadP.get(s.id);
  const p = (async () => {
    try { if (s.kind === "xlsx") await loadSheets(s); else await loadPdfMeta(s); }
    catch (e) { loadErr[s.id] = e.message || String(e); console.warn(e); }
    scheduleRebuild();
  })();
  loadP.set(s.id, p); return p;
}
async function loadPdfMeta(s) {
  const pdf = await getPdf(s.id), n = Math.min(pdf.numPages, 300), sz = [];
  for (let i = 1; i <= n; i++) { const v = (await pdf.getPage(i)).getViewport({ scale: 1 }); sz.push([r1(v.width * 0.3528), r1(v.height * 0.3528)]); }
  docMeta[s.id] = { n: pdf.numPages, sz };
  try { localStorage.setItem("pb_pm:" + s.path + "|" + (s.mt || ""), JSON.stringify(docMeta[s.id])); } catch (e) {}
}
let xlsxLib = null;
function loadXlsxLib() {
  if (window.XLSX) return Promise.resolve();
  return xlsxLib || (xlsxLib = new Promise((res, rej) => { const sc = document.createElement("script"); sc.src = "lib/xlsx.full.min.js?v=1"; sc.onload = res; sc.onerror = () => rej(new Error("không tải được thư viện Excel")); document.head.appendChild(sc); }));
}
function sheetRender(ws, name) {
  const ref = ws["!ref"]; if (!ref) return null;
  const r = XLSX.utils.decode_range(ref), R = Math.min(r.e.r, r.s.r + 599), C = Math.min(r.e.c, r.s.c + 39);
  ws["!ref"] = XLSX.utils.encode_range({ s: r.s, e: { r: R, c: C } });
  let html = XLSX.utils.sheet_to_html(ws, { header: "", footer: "" });
  const text = XLSX.utils.sheet_to_csv(ws, { FS: " ", blankrows: false });
  ws["!ref"] = ref;
  const cols = ws["!cols"] || []; let cg = "<colgroup>", tw = 0;
  for (let c = r.s.c; c <= C; c++) { const o = cols[c] || {}; let w = o.hidden ? 2 : (o.wpx || (o.wch ? Math.round(o.wch * 7 + 5) : (o.width ? Math.round(o.width * 7) : 64))); w = Math.max(2, Math.min(w, 600)); cg += `<col style="width:${w}px">`; tw += w; }
  const more = (r.e.r > R ? ` · hiện ${R - r.s.r + 1}/${r.e.r - r.s.r + 1} dòng` : "") + (r.e.c > C ? ` · ${C - r.s.c + 1}/${r.e.c - r.s.c + 1} cột` : "");
  html = html.replace(/ id="sjs-[^"]*"/g, "").replace(/ data-v="[^"]*"/g, "").replace(/^[\s\S]*?<table[^>]*>/, `<table class="xt" style="width:${tw}px"><caption>${esc(name)}<small>${more}</small></caption>${cg}</colgroup>`);
  return { html, text };
}
async function loadSheets(s) {
  await loadXlsxLib();
  const buf = await src.pdfData(s.path);
  const wb = XLSX.read(new Uint8Array(buf), { type: "array", cellStyles: true });
  let m = $("#xm"); if (!m) { m = el("div"); m.id = "xm"; document.body.appendChild(m); }
  const out = [];
  wb.SheetNames.forEach((name, i) => {
    const info = wb.Workbook && wb.Workbook.Sheets && wb.Workbook.Sheets[i]; if (info && info.Hidden) return;
    const r = sheetRender(wb.Sheets[name], name); if (!r) return;
    m.innerHTML = r.html; const t = m.firstChild;
    out.push({ name, html: r.html, pw: Math.ceil(t.offsetWidth), ph: Math.ceil(t.offsetHeight), text: r.text });
  });
  m.innerHTML = "";
  sheetCache[s.id] = { sheets: out };
  addIndex(out.map((sh, i) => { const text = (s.title + " · " + sh.name + "\n" + sh.text).normalize("NFC"); return { doc: s.id, page: i + 1, text, n: normC(text) }; }));
}
function addIndex(arr) { if (index) index.push(...arr); else pendingIdx.push(...arr); }
function buildSheetEl(p) {
  const it = p.it, w = el("div", "xw"); w.style.width = it.sh.pw + "px"; w.style.transform = `scale(${it.k})`; w.innerHTML = it.sh.html;
  p.el.insertBefore(w, p.el.firstChild); p.built = true;
}

/* ----- thumbnail trang PDF mới (pdf.js) ----- */
const renderCache = new Map(); let renderChain = Promise.resolve();
function queueRender(p) {
  if (p.rendering) return;
  const k = keyOf(p.it);
  if (renderCache.has(k)) { p.img.src = renderCache.get(k); p.level = 1; return; }
  p.rendering = true;
  renderChain = renderChain.then(async () => {
    try {
      const pdf = await getPdf(p.it.doc), page = await pdf.getPage(p.it.page), v0 = page.getViewport({ scale: 1 }), v = page.getViewport({ scale: 520 / v0.width });
      const cv = document.createElement("canvas"); cv.width = Math.floor(v.width); cv.height = Math.floor(v.height);
      const ctx = cv.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, cv.width, cv.height);
      await page.render({ canvasContext: ctx, viewport: v }).promise;
      const blob = await new Promise((r) => cv.toBlob(r, "image/jpeg", 0.82)), u = URL.createObjectURL(blob);
      renderCache.set(k, u); if (p.el.isConnected) { p.img.src = u; p.level = 1; }
    } catch (e) { console.warn("render", e); p.failed = true; }
    p.rendering = false;
  });
}

/* ----- bố cục của ai ----- */
function renderAnnotations() { renderNotes(); renderPins(); renderMarks(); renderShapes(); }
function curL() { if (layoutOwner === "base") return null; const d = notes[layoutOwner]; return d && d.layout && d.layout.v === 2 ? normL(d.layout) : null; }
function setLayoutOwner(o) {
  if (editMode && !(me && o === me.email)) setEditMode(false);
  layoutOwner = o; L = curL(); if (me && o === me.email && !L) { myNotes().layout = L = normL(null); }
  try { localStorage.setItem("pb_layout", o === "base" ? "base" : (me && o === me.email ? "me" : o)); } catch (e) {}
  rebuildBoard(); renderLayoutSel();
  status(o === "base" ? "Đang xem bố cục mặc định" : "Đang xem bố cục của " + (me && o === me.email ? "bạn" : (notes[o].author || o)), 2500);
}
function renderLayoutSel() {
  const s = $("#layoutSel"); s.innerHTML = "";
  const add = (v, t) => { const o = el("option", null, t); o.value = v; s.appendChild(o); };
  add("base", "Bố cục mặc định");
  if (me) add(me.email, "Bố cục của tôi");
  for (const [owner, d] of Object.entries(notes)) if (hasLayout(d) && !(me && owner === me.email)) add(owner, "Bố cục: " + (d.author || owner));
  s.value = layoutOwner; if (s.value !== layoutOwner) s.value = "base";
  s.classList.toggle("hidden", !board);
}
function initLayoutAfterNotes() {
  let want = "base"; try { want = localStorage.getItem("pb_layout") || ""; } catch (e) {}
  const mineHas = me && hasLayout(notes[me.email]);
  if (want === "base") layoutOwner = "base";
  else if (want && want !== "me" && notes[want] && hasLayout(notes[want])) layoutOwner = want;
  else layoutOwner = mineHas ? me.email : "base";
  L = curL();
  if (me && notes[me.email] && notes[me.email].coll) coll = notes[me.email].coll;
  rebuildBoard(); renderLayoutSel(); histReset();
}
$("#layoutSel").onchange = (e) => setLayoutOwner(e.target.value);

/* ----- hoàn tác (bố cục + hình vẽ của tôi) ----- */
let hist = [], hpos = 0;
function snap0() { const m = me ? myNotes() : {}; return JSON.stringify({ L: m.layout && m.layout.v === 2 ? m.layout : null, S: m.shapes || [] }); }
function histReset() { hist = [snap0()]; hpos = 0; renderEditBar(); }
function commit() {
  hist = hist.slice(0, hpos + 1); hist.push(snap0()); hpos = hist.length - 1;
  if (hist.length > 100) { hist.shift(); hpos--; }
  queueSave(); renderEditBar(); renderLayoutSel();
}
function restoreHist() {
  const o = JSON.parse(hist[hpos]), m = myNotes();
  m.shapes = o.S;
  if (me && layoutOwner === me.email) m.layout = L = normL(o.L); else m.layout = o.L;
  selShape = null; rebuildBoard(); queueSave(); renderEditBar();
}
function undo() { if (hpos > 0) { hpos--; restoreHist(); } }
function redo() { if (hpos < hist.length - 1) { hpos++; restoreHist(); } }
function renderEditBar() { $("#eUndo").disabled = hpos <= 0; $("#eRedo").disabled = hpos >= hist.length - 1; }

/* ----- chế độ sửa bảng ----- */
function setEditMode(on) {
  if (on) {
    if (!me) return status("Cần đăng nhập Google để sửa bố cục", 3000);
    if (layoutOwner !== me.email) { myNotes().layout = L = normL(L ? clone(L) : null); layoutOwner = me.email; renderLayoutSel(); histReset(); }
    setTool("select");
  }
  editMode = on; document.body.classList.toggle("editing", on);
  $("#editbar").classList.toggle("hidden", !on); $("#btnEdit").classList.toggle("on", on);
  rebuildBoard(); renderEditBar(); renderSelBar();
  status(on ? "Kéo trang · kéo tiêu đề bộ để đổi chỗ · ✥ đổi thứ tự vùng · quét khung chọn nhiều · Delete gỡ · Ctrl+Z" : "Đã thoát chế độ sửa", on ? 7000 : 2000);
}
$("#btnEdit").onclick = () => setEditMode(!editMode);
$("#eDone").onclick = () => setEditMode(false);
$("#eUndo").onclick = undo; $("#eRedo").onclick = redo;
$("#eAdd").onclick = () => openRestore();
$("#eGroup").onclick = () => { L.extra.push({ id: "Z" + Date.now().toString(36), title: "Vùng mới" }); commit(); rebuildBoard(); status("Đã thêm vùng mới ở cuối bảng – kéo tiêu đề bộ hồ sơ vào đó", 4000); };
$("#eReset").onclick = () => { if (!confirm("Đưa bảng về bố cục mặc định 4 vùng? (Ctrl+Z để hoàn tác)")) return; myNotes().layout = L = normL(null); commit(); rebuildBoard(); };
function renameCol(id) { const g = board.groups.find((x) => x.id === id); const v = prompt("Tên vùng:", g.title); if (v == null || !v.trim()) return; L.cols[id] = Object.assign(L.cols[id] || {}, { title: v.trim() }); commit(); rebuildBoard(); }
function deleteCol(id) {
  const g = board.groups.find((x) => x.id === id); if (!confirm("Xoá vùng “" + g.title + "”? Các bộ hồ sơ bên trong trở về vùng mặc định của chúng.")) return;
  L.extra = L.extra.filter((c) => c.id !== id); delete L.cols[id]; L.colOrder = L.colOrder.filter((c) => c !== id);
  for (const [k, v] of Object.entries(L.sets)) if (v.col === id) delete L.sets[k];
  commit(); rebuildBoard();
}
function removeSet(id) { const s = SETS.get(id); if (!confirm("Gỡ bộ “" + s.title + "” khỏi bảng?\n(File gốc không bị xoá; khôi phục bằng nút ↺ Khôi phục.)")) return; L.hideSets.push(id); commit(); rebuildBoard(); }

/* ----- chọn trang ----- */
let lastClick = { k: "", t: 0 };
function registerClick(k) { const now = performance.now(), dbl = lastClick.k === k && now - lastClick.t < 400; lastClick = dbl ? { k: "", t: 0 } : { k, t: now }; return dbl; }
function boardClick(e) {
  const t = document.elementFromPoint(e.clientX, e.clientY), n = t && t.closest && t.closest(".pg");
  const multi = e.shiftKey || e.ctrlKey || e.metaKey;
  if (!n) { if (!multi && sel.size) { sel.clear(); applySelection(); } return; }
  const k = n.dataset.k;
  if (registerClick(k)) { const nd = nodeEls.get(k); if (nd) focusRect(nd.it, 0.04); return; }
  if (multi) { if (sel.has(k)) sel.delete(k); else sel.add(k); } else { sel.clear(); sel.add(k); }
  applySelection();
}
function paintSel() { for (const [k, n] of nodeEls) n.el.classList.toggle("sel", sel.has(k)); }
function applySelection() { for (const k of [...sel]) if (!nodeEls.has(k)) sel.delete(k); paintSel(); renderSelBar(); }
const selNodes = () => [...sel].map((k) => nodeEls.get(k)).filter(Boolean);
const boxOf = (n) => ({ x: n.it.x, y: n.it.y, w: n.it.w, h: n.it.h });
function moveNode(n, x, y) { n.it.x = r1(x); n.it.y = r1(y); n.el.style.left = n.it.x + "px"; n.el.style.top = n.it.y + "px"; }
function recordMoves(ns) { for (const n of ns) L.o[keyOf(n.it)] = { x: r1(n.it.x - n.it.ox), y: r1(n.it.y - n.it.oy) }; }
function renderSelBar() {
  const bar = $("#selbar"); bar.innerHTML = "";
  if (!sel.size) { bar.classList.add("hidden"); return; }
  bar.classList.remove("hidden");
  const keys = [...sel], pk = keys.filter(isPageKey);
  bar.appendChild(el("b", null, pk.length === keys.length ? keys.length + " trang" : keys.length + " mục"));
  const btn = (txt, title, fn, cls) => { const b = el("button", cls || null, txt); b.title = title; b.onclick = fn; bar.appendChild(b); return b; };
  if (pk.length === 1) {
    btn("🔍", "Phóng to trang này", () => { const n = nodeEls.get(pk[0]); if (n) focusRect(n.it, 0.04); });
    btn("📂 File gốc", "Mở file gốc trên Drive", () => { const d = board.docs[pk[0].split("#")[0]]; if (d) openPath(d.path); });
  }
  if (pk.length) {
    const sw = el("span", "sw");
    for (const [c, [hex, lab]] of Object.entries(MK)) { const i = el("i"); i.style.background = hex; i.title = "Đánh dấu: " + lab; i.onclick = () => setMark(pk, c); sw.appendChild(i); }
    const clr = el("i", "clr", "∅"); clr.title = "Bỏ đánh dấu"; clr.onclick = () => setMark(pk, ""); sw.appendChild(clr);
    bar.appendChild(sw);
    btn("＋ WBS", "Gắn các trang đã chọn vào một hạng mục WBS", () => wbsPick(pk));
    if (wbsCur && pk.length === 1 && me) { const [d0, p0] = pk[0].split("#"); btn("★ Bản vẽ minh họa cho hạng mục đang mở", "Đặt trang này làm bản vẽ minh họa của hạng mục WBS đang mở", () => setMain(wbsCur, d0, +p0), "pri"); }
  }
  if (editMode) {
    bar.appendChild(el("span", "sep"));
    btn("⇤", "Căn trái", () => alignSel("l")); btn("⤒", "Căn trên", () => alignSel("t"));
    btn("↔", "Dàn đều ngang", () => alignSel("h")); btn("↕", "Dàn đều dọc", () => alignSel("v"));
    btn("▦", "Xếp lưới…", gridSel);
    btn("↺", "Trả về vị trí tự động trong bộ", () => { for (const k of keys) delete L.o[k]; commit(); rebuildBoard(); });
    btn("🗑", "Gỡ khỏi bảng (Delete) – file gốc không bị xoá", deleteSelection, "danger");
  }
  btn("✕", "Bỏ chọn (Esc)", () => { sel.clear(); applySelection(); });
}

/* ----- đánh dấu màu ----- */
function markOf(k) { let r = null; for (const [owner, d] of Object.entries(notes)) { const c = d.marks && d.marks[k]; if (c) { if (me && owner === me.email) return c; r = r || c; } } return r; }
function setMark(keys, c) {
  if (!me) return status("Cần đăng nhập để đánh dấu", 3000);
  const m = (myNotes().marks = myNotes().marks || {});
  for (const k of keys) { if (c) m[k] = c; else delete m[k]; }
  queueSave(); renderMarks(); status(c ? "Đã đánh dấu " + keys.length + " trang: " + MK[c][1] : "Đã bỏ đánh dấu", 2000);
}
function renderMarks() {
  for (const [k, n] of nodeEls) {
    if (!isPageKey(k)) continue;
    const c = markOf(k);
    if (c && MK[c]) { n.el.dataset.mark = c; n.el.style.setProperty("--mk", MK[c][0]); } else { delete n.el.dataset.mark; n.el.style.removeProperty("--mk"); }
  }
}

/* ----- ghim ----- */
let pinEls = [];
function renderPins() {
  world.querySelectorAll(".pin").forEach((e) => e.remove()); pinEls = [];
  for (const [owner, d] of Object.entries(notes)) {
    const mine = !!me && owner === me.email;
    for (const pn of d.pins || []) {
      if (!nodeEls.has(pn.k)) continue;
      const box = el("div", "pin" + (mine ? " mine" : "")); box.dataset.id = pn.id;
      box.appendChild(el("div", "pd", "📍"));
      const pb = el("div", "pb"), t = el("div", "txt"); t.textContent = pn.text || ""; t.contentEditable = mine ? "true" : "false";
      t.addEventListener("input", () => { pn.text = t.innerText; pn.t = new Date().toISOString(); queueSave(); });
      pb.appendChild(t); pb.appendChild(el("div", "au", (d.author || owner) + " · " + (pn.t || "").slice(0, 10)));
      if (mine) { const del = el("button", "del", "✕"); del.title = "Xoá ghim"; del.onclick = () => { if (!confirm("Xoá ghim này?")) return; d.pins = d.pins.filter((x) => x !== pn); renderPins(); queueSave(); }; pb.appendChild(del); }
      box.appendChild(pb); box.firstChild.onclick = () => box.classList.toggle("open");
      world.appendChild(box); pinEls.push({ el: box, pn });
    }
  }
  placePins();
}
function placePins() { for (const { el: e, pn } of pinEls) { const n = nodeEls.get(pn.k); if (!n) continue; e.style.left = (n.it.x + pn.fx * n.it.w) + "px"; e.style.top = (n.it.y + pn.fy * n.it.h) + "px"; } }
function addPinAt(e) {
  if (!me) return status("Cần đăng nhập để ghim", 3000);
  const pg = e.target.closest && e.target.closest(".pg"); if (!pg) return status("Bấm vào một trang để ghim", 2500);
  const n = nodeEls.get(pg.dataset.k), p = toWorld(e);
  const pn = { id: Date.now().toString(36), k: pg.dataset.k, fx: Math.round((p.x - n.it.x) / n.it.w * 1000) / 1000, fy: Math.round((p.y - n.it.y) / n.it.h * 1000) / 1000, text: "", t: new Date().toISOString() };
  (myNotes().pins = myNotes().pins || []).push(pn); renderPins(); setTool("select");
  const pe = pinEls.find((x) => x.pn === pn); if (pe) { pe.el.classList.add("open"); const t = pe.el.querySelector(".txt"); setTimeout(() => t.focus(), 0); }
  queueSave();
}

/* ----- hình vẽ: đám mây, chữ nhật, mũi tên, chữ, highlight ----- */
const DRAW = { cloud: 1, rect: 1, arrow: 1, text: 1, hl: 1, crop: 1 };
const COLORS = ["#dc2626", "#f97316", "#facc15", "#16a34a", "#2563eb", "#9333ea", "#111827"];
let curColor = localStorage.getItem("pb_color") || COLORS[0], selShape = null, drawTmp = null;
(function initColors() {
  const box = $("#colors");
  for (const c of COLORS) { const i = el("i"); i.style.background = c; i.dataset.c = c; i.title = "Màu nét"; i.onclick = () => pickColor(c); box.appendChild(i); }
  paintColors();
})();
function paintColors() { document.querySelectorAll("#colors i").forEach((i) => i.classList.toggle("on", i.dataset.c === curColor)); }
function pickColor(c) {
  curColor = c; try { localStorage.setItem("pb_color", c); } catch (e) {} paintColors();
  const s = selShape && myShapes().find((x) => x.id === selShape); if (s) { s.c = c; commit(); renderShapes(); }
}
function myShapes() { const m = myNotes(); return (m.shapes = m.shapes || []); }
function allShapes() { const o = []; for (const [owner, d] of Object.entries(notes)) for (const sh of d.shapes || []) o.push({ sh, owner, d, mine: !!me && owner === me.email }); return o; }
function geo(sh) {
  const n = sh.k ? nodeEls.get(sh.k) : null; if (sh.k && !n) return null;
  const tr = (x, y) => n ? [n.it.x + x * n.it.w, n.it.y + y * n.it.h] : [x, y];
  const [x0, y0] = tr(sh.p[0], sh.p[1]); if (sh.t === "text") return { x0, y0 };
  const [x1, y1] = tr(sh.p[2], sh.p[3]); return { x0, y0, x1, y1 };
}
function cloudPath(x0, y0, x1, y1, r) {
  const Lx = Math.min(x0, x1), T = Math.min(y0, y1), R = Math.max(x0, x1), Bt = Math.max(y0, y1), pts = [];
  const edge = (ax, ay, bx, by) => { const n = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay) / (2 * r))); for (let i = 1; i <= n; i++) pts.push([ax + (bx - ax) * i / n, ay + (by - ay) * i / n]); };
  edge(Lx, T, R, T); edge(R, T, R, Bt); edge(R, Bt, Lx, Bt); edge(Lx, Bt, Lx, T);
  let d = `M${r1(Lx)},${r1(T)}`, px = Lx, py = T;
  for (const [x, y] of pts) { const c = r1(Math.hypot(x - px, y - py) / 2 * 1.15); d += ` A${c},${c} 0 0 1 ${r1(x)},${r1(y)}`; px = x; py = y; }
  return d + "Z";
}
function shapeSvg(sh, g, sid, cls) {
  if (sh.t === "crop") { const x = Math.min(g.x0, g.x1), y = Math.min(g.y0, g.y1), w0 = Math.abs(g.x1 - g.x0), h0 = Math.abs(g.y1 - g.y0), s = 2.5 / (sh.w ? 2.5 / sh.w : 1); return `<g class="tmp"><path d="M${x},${y}h${w0}v${h0}h${-w0}Z" fill="#2563eb" fill-opacity=".14" stroke="#1d4ed8" stroke-width="${sh.w * 1.2}" stroke-dasharray="${sh.w * 4} ${sh.w * 3}"/></g>`; }
  const c = /^#[0-9a-f]{3,8}$/i.test(sh.c) ? sh.c : "#dc2626", w = sh.w || 3;
  const Lx = Math.min(g.x0, g.x1), T = Math.min(g.y0, g.y1), W = Math.abs(g.x1 - g.x0), H = Math.abs(g.y1 - g.y0);
  let d;
  if (sh.t === "rect" || sh.t === "hl") d = `M${Lx},${T}h${W}v${H}h${-W}Z`;
  else if (sh.t === "cloud") d = cloudPath(g.x0, g.y0, g.x1, g.y1, Math.max(w * 5, Math.min(W, H) / 10, 4));
  else { const a = Math.atan2(g.y1 - g.y0, g.x1 - g.x0), hl = Math.max(w * 5, 10); const h1 = [g.x1 - hl * Math.cos(a - 0.45), g.y1 - hl * Math.sin(a - 0.45)], h2 = [g.x1 - hl * Math.cos(a + 0.45), g.y1 - hl * Math.sin(a + 0.45)]; d = `M${g.x0},${g.y0}L${g.x1},${g.y1}M${h1}L${g.x1},${g.y1}L${h2}`; }
  const vis = sh.t === "hl" ? `<path d="${d}" fill="${c}" fill-opacity=".33" stroke="none"/>` : `<path d="${d}" fill="none" stroke="${c}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`;
  const hit = sid ? `<path class="hit" data-sid="${sid}" d="${d}" fill="${sh.t === "hl" ? "transparent" : "none"}" stroke="transparent" stroke-width="${w * 4 + 6}"/>` : "";
  const box = cls === "on" ? `<rect class="sbox" x="${Lx - w * 2}" y="${T - w * 2}" width="${W + w * 4}" height="${H + w * 4}"/>` : "";
  return `<g class="${cls || ""}">${vis}${hit}${box}</g>`;
}
function renderShapes() {
  world.querySelectorAll(".shp,.tx").forEach((e) => e.remove());
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"); svg.setAttribute("class", "shp"); svg.setAttribute("width", "1"); svg.setAttribute("height", "1"); world.appendChild(svg);
  for (const { sh, owner, d, mine } of allShapes()) {
    if (sh.t !== "text") continue;
    const box = el("div", "tx" + (mine ? " mine" : "")); box.dataset.sid = sh.id; box.style.color = sh.c; box.style.transform = `scale(${sh.fs || 1})`;
    if (mine) { const hd = el("span", "txh", "⠿"); hd.title = "Kéo để di chuyển chữ"; box.appendChild(hd); }
    const t = el("div", "tt"); t.textContent = sh.text || ""; t.contentEditable = mine ? "true" : "false"; t.title = (d.author || owner);
    if (mine) {
      t.addEventListener("input", () => { sh.text = t.innerText; queueSave(); });
      t.addEventListener("blur", () => { if (!sh.text || !sh.text.trim()) { const a = myShapes(); a.splice(a.indexOf(sh), 1); renderShapes(); } commit(); });
    }
    box.appendChild(t); world.appendChild(box);
  }
  placeShapes();
}
let psRaf = 0;
function placeShapesSoon() { if (!psRaf) psRaf = requestAnimationFrame(() => { psRaf = 0; placeShapes(); }); }
function placeShapes() {
  const svg = world.querySelector(".shp"); if (!svg) return;
  let h = "";
  for (const { sh, mine } of allShapes()) {
    const g = geo(sh);
    if (sh.t === "text") { const e = world.querySelector(`.tx[data-sid="${sh.id}"]`); if (e) { e.style.display = g ? "" : "none"; if (g) { e.style.left = g.x0 + "px"; e.style.top = g.y0 + "px"; e.classList.toggle("on", selShape === sh.id); } } continue; }
    if (g) h += shapeSvg(sh, g, mine ? sh.id : "", selShape === sh.id ? "on" : "");
  }
  if (drawTmp) h += shapeSvg(drawTmp, drawTmp.g, "", "tmp");
  svg.innerHTML = h;
}
function relTo(n, x, y) { return n ? [Math.round((x - n.it.x) / n.it.w * 10000) / 10000, Math.round((y - n.it.y) / n.it.h * 10000) / 10000] : [r1(x), r1(y)]; }
function startDraw(e) {
  if (!me) { status("Cần đăng nhập để vẽ ghi chú", 3000); return false; }
  const p = toWorld(e), pg = e.target.closest && e.target.closest(".pg"), n = pg ? nodeEls.get(pg.dataset.k) : null;
  if (tool === "crop" && !n) { status("Kéo chuột bên trong một trang để cắt", 2500); return false; }
  if (tool === "text") {
    const sh = { id: Date.now().toString(36), t: "text", c: curColor, k: n ? pg.dataset.k : "", p: relTo(n, p.x, p.y), fs: Math.round(1 / view.s * 1000) / 1000, text: "", by: me.email, at: new Date().toISOString().slice(0, 10) };
    myShapes().push(sh); renderShapes();
    setTimeout(() => { const t = world.querySelector(`.tx[data-sid="${sh.id}"] .tt`); if (t) t.focus(); }, 0);
    return false;
  }
  eDrag = { type: "draw", pid: e.pointerId, t: tool, n, k: n ? pg.dataset.k : "", x0: p.x, y0: p.y, sx: e.clientX, sy: e.clientY, moved: false };
  vp.setPointerCapture(e.pointerId); return true;
}
function shapePointerDown(e) {
  const hEl = e.target.closest && e.target.closest("[data-sid]");
  const was = selShape;
  if (!hEl) { if (selShape) { selShape = null; placeShapes(); } return false; }
  const sh = myShapes().find((x) => x.id === hEl.dataset.sid); if (!sh) return false;
  selShape = sh.id; if (was !== sh.id) placeShapes();
  eDrag = { type: "shape", pid: e.pointerId, sh, p0: sh.p.slice(), n: sh.k ? nodeEls.get(sh.k) : null, sx: e.clientX, sy: e.clientY, moved: false };
  vp.setPointerCapture(e.pointerId); e.preventDefault(); return true;
}
function deleteShape() { const a = myShapes(), i = a.findIndex((x) => x.id === selShape); if (i < 0) return; a.splice(i, 1); selShape = null; commit(); renderShapes(); status("Đã xoá hình (Ctrl+Z để hoàn tác)", 2000); }

/* ----- tia gióng (snap) ----- */
function snapPrep(skip) {
  const W = vp.clientWidth, H = vp.clientHeight, xs = [], ys = [];
  const vis = (b) => b.x * view.s + view.x < W + 200 && (b.x + b.w) * view.s + view.x > -200 && b.y * view.s + view.y < H + 200 && (b.y + b.h) * view.s + view.y > -200;
  for (const [k, n] of nodeEls) { if (skip.has(k)) continue; const b = boxOf(n); if (!vis(b)) continue; xs.push(b.x, b.x + b.w / 2, b.x + b.w); ys.push(b.y, b.y + b.h / 2, b.y + b.h); }
  for (const st of board.sets) if (!st.collapsed) { xs.push(st.cx); ys.push(st.cy); }
  return { xs, ys };
}
function snapBox(b, S) {
  const th = 7 / view.s; let bx = null, by = null;
  for (const v of [b.x, b.x + b.w / 2, b.x + b.w]) for (const c of S.xs) { const d = c - v; if (Math.abs(d) < th && (!bx || Math.abs(d) < Math.abs(bx.d))) bx = { d, c }; }
  for (const v of [b.y, b.y + b.h / 2, b.y + b.h]) for (const c of S.ys) { const d = c - v; if (Math.abs(d) < th && (!by || Math.abs(d) < Math.abs(by.d))) by = { d, c }; }
  showGuides(bx && bx.c, by && by.c);
  return { dx: bx ? bx.d : 0, dy: by ? by.d : 0 };
}
function showGuides(gx, gy) {
  const G = $("#guides"); G.innerHTML = "";
  if (gx != null) { const l = el("div", "gv"); l.style.left = (gx * view.s + view.x) + "px"; G.appendChild(l); }
  if (gy != null) { const l = el("div", "gh2"); l.style.top = (gy * view.s + view.y) + "px"; G.appendChild(l); }
}
const unionBox = (bs) => { const x0 = Math.min(...bs.map((b) => b.x)), y0 = Math.min(...bs.map((b) => b.y)), x1 = Math.max(...bs.map((b) => b.x + b.w)), y1 = Math.max(...bs.map((b) => b.y + b.h)); return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }; };

/* ----- kéo thả ----- */
let eDrag = null;
function editPointerDown(e) {
  const t = e.target, grp = t.closest(".grp");
  if (t.closest(".gm")) { const g = board.groups.find((x) => x.id === grp.dataset.gid); eDrag = { type: "col", pid: e.pointerId, sx: e.clientX, sy: e.clientY, g, el: grp, moved: false }; vp.setPointerCapture(e.pointerId); return true; }
  if (t.closest(".gw")) { const g = board.groups.find((x) => x.id === grp.dataset.gid); eDrag = { type: "colw", pid: e.pointerId, sx: e.clientX, sy: e.clientY, g, el: grp, moved: false }; vp.setPointerCapture(e.pointerId); return true; }
  const sh = t.closest(".sh");
  if (sh) { const se = sh.parentNode, st = board.sets.find((x) => x.id === se.dataset.sid); eDrag = { type: "set", pid: e.pointerId, sx: e.clientX, sy: e.clientY, st, el: se, moved: false }; vp.setPointerCapture(e.pointerId); return true; }
  const nd = t.closest(".pg,.lnk");
  if (nd) {
    const k = nd.dataset.k, multi = e.shiftKey || e.ctrlKey || e.metaKey; let collapse = null;
    if (!sel.has(k)) { if (!multi) sel.clear(); sel.add(k); paintSel(); renderSelBar(); } else collapse = multi ? "toggle" : "single";
    const items = selNodes().map((n) => ({ n, ox: n.it.x, oy: n.it.y }));
    eDrag = { type: "move", pid: e.pointerId, sx: e.clientX, sy: e.clientY, k, collapse, moved: false, items, b0: unionBox(items.map((o) => boxOf(o.n))), S: snapPrep(new Set(sel)) };
    vp.setPointerCapture(e.pointerId); return true;
  }
  const multi = e.shiftKey || e.ctrlKey || e.metaKey;
  eDrag = { type: "marq", pid: e.pointerId, sx: e.clientX, sy: e.clientY, base: multi ? new Set(sel) : new Set(), moved: false };
  if (!multi && sel.size) { sel.clear(); paintSel(); renderSelBar(); }
  vp.setPointerCapture(e.pointerId); return true;
}
function eDragMove(e) {
  const d = eDrag; let dx = (e.clientX - d.sx) / view.s, dy = (e.clientY - d.sy) / view.s;
  if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 4) return;
  d.moved = true;
  if (d.type === "move") {
    const sn = snapBox({ x: d.b0.x + dx, y: d.b0.y + dy, w: d.b0.w, h: d.b0.h }, d.S); dx += sn.dx; dy += sn.dy;
    for (const o of d.items) moveNode(o.n, o.ox + dx, o.oy + dy); placePins(); placeShapesSoon();
  } else if (d.type === "shape") {
    if (!d.S) d.S = snapPrep(new Set());
    const g0 = geo(Object.assign({}, d.sh, { p: d.p0 })); if (!g0) return;
    const bb = d.sh.t === "text" ? { x: g0.x0, y: g0.y0, w: 0, h: 0 } : { x: Math.min(g0.x0, g0.x1), y: Math.min(g0.y0, g0.y1), w: Math.abs(g0.x1 - g0.x0), h: Math.abs(g0.y1 - g0.y0) };
    const sn = snapBox({ x: bb.x + dx, y: bb.y + dy, w: bb.w, h: bb.h }, d.S); dx += sn.dx; dy += sn.dy;
    const fx = d.n ? dx / d.n.it.w : dx, fy = d.n ? dy / d.n.it.h : dy;
    d.sh.p = d.p0.map((v, i) => Math.round((v + (i % 2 ? fy : fx)) * 10000) / 10000); placeShapes();
  } else if (d.type === "draw") {
    const p = toWorld(e); d.x1 = p.x; d.y1 = p.y;
    drawTmp = { t: d.t, c: curColor, w: 2.5 / view.s, g: { x0: d.x0, y0: d.y0, x1: d.x1, y1: d.y1 } }; placeShapes();
  } else if (d.type === "set") {
    d.el.style.transform = `translate(${dx}px,${dy}px)`; d.el.classList.add("drag");
    const p = toWorld(e), gs = board.groups;
    const col = gs.find((g) => p.x >= g.x && p.x <= g.x + g.w) || gs.reduce((a, g) => Math.abs(g.x + g.w / 2 - p.x) < Math.abs(a.x + a.w / 2 - p.x) ? g : a, gs[0]);
    const list = board.sets.filter((t) => t.col === col.id && t.id !== d.st.id), idx = list.filter((t) => t.y + t.h / 2 < p.y).length;
    const yb = idx < list.length ? list[idx].y - K.setGap / 2 : (list.length ? list[list.length - 1].y + list[list.length - 1].h + K.setGap / 2 : K.colHead - K.setGap / 2);
    const ib = $("#insbar"); Object.assign(ib.style, { left: (col.x + K.pad) + "px", top: (yb - 6) + "px", width: (col.w - 2 * K.pad) + "px" }); ib.classList.remove("hidden");
    d.target = { col, list, idx };
  } else if (d.type === "col") { d.el.style.transform = `translateX(${dx}px)`; d.el.classList.add("drag"); d.dx = dx; }
  else if (d.type === "colw") { d.w = Math.max(800, Math.round(d.g.w + dx)); d.el.style.width = d.w + "px"; }
  else if (d.type === "marq") {
    const r = vp.getBoundingClientRect(), m = $("#marq");
    const x0 = Math.min(d.sx, e.clientX) - r.left, y0 = Math.min(d.sy, e.clientY) - r.top, x1 = Math.max(d.sx, e.clientX) - r.left, y1 = Math.max(d.sy, e.clientY) - r.top;
    Object.assign(m.style, { left: x0 + "px", top: y0 + "px", width: x1 - x0 + "px", height: y1 - y0 + "px" }); m.classList.remove("hidden");
    const wx0 = (x0 - view.x) / view.s, wy0 = (y0 - view.y) / view.s, wx1 = (x1 - view.x) / view.s, wy1 = (y1 - view.y) / view.s;
    sel.clear(); for (const k of d.base) sel.add(k);
    for (const [k, n] of nodeEls) { const b = boxOf(n); if (b.x < wx1 && b.x + b.w > wx0 && b.y < wy1 && b.y + b.h > wy0) sel.add(k); }
    paintSel();
  }
}
function eDragEnd(e, cancelled) {
  const d = eDrag; eDrag = null; vp.classList.remove("panning"); $("#marq").classList.add("hidden"); $("#guides").innerHTML = "";
  if (!d) return;
  if (d.type === "draw") {
    const dt = drawTmp; drawTmp = null;
    if (!cancelled && d.moved && dt && Math.hypot((d.x1 - d.x0) * view.s, (d.y1 - d.y0) * view.s) > 6 && d.t === "crop") { renderShapes(); cropDone(d); return; }
    if (!cancelled && d.moved && dt && Math.hypot((d.x1 - d.x0) * view.s, (d.y1 - d.y0) * view.s) > 6) {
      myShapes().push({ id: Date.now().toString(36), t: d.t, c: curColor, w: r1(2.5 / view.s) || 0.1, k: d.k, p: [...relTo(d.n, d.x0, d.y0), ...relTo(d.n, d.x1, d.y1)], by: me.email, at: new Date().toISOString().slice(0, 10) });
      commit();
    }
    renderShapes(); return;
  }
  if (cancelled) { rebuildBoard(); return; }
  if (d.type === "shape") { if (d.moved) commit(); return; }
  if (d.type === "marq") { applySelection(); return; }
  if (!d.moved) {
    if (d.type === "move") {
      if (registerClick(d.k)) { const nd = nodeEls.get(d.k); if (nd) focusRect(nd.it, 0.04); }
      else if (d.collapse === "toggle") sel.delete(d.k);
      else if (d.collapse === "single") { sel.clear(); sel.add(d.k); }
      applySelection();
    }
    return;
  }
  if (d.type === "move") recordMoves(d.items.map((o) => o.n));
  else if (d.type === "set") { if (!d.target) return rebuildBoard(); const { col, list, idx } = d.target, ids = list.map((t) => t.id); ids.splice(idx, 0, d.st.id); ids.forEach((id, i) => (L.sets[id] = { col: col.id, ord: i })); }
  else if (d.type === "col") { const c = (g) => g === d.g ? g.x + g.w / 2 + d.dx : g.x + g.w / 2; L.colOrder = [...board.groups].sort((a, b) => c(a) - c(b)).map((g) => g.id); }
  else if (d.type === "colw") L.cols[d.g.id] = Object.assign(L.cols[d.g.id] || {}, { w: d.w });
  commit(); rebuildBoard();
}
function deleteSelection() {
  if (!editMode || !sel.size) return;
  if (sel.size > 3 && !confirm("Gỡ " + sel.size + " mục khỏi bảng?\n(File gốc không bị xoá; khôi phục bằng ↺ Khôi phục.)")) return;
  const n0 = sel.size; for (const k of sel) if (!L.hide.includes(k)) L.hide.push(k);
  sel.clear(); commit(); rebuildBoard(); status("Đã gỡ " + n0 + " mục khỏi bảng (Ctrl+Z để hoàn tác)", 3500);
}
function nudgeSel(key, step) {
  const ns = selNodes(); if (!ns.length) return;
  const dx = key === "ArrowLeft" ? -step : key === "ArrowRight" ? step : 0, dy = key === "ArrowUp" ? -step : key === "ArrowDown" ? step : 0;
  for (const n of ns) moveNode(n, n.it.x + dx, n.it.y + dy);
  recordMoves(ns); placePins(); placeShapesSoon(); clearTimeout(nudgeSel.t); nudgeSel.t = setTimeout(() => { commit(); rebuildBoard(); }, 500);
}
function alignSel(mode) {
  const ns = selNodes(); if (ns.length < 2) return status("Chọn ít nhất 2 mục", 2500);
  const bx = ns.map(boxOf);
  if (mode === "l") { const m = Math.min(...bx.map((b) => b.x)); ns.forEach((n) => moveNode(n, m, n.it.y)); }
  else if (mode === "t") { const m = Math.min(...bx.map((b) => b.y)); ns.forEach((n) => moveNode(n, n.it.x, m)); }
  else {
    const hz = mode === "h", arr = ns.map((n, i) => ({ n, b: bx[i] })).sort((a, b) => hz ? a.b.x - b.b.x : a.b.y - b.b.y);
    const f = arr[0].b, l = arr[arr.length - 1].b, start = hz ? f.x : f.y, end = hz ? l.x + l.w : l.y + l.h;
    const total = arr.reduce((s2, o) => s2 + (hz ? o.b.w : o.b.h), 0), gap = (end - start - total) / (arr.length - 1);
    let pos = start; for (const o of arr) { if (hz) moveNode(o.n, pos, o.n.it.y); else moveNode(o.n, o.n.it.x, pos); pos += (hz ? o.b.w : o.b.h) + gap; }
  }
  recordMoves(ns); commit(); rebuildBoard();
}
function gridSel() {
  const ns = selNodes(); if (ns.length < 2) return status("Chọn ít nhất 2 mục", 2500);
  const cols = parseInt(prompt("Xếp thành mấy cột?", String(Math.min(ns.length, 5))), 10); if (!cols || cols < 1) return;
  const bx = ns.map(boxOf), x0 = Math.min(...bx.map((b) => b.x)), y0 = Math.min(...bx.map((b) => b.y));
  const cw = Math.max(...bx.map((b) => b.w)) + K.gap, ch = Math.max(...bx.map((b) => b.h)) + K.gap, rh = bx.reduce((s2, b) => s2 + b.h, 0) / bx.length;
  ns.map((n, i) => ({ n, b: bx[i], row: Math.round(bx[i].y / rh) })).sort((a, b) => a.row - b.row || a.b.x - b.b.x).forEach((o, i) => moveNode(o.n, x0 + (i % cols) * cw, y0 + Math.floor(i / cols) * ch));
  recordMoves(ns); commit(); rebuildBoard();
}

/* ----- cửa sổ phụ ----- */
function openModal(title, node) { $("#mTitle").textContent = title; const b = $("#mBody"); b.innerHTML = ""; b.appendChild(node); $("#modal").classList.remove("hidden"); }
function closeModal() { $(".mbox").classList.remove("big"); $("#modal").classList.add("hidden"); $("#mBody").innerHTML = ""; }
$("#mClose").onclick = closeModal;
$("#modal").addEventListener("pointerdown", (e) => { if (e.target.id === "modal") closeModal(); });
function openRestore() {
  const B = el("div"), rows = [];
  for (const id of L.hideSets) { const s = SETS.get(id); if (s) rows.push({ kind: "set", id, text: "Bộ: " + s.title }); }
  for (const k of L.hide) { const [doc, pg] = k.split("#"), d = docsAll[doc]; rows.push({ kind: "item", id: k, text: k.startsWith("K:") ? "Tệp: " + k.slice(2).split("/").pop() : (d ? d.name : doc) + " — tr." + pg }); }
  if (!rows.length) { B.appendChild(el("div", "wbox", "Chưa có bộ hay trang nào bị gỡ khỏi bảng.")); return openModal("Khôi phục", B); }
  const chosen = new Set(), cbs = [];
  const all = el("label", "mrow"), ca = el("input"); ca.type = "checkbox"; all.append(ca, document.createTextNode(" Chọn tất cả (" + rows.length + ")")); B.appendChild(all);
  const lst = el("div", "mlist"); B.appendChild(lst);
  for (const r of rows) { const l = el("label", "mrow"), c = el("input"); c.type = "checkbox"; cbs.push(c); c.onchange = () => (c.checked ? chosen.add(r) : chosen.delete(r)); l.append(c, document.createTextNode(" " + r.text)); lst.appendChild(l); }
  ca.onchange = () => cbs.forEach((c) => { c.checked = ca.checked; c.onchange(); });
  const go = el("button", "primary", "Khôi phục mục đã chọn");
  go.onclick = () => { if (!chosen.size) return; const n = chosen.size; const cs = [...chosen]; L.hideSets = L.hideSets.filter((id) => !cs.some((r) => r.kind === "set" && r.id === id)); L.hide = L.hide.filter((k) => !cs.some((r) => r.kind === "item" && r.id === k)); commit(); rebuildBoard(); closeModal(); status("Đã khôi phục " + n + " mục", 3000); };
  B.appendChild(go); openModal("Khôi phục bộ / trang đã gỡ", B);
}

/* ----- gắn trang vào hạng mục WBS ----- */
function wbsPick(keys) {
  if (!wbs) return status("Chưa có dữ liệu WBS cho dự án này", 3000);
  if (!me) return status("Cần đăng nhập để gắn vào WBS", 3000);
  wbsChoose("Gắn " + keys.length + " trang vào hạng mục WBS", (id) => addToWbs(id, keys));
}
function wbsChoose(title, onPick) {
  if (!wbs) return status("Chưa có dữ liệu WBS cho dự án này", 3000);
  if (!me) return status("Cần đăng nhập", 3000);
  const B = el("div"), q = el("input"); q.type = "search"; q.placeholder = "Tìm hạng mục (mã code, tên, nhóm, STT)…"; B.appendChild(q);
  const list = el("div", "mlist"); B.appendChild(list);
  const draw = () => {
    list.innerHTML = ""; const nq = norm(q.value); let c = 0;
    for (const { z, p, it } of allWbsItems()) {
      const cd = codeOf(it.id);
      if (nq && !norm(cd + " " + it.stt + " " + it.name + " " + it.cat + " " + p.title).includes(nq)) continue;
      if (++c > 80) break;
      const r = el("div", "mrow"); const b = el("b");
      if (cd) b.appendChild(el("span", "cdb", cd));
      b.appendChild(document.createTextNode(it.stt + ". " + it.name));
      r.append(b, el("small", null, z.title + " · " + p.title + " · " + it.cat));
      r.onclick = () => { closeModal(); onPick(it.id); }; list.appendChild(r);
    }
    if (!c) list.appendChild(el("div", "wbox", "Không có hạng mục phù hợp"));
  };
  q.oninput = draw; draw(); openModal(title, B); q.focus();
}
function addToWbs(id, keys) {
  const st = wbsState(id); st.extra = st.extra || []; let n = 0;
  for (const k of keys) { const [doc, pg] = k.split("#"), page = +pg; if (!st.extra.some((x) => x.doc === doc && x.page === page)) { st.extra.push({ doc, page }); n++; } }
  st.by = me.name || me.email; st.at = new Date().toISOString().slice(0, 10); queueSave();
  status("Đã gắn " + n + " trang vào hạng mục", 3000);
  $("#side").classList.remove("hidden"); setSideTab("wbs"); openWbsItem(id, true);
}

/* bản vẽ minh họa của hạng mục (chọn lại được) */
function mainOf(id) {
  const m = me && notes[me.email] && notes[me.email].wbs && notes[me.email].wbs[id];
  if (m && m.main !== undefined) return m.main || null;
  for (const d of Object.values(notes)) { const r = d.wbs && d.wbs[id]; if (r && r.main) return r.main; }
  return null;
}
function setMain(id, doc, page) {
  if (!me) return status("Cần đăng nhập để chọn bản vẽ minh họa", 3000);
  const st = wbsState(id); st.main = doc ? { doc, page } : ""; touchSt(st); queueSave();
  status(doc ? "Đã đặt bản vẽ minh họa mới cho hạng mục" : "Đã trả về bản vẽ mặc định", 2500);
  if (wbsCur === id) openWbsItem(id, true);
}
function mainBox(id, it) {
  const w = el("div", "mainbox"), m = mainOf(id), cur = m || it.drawings[0] || it.specs[0];
  w.appendChild(el("h4", null, "Bản vẽ minh họa"));
  const row = el("div", "mrw");
  if (cur) {
    const dd = board.docs[cur.doc], tx = el("div", "mtx"); tx.append(el("b", null, (dd ? dd.name : cur.doc) + " · tr." + cur.page), el("small", null, m ? "Do bạn/nhóm chọn" : "Mặc định (gợi ý tự động)")); tx.style.cursor = "pointer"; tx.onclick = () => goPage(cur.doc, cur.page); row.appendChild(tx);
  } else row.appendChild(el("div", "wbox", "Chưa có bản vẽ minh họa."));
  w.appendChild(row);
  const bar = el("div", "wnb");
  const b1 = el("button", "pri", "↻ Chọn lại"); b1.title = "Bấm chọn 1 trang trên bảng rồi bấm ★ ở thanh dưới";
  b1.onclick = () => { setTool("select"); status("Bấm chọn 1 trang trên bảng, rồi bấm “★ Bản vẽ minh họa…” ở thanh dưới (hoặc ★ ở dòng bản vẽ bên dưới)", 8000); };
  bar.appendChild(b1);
  if (m) { const b2 = el("button", null, "Về mặc định"); b2.onclick = () => setMain(id, null); bar.appendChild(b2); }
  if (!me) bar.querySelectorAll("button").forEach((b) => (b.disabled = true));
  w.appendChild(bar); return w;
}

/* ================= WBS: mã code · ghi chú + hình · cắt hình ================= */
const touchSt = (st) => { st.by = me.name || me.email; st.at = new Date().toISOString().slice(0, 10); };
function codeOf(id) {
  const m = me && notes[me.email] && notes[me.email].wbs && notes[me.email].wbs[id];
  if (m && m.code != null) return m.code;
  for (const d of Object.values(notes)) { const r = d.wbs && d.wbs[id]; if (r && r.code) return r.code; }
  return "";
}
function imgsOf(id) { // hình của mọi người cho hạng mục
  const o = [];
  for (const [owner, d] of Object.entries(notes)) { const r = d.wbs && d.wbs[id]; if (r && r.imgs) for (const im of r.imgs) o.push({ im, owner, d, mine: !!me && owner === me.email }); }
  return o;
}
const imgUrlCache = new Map();
function imgUrl(id) { if (!imgUrlCache.has(id)) imgUrlCache.set(id, Promise.resolve(src.imageUrl(id))); return imgUrlCache.get(id); }
function imgEl(im) { const i = el("img"); i.alt = ""; i.draggable = false; imgUrl(im.id).then((u) => { i.src = u; }).catch(() => { i.alt = "(không tải được hình)"; }); return i; }
async function toJpeg(b, max = 1600) {
  let cv;
  if (b instanceof HTMLCanvasElement) cv = b;
  else {
    const bm = await createImageBitmap(b), s = Math.min(1, max / Math.max(bm.width, bm.height));
    cv = document.createElement("canvas"); cv.width = Math.max(1, Math.round(bm.width * s)); cv.height = Math.max(1, Math.round(bm.height * s));
    const c = cv.getContext("2d"); c.fillStyle = "#fff"; c.fillRect(0, 0, cv.width, cv.height); c.drawImage(bm, 0, 0, cv.width, cv.height);
  }
  return new Promise((r) => cv.toBlob(r, "image/jpeg", 0.86));
}
async function addImg(id, blob, info) {
  if (!me) return status("Cần đăng nhập để thêm hình", 3000);
  status("Đang lưu hình…", 0);
  try {
    const iid = await src.saveImage(blob);
    imgUrlCache.set(iid, Promise.resolve(URL.createObjectURL(blob)));
    const st = wbsState(id); (st.imgs = st.imgs || []).push(Object.assign({ id: iid, t: new Date().toISOString().slice(0, 10) }, info ? { src: info } : {}));
    touchSt(st); queueSave(); status("Đã thêm hình vào hạng mục", 2500); return true;
  } catch (e) { status("Lưu hình lỗi: " + e.message, 7000); return false; }
}
function delImg(id, iid) { const st = wbsState(id); st.imgs = (st.imgs || []).filter((x) => x.id !== iid); touchSt(st); queueSave(); }
function lightbox(id, im) {
  const o = el("div"); o.id = "lb"; const i = imgEl(im); o.appendChild(i);
  const bar = el("div", "lbb");
  if (im.src && board && board.docs[im.src.doc]) { const g = el("button", null, "→ Đến trang gốc"); g.onclick = (e) => { e.stopPropagation(); o.remove(); closeModal(); goPage(im.src.doc, im.src.page); }; bar.appendChild(g); }
  const nt = el("button", null, "Mở tab mới"); nt.onclick = (e) => { e.stopPropagation(); imgUrl(im.id).then((u) => window.open(u, "_blank")); }; bar.appendChild(nt);
  const cl = el("button", null, "✕ Đóng"); cl.onclick = () => o.remove(); bar.appendChild(cl);
  o.appendChild(bar); o.onclick = (e) => { if (e.target === o) o.remove(); };
  document.addEventListener("keydown", function esc(e) { if (e.key === "Escape") { o.remove(); document.removeEventListener("keydown", esc); } });
  document.body.appendChild(o);
}
function thumbs(id, onChange) {
  const g = el("div", "wthumbs");
  const all = imgsOf(id);
  if (!all.length) g.appendChild(el("div", "wbox", "Chưa có hình. Dán (Ctrl+V), thêm file, hoặc dùng ✂ Cắt hình từ bảng."));
  for (const { im, owner, d, mine } of all) {
    const t = el("div", "th"); t.title = (mine ? "Bạn" : (d.author || owner)) + " · " + (im.t || "") + (im.src ? " · cắt từ tr." + im.src.page : "");
    t.appendChild(imgEl(im)); t.onclick = () => lightbox(id, im);
    if (im.src) t.appendChild(el("span", "tg", "✂"));
    if (mine) { const x = el("button", "tx2", "✕"); x.title = "Xoá hình"; x.onclick = (e) => { e.stopPropagation(); if (!confirm("Xoá hình này khỏi hạng mục?")) return; delImg(id, im.id); onChange && onChange(); }; t.appendChild(x); }
    g.appendChild(t);
  }
  return g;
}
async function pasteFiles(id, files, after) {
  let n = 0; for (const f of files) { if (!/^image\//.test(f.type)) continue; const b = await toJpeg(f); if (await addImg(id, b)) n++; }
  if (n) after && after();
}
/* cửa sổ pop-up ghi chú + hình của 1 hạng mục */
function openWbsNote(id) {
  const f = allWbsItems().find((x) => x.it.id === id); if (!f) return; const { z, p, it } = f;
  const st = me ? wbsState(id) : { note: "", imgs: [], code: codeOf(id) };
  const B = el("div", "wnote");
  const top = el("div", "wnh");
  const ci = el("input"); ci.placeholder = "Mã code"; ci.value = codeOf(id); ci.disabled = !me; ci.className = "cdin";
  ci.oninput = () => { st.code = ci.value.trim(); touchSt(st); queueSave(); }; ci.onchange = () => renderWbs();
  const tt = el("div", "wnt"); tt.append(el("b", null, it.stt + ". " + it.name), el("small", null, z.title + " · " + p.title + " · " + it.cat));
  top.append(ci, tt); B.appendChild(top);
  const ta = el("textarea"); ta.placeholder = me ? "Ghi chú / tình trạng hạng mục… (có thể dán hình bằng Ctrl+V)" : "Đăng nhập để ghi chú"; ta.value = st.note || ""; ta.disabled = !me; ta.rows = 6;
  let tmr = 0; ta.oninput = () => { st.note = ta.value; touchSt(st); queueSave(); clearTimeout(tmr); tmr = setTimeout(renderWbs, 700); };
  B.appendChild(ta);
  const bar = el("div", "wnb");
  const fi = el("input"); fi.type = "file"; fi.accept = "image/*"; fi.multiple = true; fi.style.display = "none";
  fi.onchange = async () => { await pasteFiles(id, [...fi.files], redraw); fi.value = ""; };
  const b1 = el("button", null, "＋ Thêm ảnh"); b1.onclick = () => fi.click();
  const b2 = el("button", null, "📋 Dán ảnh"); b2.title = "Hoặc bấm Ctrl+V"; b2.onclick = async () => {
    try { const items = await navigator.clipboard.read(); const fl = []; for (const itm of items) for (const ty of itm.types) if (/^image\//.test(ty)) fl.push(new File([await itm.getType(ty)], "p", { type: ty })); if (!fl.length) return status("Clipboard chưa có hình", 2500); await pasteFiles(id, fl, redraw); } catch (e) { status("Bấm Ctrl+V trong cửa sổ này để dán hình", 3500); }
  };
  const b3 = el("button", null, "✂ Cắt hình từ bảng"); b3.title = "Cắt một vùng trên trang của bảng rồi thêm vào hạng mục này"; b3.onclick = () => startCrop(id, true);
  if (!me) [b1, b2, b3].forEach((b) => (b.disabled = true));
  bar.append(b1, b2, b3, fi); B.appendChild(bar);
  const holder = el("div"); B.appendChild(holder);
  const redraw = () => { holder.innerHTML = ""; holder.appendChild(thumbs(id, redraw)); renderWbs(); if (wbsCur === id) openWbsItem(id, true); };
  holder.appendChild(thumbs(id, redraw));
  for (const [owner, d] of Object.entries(notes)) { const r = d.wbs && d.wbs[id]; if (r && r.note && !(me && owner === me.email)) B.appendChild(el("div", "wbox", (d.author || owner) + ": " + r.note)); }
  B.addEventListener("paste", (e) => { const fl = [...(e.clipboardData ? e.clipboardData.files : [])].filter((x) => /^image\//.test(x.type)); if (fl.length) { e.preventDefault(); pasteFiles(id, fl, redraw); } });
  B.addEventListener("dragover", (e) => e.preventDefault());
  B.addEventListener("drop", (e) => { const fl = [...e.dataTransfer.files].filter((x) => /^image\//.test(x.type)); if (fl.length) { e.preventDefault(); pasteFiles(id, fl, redraw); } });
  $(".mbox").classList.add("big"); openModal("Ghi chú & hình · " + (codeOf(id) || it.stt), B); ta.focus();
}
/* đầu trang chi tiết: mã + nút + hình */
function wbsHead(id, st) {
  const w = el("div", "whd");
  const row = el("div", "whr");
  const ci = el("input", "cdin"); ci.placeholder = "Mã code"; ci.value = codeOf(id); ci.disabled = !me;
  ci.oninput = () => { st.code = ci.value.trim(); touchSt(st); queueSave(); }; ci.onchange = () => renderWbs();
  const b1 = el("button", "pri", "📝 Ghi chú & hình"); b1.onclick = () => openWbsNote(id);
  const b2 = el("button", null, "✂ Cắt hình"); b2.title = "Cắt vùng trên bảng thêm vào hạng mục này"; b2.onclick = () => startCrop(id, false); b2.disabled = !me;
  row.append(el("span", "lab", "Mã"), ci, b1, b2); w.appendChild(row);
  if (imgsOf(id).length || st.note) w.appendChild(thumbs(id, () => { openWbsItem(id, true); renderWbs(); }));
  return w;
}
/* cắt hình */
function startCrop(id, fromPopup) {
  if (!me) return status("Cần đăng nhập để cắt hình", 3000);
  cropTarget = id; cropFromPopup = !!fromPopup; closeModal(); setTool("crop");
  status("✂ Kéo chuột chọn vùng cần cắt trên một trang (Esc để huỷ)", 6000);
}
async function cropBlob(it, r, pel) {
  if (it.type === "link" || it.kind === "sheet") throw new Error("loại trang này chưa hỗ trợ cắt");
  const MAXW = 1800; let cv = document.createElement("canvas");
  if (it.kind === "pdf") {
    const pdf = await getPdf(it.doc), page = await pdf.getPage(it.page), v0 = page.getViewport({ scale: 1 });
    const cw = (r[2] - r[0]) * v0.width, sc = Math.min(6, MAXW / cw), v = page.getViewport({ scale: sc });
    cv.width = Math.max(1, Math.round(cw * sc)); cv.height = Math.max(1, Math.round((r[3] - r[1]) * v0.height * sc));
    const ctx = cv.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, cv.width, cv.height);
    await page.render({ canvasContext: ctx, viewport: v, transform: [1, 0, 0, 1, -r[0] * v.width, -r[1] * v.height] }).promise;
  } else {
    let im = new Image();
    try { im.src = cache.get(it.src) || await src.blobUrl(it.src); await im.decode(); }
    catch (e) { const vi = pel && pel.querySelector("img"); if (vi && vi.naturalWidth) im = vi; else throw new Error("không đọc được hình trang này"); }
    const sx = r[0] * im.naturalWidth, sy = r[1] * im.naturalHeight, sw = (r[2] - r[0]) * im.naturalWidth, sh = (r[3] - r[1]) * im.naturalHeight, s = Math.min(1, MAXW / sw);
    cv.width = Math.max(1, Math.round(sw * s)); cv.height = Math.max(1, Math.round(sh * s));
    const ctx = cv.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, cv.width, cv.height); ctx.drawImage(im, sx, sy, sw, sh, 0, 0, cv.width, cv.height);
  }
  return new Promise((res) => cv.toBlob(res, "image/jpeg", 0.88));
}
async function cropDone(d) {
  const n = d.n; if (!n) return;
  const it = n.it, cl = (v) => Math.max(0, Math.min(1, v));
  const r = [cl((Math.min(d.x0, d.x1) - it.x) / it.w), cl((Math.min(d.y0, d.y1) - it.y) / it.h), cl((Math.max(d.x0, d.x1) - it.x) / it.w), cl((Math.max(d.y0, d.y1) - it.y) / it.h)];
  if (r[2] - r[0] < 0.01 || r[3] - r[1] < 0.01) return status("Vùng cắt quá nhỏ", 2500);
  const target = cropTarget, fromPopup = cropFromPopup; cropTarget = null; cropFromPopup = false; setTool("select");
  status("Đang cắt hình…", 0);
  let blob; try { blob = await cropBlob(it, r, n.el); } catch (e) { return status("Không cắt được: " + e.message, 6000); }
  const info = { doc: it.doc, page: it.page, r: r.map((v) => Math.round(v * 1e4) / 1e4) };
  const done = async (id) => {
    if (!(await addImg(id, blob, info))) return;
    $("#side").classList.remove("hidden"); setSideTab("wbs"); renderWbs(); openWbsItem(id, true); if (fromPopup) openWbsNote(id);
  };
  if (target) done(target); else { status("", 1); wbsChoose("Thêm hình cắt vào hạng mục WBS", done); }
}


/* ---------------- khởi động ---------------- */
function start() {
  const local = params.get("local");
  if (local) { me = { email: "local@test", name: "Thử nghiệm" }; $("#btnLogin").classList.add("hidden"); src = LocalSource(local); openBoard().catch((e) => fail(e.message)); return; }
  const wait = () => { if (window.google && google.accounts) { initAuth(); afterAuthReady(); } else setTimeout(wait, 100); };
  wait();
}
function afterAuthReady() {
  const fid = folderIdFrom(params.get("folder") || localStorage.getItem("pb_folder") || CFG.defaultFolder || "");
  const go = (id) => {
    localStorage.setItem("pb_folder", id);
    if (params.get("folder") !== id) { const u = new URL(location.href); u.searchParams.set("folder", id); history.replaceState(null, "", u); }
    src = DriveSource(id);
    ensureToken().then(openBoard).catch((e) => fail(e.message));
  };
  $("#folderGo").onclick = () => { const id = folderIdFrom($("#folderInput").value.trim()); if (!id) return status("Link thư mục không hợp lệ", 3000); go(id); };
  if (fid) { $("#emptyMsg").textContent = "Bấm Đăng nhập Google để mở bảng."; $("#btnLogin").onclick = () => go(fid); }
  else { $("#emptyMsg").textContent = "Đăng nhập rồi dán link thư mục dự án."; $("#folderBox").classList.remove("hidden"); $("#btnLogin").onclick = () => ensureToken(); }
}
start();
(function () {
  const db = $("#drawbar"), tg = $("#dbToggle");
  const set = (m) => { db.classList.toggle("min", m); tg.textContent = m ? "🖊 ▴" : "🖊 ▾"; try { localStorage.setItem("pb_dbmin", m ? "1" : "0"); } catch (e) {} };
  tg.addEventListener("click", () => set(!db.classList.contains("min")));
  let m = false; try { m = localStorage.getItem("pb_dbmin") === "1"; } catch (e) {}
  set(m);
})();
})();
