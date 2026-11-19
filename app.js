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
let tool = "select";
let baseBoard = null;      // board.json gốc (không bị sửa)
let L = null;              // bố cục đang dùng (null = gốc)
let layoutOwner = "base";  // "base" hoặc email người có bố cục
let editMode = false;
const sel = new Set();     // các mục đang chọn (khoá keyOf)
const nodeEls = new Map(); // khoá -> {it, el}

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
  let lastErr = "";
  const API = "https://www.googleapis.com/drive/v3/files";
  const q = (s) => encodeURIComponent(s);
  async function list(folderId) {
    let out = [], pt = "";
    do {
      const r = await (await gfetch(`${API}?q=${q(`'${folderId}' in parents and trashed=false`)}&fields=nextPageToken,files(id,name,mimeType)&pageSize=1000&supportsAllDrives=true&includeItemsFromAllDrives=true${pt ? "&pageToken=" + pt : ""}`)).json();
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
              } else paths[p] = f.id;
            }
          }).catch((e) => { lastErr = e.message; status("Lỗi đọc Drive: " + e.message, 6000); }).finally(() => { running--; next(); });
        }
      };
      next();
    });
  }
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
    async listPdfs() { await (origReady || Promise.resolve()); return Object.keys(paths).filter((p) => /\.pdf$/i.test(p) && !p.startsWith("_BOARD/")).map((p) => ({ path: p, name: p.split("/").pop() })); },
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
    async listPdfs() { try { return (await (await fetch(base + "_BOARD/pdflist.json")).json()).map((p) => ({ path: p, name: p.split("/").pop() })); } catch (e) { return []; } },
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
  baseBoard = await src.json("_BOARD/board.json"); L = null; layoutOwner = "base"; board = computeBoard();
  $("#projName").textContent = board.project;
  document.title = board.project + " – Project Board";
  build();
  fitAll();
  status(`Đã mở: ${Object.keys(board.docs).length} tài liệu, ${board.items.filter((i) => i.type === "page").length} trang`);
  src.json("_BOARD/index.json").then((d) => { index = d.pages; index.forEach((p) => { p.text = p.text.normalize("NFC"); p.n = normC(p.text); }); $("#q").placeholder = `Tìm trong ${index.length} trang… (Ctrl+F)`; }).catch(() => status("Chưa có index.json – không tìm kiếm được", 5000));
  src.json("_BOARD/wbs.json").then((w) => { if (w && w.zones) { wbs = w; $("#btnWbs").classList.remove("hidden"); document.querySelector("[data-tab=wbs]").classList.remove("hidden"); renderWbs(); } }).catch(() => {});
  origReady = src.indexOriginals();
  origReady.then(() => document.querySelectorAll(".lnk").forEach((e) => e.classList.toggle("nf", !src.has(e.dataset.path))));
  src.loadNotes().then((n) => { notes = n; initLayoutAfterNotes(); }).catch((e) => console.warn(e));
}

function build() {
  world.innerHTML = ""; pageEls.length = 0; nodeEls.clear();
  for (const g of board.groups) {
    const d = el("div", "grp"); d.dataset.gid = g.id; Object.assign(d.style, { left: g.x + "px", top: g.y + "px", width: g.w + "px", height: g.h + "px", borderColor: g.color });
    const t = el("div", "gt", g.title); t.style.color = g.color; d.appendChild(t);
    const gr = el("div", "gr", "✎"); gr.title = "Đổi tên vùng";
    const gx = el("div", "gx", "✕"); gx.title = "Xoá vùng (các trang bên trong vẫn giữ)";
    const gh = el("div", "gh"); gh.title = "Kéo để đổi cỡ vùng";
    const gm = el("div", "gm", "✥"); gm.title = "Kéo để di chuyển cả vùng (kèm các trang bên trong)";
    d.append(gm, gr, gx, gh); world.appendChild(d);
  }
  for (const it of board.items) {
    const k = keyOf(it);
    if (it.type === "label") {
      const d = el("div", "lbl"); d.style.left = it.x + "px"; d.style.top = it.y + "px"; d.dataset.k = k;
      d.appendChild(el("b", null, it.text)); if (it.sub) d.appendChild(el("small", null, it.sub)); world.appendChild(d);
      nodeEls.set(k, { it, el: d });
    } else if (it.type === "page") {
      const d = el("div", "pg"); Object.assign(d.style, { left: it.x + "px", top: it.y + "px", width: it.w + "px", height: it.h + "px" });
      d.dataset.doc = it.doc; d.dataset.page = it.page; d.dataset.k = k;
      const img = el("img"); img.alt = ""; img.draggable = false; d.appendChild(img);
      d.appendChild(el("span", "pn", it.page + "/" + (board.docs[it.doc] ? board.docs[it.doc].pages : "?")));
      world.appendChild(d); pageEls.push({ it, el: d, img, level: 0, want: 0 });
      nodeEls.set(k, { it, el: d });
    } else if (it.type === "link") {
      const d = el("div", "lnk"); Object.assign(d.style, { left: it.x + "px", top: it.y + "px", width: it.w + "px", height: it.h + "px" });
      d.dataset.path = it.path; d.dataset.k = k; d.title = it.path + "\n(bấm để mở)";
      d.appendChild(el("span", "ext " + it.ext, it.ext)); d.appendChild(el("span", "nm", it.name));
      d.addEventListener("click", () => { if (editMode) return; const u = src.openUrl(it.path); if (u) window.open(u, "_blank"); else status("Chưa tìm thấy file trên Drive (đang đồng bộ?)", 4000); });
      world.appendChild(d);
      nodeEls.set(k, { it, el: d });
    }
  }
  buildToc();
  apply();
}
function buildToc() {
  const toc = $("#toc"); toc.innerHTML = "";
  for (const g of board.groups) {
    const box = el("div", "tg"); const h = el("div", "th", g.title); h.style.color = g.color;
    h.onclick = () => focusRect(g, 0.02); box.appendChild(h);
    for (const [id, d] of Object.entries(board.docs)) {
      if (d.group !== g.id) continue;
      const r = el("div", "td"); r.textContent = d.name + " "; r.appendChild(el("small", null, d.pages + " tr" + (d.scanned ? " · OCR" : "")));
      r.title = d.path; r.onclick = () => { const it = board.items.find((i) => i.type === "page" && i.doc === id && i.page === 1); focusRect(it, 0.05); };
      box.appendChild(r);
    }
    toc.appendChild(box);
  }
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
    if (it.render) { if (p.level < 1 && !p.failed) queueRender(p); continue; }
    const want = sw > 480 ? 2 : 1;
    if (p.level >= want) continue;
    const path = want === 2 ? it.src : it.thumb;
    loadImg(path, (u) => { if (p.level < want) { p.img.src = u; p.level = want; } });
  }
}

/* ---------------- trang thêm từ PDF mới: vẽ ảnh nhỏ bằng pdf.js ---------------- */
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
    if (d.kind !== "pdf" || pdfFail.has(it.doc)) continue;
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
  if (e.target.closest(".note,.pin") && e.button === 0 && !spaceDown) return;
  if (!editMode && e.target.closest(".lnk") && e.button === 0 && !spaceDown) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (tool === "note" && e.button === 0 && pointers.size === 1) { e.preventDefault(); pointers.delete(e.pointerId); addNoteAt(e); return; }
  if (tool === "pin" && e.button === 0 && pointers.size === 1) { e.preventDefault(); pointers.delete(e.pointerId); addPinAt(e); return; }
  if (editMode && me && e.button === 0 && !spaceDown && pointers.size === 1 && editPointerDown(e)) return;
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
  if (editMode && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (editMode && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); return; }
  if (editMode && sel.size && (e.key === "Delete" || e.key === "Backspace")) { e.preventDefault(); deleteSelection(); return; }
  if (editMode && sel.size && e.key.startsWith("Arrow")) { e.preventDefault(); nudgeSel(e.key, e.shiftKey ? 100 : 10); return; }
  if (e.key === " ") spaceDown = true;
  if (e.shiftKey && (e.key === "!" || e.code === "Digit1")) { e.preventDefault(); fitAll(); }
  else if (e.key === "v" || e.key === "V") setTool("select");
  else if (e.key === "n" || e.key === "N") setTool("note");
  else if (e.key === "p" || e.key === "P") setTool("pin");
  else if (e.key === "e" || e.key === "E") setEditMode(!editMode);
  else if (e.key === "\\") $("#side").classList.toggle("hidden");
  else if (e.key === "Escape") { setTool("select"); clearHl(); if (sel.size) { sel.clear(); applySelection(); } }
  else if (e.key === "Enter" || e.key === "F3") stepResult(e.shiftKey ? -1 : 1);
  else if (e.key === "+" || e.key === "=") zoomAt(1.25, vp.clientWidth / 2, vp.clientHeight / 2);
  else if (e.key === "-") zoomAt(0.8, vp.clientWidth / 2, vp.clientHeight / 2);
});
window.addEventListener("keyup", (e) => { if (e.key === " ") spaceDown = false; });
window.addEventListener("resize", apply);
function setTool(t) { tool = t; document.querySelectorAll("[data-tool]").forEach((b) => b.classList.toggle("on", b.dataset.tool === t)); vp.classList.toggle("tool-note", t === "note" || t === "pin"); }
document.querySelectorAll("[data-tool]").forEach((b) => (b.onclick = () => setTool(b.dataset.tool)));
$("#btnFit").onclick = fitAll;
$("#btnSide").onclick = () => $("#side").classList.toggle("hidden");
$("#btnNotes").onclick = () => { world.classList.toggle("hide-notes"); status(world.classList.contains("hide-notes") ? "Đã ẩn ghi chú" : "Hiện ghi chú"); };

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
  const pe = pageEls.find((p) => p.it.doc === r.p.doc && p.it.page === r.p.page); if (!pe) return;
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
function closeWbsd() { $("#wbsd").classList.add("hidden"); wbsCur = null; document.querySelectorAll(".wi.cur").forEach((e) => e.classList.remove("cur")); clearHl(); }
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
        const rows = its.filter((it) => (!wbsOnlyWarn || it.warnings.length) && (!nq || norm(it.name + " " + it.cat + " " + it.specs.map((s) => s.code).join(" ")).includes(nq)));
        if (!rows.length) continue;
        box.appendChild(el("div", "wc", cat));
        for (const it of rows) {
          const r = el("div", "wi"); r.dataset.id = it.id; if (wbsCur === it.id) r.classList.add("cur");
          r.appendChild(el("span", "n", it.stt));
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
function goPage(doc, page) {
  const pe = pageEls.find((p) => p.it.doc === doc && p.it.page === page); if (!pe) return status("Không thấy trang này trên bảng", 3000);
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
  const linkRow = (key, title, sub, click, conf) => {
    const r = el("div", "lk"); const c = el("div", "c"); c.appendChild(el("b", null, title)); if (sub) c.appendChild(el("small", null, sub)); if (conf) c.appendChild(el("small", "cf", conf));
    r.appendChild(c); r.onclick = click;
    if (key) {
      const v = el("button", "v", "?"); const paint = () => { const s = st.links[key]; v.className = "v" + (s === "ok" ? " ok" : s === "no" ? " no" : ""); v.textContent = s === "ok" ? "✓" : s === "no" ? "✗" : "?"; v.title = "Bấm để duyệt: ? → ✓ đúng → ✗ sai"; };
      paint(); v.onclick = (e) => { e.stopPropagation(); if (!me) return status("Cần đăng nhập để duyệt", 3000); st.links[key] = !st.links[key] ? "ok" : st.links[key] === "ok" ? "no" : ""; paint(); queueSave(); };
      r.appendChild(v);
    }
    return r;
  };
  B.appendChild(el("h4", null, "SPEC (" + it.specs.length + ")"));
  if (!it.specs.length) B.appendChild(el("div", "wbox warn", "Chưa có mã SPEC gắn với dòng này."));
  for (const s of it.specs) B.appendChild(linkRow("s:" + s.code, s.code + " · " + s.desc, s.loc + " · " + s.product + " · NCC: " + s.supplier, () => goPage(s.doc, s.page), s.conf === "cao" ? "Gợi ý: khớp tên" : "Gợi ý: tham khảo, cần xác nhận"));
  B.appendChild(el("h4", null, "Bản vẽ (" + it.drawings.length + ")"));
  if (!it.drawings.length) B.appendChild(el("div", "wbox warn", "Chưa có bản vẽ DD cho dòng này."));
  for (const d of it.drawings) B.appendChild(linkRow("d:" + d.page, d.label, "Trang " + d.page + " – DD 1st Submission", () => goPage(d.doc, d.page)));
  { // trang người dùng tự gắn từ bảng
    const ex = [];
    for (const [owner, d] of Object.entries(notes)) { const r = d.wbs && d.wbs[id]; if (r && r.extra) for (const x of r.extra) ex.push({ x, owner, d, mine: !!me && owner === me.email }); }
    B.appendChild(el("h4", null, "Trang gắn thêm từ bảng (" + ex.length + ")"));
    if (!ex.length) B.appendChild(el("div", "wbox", "Chọn trang trên bảng rồi bấm “＋ WBS” để gắn vào hạng mục này."));
    for (const e2 of ex) {
      const dd = board.docs[e2.x.doc];
      const r = linkRow(null, (dd ? dd.name : e2.x.doc) + " · tr." + e2.x.page, e2.mine ? "Bạn gắn" : "Bởi " + (e2.d.author || e2.owner), () => goPage(e2.x.doc, e2.x.page));
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
  const ta = el("textarea"); ta.placeholder = me ? "Ghi chú của bạn…" : "Đăng nhập để ghi chú"; ta.value = st.note || ""; ta.disabled = !me;
  ta.oninput = () => { st.note = ta.value; st.by = me.name || me.email; st.at = new Date().toISOString().slice(0, 10); queueSave(); };
  B.appendChild(ta);
  const peers = wbsPeers(id); if (peers.length) B.appendChild(el("div", "who", "Đã duyệt bởi: " + peers.join(", ")));
  for (const [owner, d] of Object.entries(notes)) { const r = d.wbs && d.wbs[id]; if (r && r.note && !(me && owner === me.email)) B.appendChild(el("div", "wbox", (d.author || owner) + ": " + r.note)); }
  // đưa bản vẽ chính lên màn hình
  const first = it.drawings[0] || it.specs[0]; if (first && !noFocus) goPage(first.doc, first.page);
}

/* ---------------- sửa bố cục bảng (kéo / xoá / thêm trang, di chuyển vùng) ---------------- */
// Bố cục của mỗi người lưu trong file ghi chú của họ (notes[email].layout), không đụng tới board.json gốc.
// L = { g:{idVung:{x,y,w,h,title,del}}, o:{khoá:{x,y}}, hide:[khoá], add:[mục thêm], ng:[vùng mới], docs:{tài liệu thêm} }
const clone = (o) => JSON.parse(JSON.stringify(o));
const keyOf = (it) => it.type === "page" ? it.doc + "#" + it.page : it.type === "label" ? "L:" + (it.doc || "") + ":" + it.text : "K:" + it.path;
const isPageKey = (k) => !/^[LK]:/.test(k);
const MK = { red: ["#dc2626", "Cần sửa"], amber: ["#f59e0b", "Cần xem lại"], green: ["#16a34a", "Đã duyệt"], blue: ["#2563eb", "Quan trọng"] };
function normL(l) { l = l || {}; l.g = l.g || {}; l.o = l.o || {}; l.hide = l.hide || []; l.add = l.add || []; l.ng = l.ng || []; l.docs = l.docs || {}; return l; }
function hasLayout(d) { const l = d && d.layout; return !!l && (Object.keys(l.g || {}).length + Object.keys(l.o || {}).length + (l.hide || []).length + (l.add || []).length + (l.ng || []).length) > 0; }
function computeBoard() {
  const b = clone(baseBoard);
  if (!L) return b;
  normL(L);
  b.groups = b.groups.filter((g) => !(L.g[g.id] && L.g[g.id].del)).map((g) => Object.assign(g, L.g[g.id] || {}));
  b.groups.push(...L.ng);
  const hide = new Set(L.hide);
  b.items = b.items.filter((it) => !hide.has(keyOf(it))).map((it) => { const o = L.o[keyOf(it)]; if (o) { it.x = o.x; it.y = o.y; } return it; });
  b.items.push(...L.add);
  Object.assign(b.docs, L.docs);
  return b;
}
function rebuildBoard() { board = computeBoard(); build(); applySelection(); renderAnnotations(); }
function renderAnnotations() { renderNotes(); renderPins(); renderMarks(); }
function curL() { return layoutOwner === "base" ? null : (notes[layoutOwner] && notes[layoutOwner].layout) || null; }
function setLayoutOwner(o, quiet) {
  if (editMode && !(me && o === me.email)) setEditMode(false);
  layoutOwner = o; L = curL();
  try { localStorage.setItem("pb_layout", o === "base" ? "base" : (me && o === me.email ? "me" : o)); } catch (e) {}
  rebuildBoard(); renderLayoutSel();
  if (!quiet) status(o === "base" ? "Đang xem bố cục gốc" : "Đang xem bố cục của " + (me && o === me.email ? "bạn" : (notes[o].author || o)), 2500);
}
function renderLayoutSel() {
  const s = $("#layoutSel"); if (!s) return; s.innerHTML = "";
  const add = (v, t) => { const o = el("option", null, t); o.value = v; s.appendChild(o); };
  add("base", "Bố cục gốc");
  if (me) add(me.email, "Bố cục của tôi");
  for (const [owner, d] of Object.entries(notes)) if (hasLayout(d) && !(me && owner === me.email)) add(owner, "Bố cục: " + (d.author || owner));
  s.value = layoutOwner; if (s.value !== layoutOwner) s.value = "base";
  s.classList.toggle("hidden", !board);
}
function initLayoutAfterNotes() {
  let want = "base";
  try { want = localStorage.getItem("pb_layout") || ""; } catch (e) {}
  const mineHas = me && hasLayout(notes[me.email]);
  if (want === "base") layoutOwner = "base";
  else if (want && want !== "me" && notes[want] && hasLayout(notes[want])) layoutOwner = want;
  else layoutOwner = mineHas ? me.email : "base";
  L = curL();
  rebuildBoard(); renderLayoutSel();
  if (layoutOwner !== "base") status("Đang dùng " + (me && layoutOwner === me.email ? "bố cục của bạn" : "bố cục của " + (notes[layoutOwner].author || layoutOwner)) + " (đổi ở ô Bố cục trên thanh công cụ)", 4000);
}
$("#layoutSel").onchange = (e) => setLayoutOwner(e.target.value);

/* ----- lịch sử hoàn tác ----- */
let hist = [], hpos = 0;
function commit() {
  hist = hist.slice(0, hpos + 1); hist.push(JSON.stringify(L)); hpos = hist.length - 1;
  if (hist.length > 80) { hist.shift(); hpos--; }
  queueSave(); renderEditBar(); renderLayoutSel();
}
function restoreHist() { L = normL(JSON.parse(hist[hpos])); myNotes().layout = L; rebuildBoard(); queueSave(); renderEditBar(); }
function undo() { if (hpos > 0) { hpos--; restoreHist(); } }
function redo() { if (hpos < hist.length - 1) { hpos++; restoreHist(); } }
function renderEditBar() { $("#eUndo").disabled = hpos <= 0; $("#eRedo").disabled = hpos >= hist.length - 1; }

/* ----- bật / tắt chế độ sửa ----- */
function becomeMine() {
  myNotes().layout = L = normL(L ? clone(L) : {});
  layoutOwner = me.email; rebuildBoard(); renderLayoutSel();
}
function setEditMode(on) {
  if (on) {
    if (!me) return status("Cần đăng nhập Google để sửa bố cục", 3000);
    if (layoutOwner !== me.email) becomeMine();
    L = normL(myNotes().layout); myNotes().layout = L; hist = [JSON.stringify(L)]; hpos = 0;
    setTool("select");
  }
  editMode = on; document.body.classList.toggle("editing", on);
  $("#editbar").classList.toggle("hidden", !on); $("#btnEdit").classList.toggle("on", on);
  renderEditBar(); renderSelBar();
  status(on ? "Kéo trang/vùng · quét khung chọn nhiều · Delete xoá · Ctrl+Z hoàn tác · Space+kéo để cuộn" : "Đã thoát chế độ sửa", on ? 7000 : 2000);
}
$("#btnEdit").onclick = () => setEditMode(!editMode);
$("#eDone").onclick = () => setEditMode(false);
$("#eUndo").onclick = undo; $("#eRedo").onclick = redo;
$("#eAdd").onclick = () => openAddDialog();
$("#eGroup").onclick = () => addGroup();
$("#eReset").onclick = () => {
  if (!confirm("Đưa bảng về bố cục gốc? Mọi chỗ bạn đã kéo/xoá/thêm sẽ mất (có thể Ctrl+Z ngay sau đó).")) return;
  L = normL({}); myNotes().layout = L; commit(); rebuildBoard();
};

/* ----- chọn mục ----- */
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
const boxOf = (n) => ({ x: n.it.x, y: n.it.y, w: n.it.w || n.el.offsetWidth, h: n.it.h || n.el.offsetHeight });
function moveNode(n, x, y) { n.it.x = Math.round(x * 10) / 10; n.it.y = Math.round(y * 10) / 10; n.el.style.left = n.it.x + "px"; n.el.style.top = n.it.y + "px"; }
function recordMoves(ns) { for (const n of ns) { if (!n.it.add) L.o[keyOf(n.it)] = { x: n.it.x, y: n.it.y }; } }
function viewCenter() { return { x: (vp.clientWidth / 2 - view.x) / view.s, y: (vp.clientHeight / 2 - view.y) / view.s }; }

/* ----- thanh thao tác khi có mục được chọn ----- */
function renderSelBar() {
  const bar = $("#selbar"); bar.innerHTML = "";
  if (!sel.size) { bar.classList.add("hidden"); return; }
  bar.classList.remove("hidden");
  const keys = [...sel], pk = keys.filter(isPageKey);
  bar.appendChild(el("b", null, pk.length === keys.length ? keys.length + " trang" : keys.length + " mục"));
  const btn = (txt, title, fn, cls) => { const b = el("button", cls || null, txt); b.title = title; b.onclick = fn; bar.appendChild(b); return b; };
  if (pk.length === 1) {
    btn("🔍", "Phóng to trang này", () => { const n = nodeEls.get(pk[0]); if (n) focusRect(n.it, 0.04); });
    btn("📄 PDF gốc", "Mở file PDF gốc trên Drive", () => openOriginal(pk[0]));
  }
  if (pk.length) {
    const sw = el("span", "sw");
    for (const [c, [hex, lab]] of Object.entries(MK)) { const i = el("i"); i.style.background = hex; i.title = "Đánh dấu: " + lab; i.onclick = () => setMark(pk, c); sw.appendChild(i); }
    const clr = el("i", "clr", "∅"); clr.title = "Bỏ đánh dấu"; clr.onclick = () => setMark(pk, ""); sw.appendChild(clr);
    bar.appendChild(sw);
    btn("＋ WBS", "Gắn các trang đã chọn vào một hạng mục WBS", () => wbsPick(pk));
  }
  if (editMode) {
    bar.appendChild(el("span", "sep"));
    btn("⇤", "Căn trái", () => alignSel("l")); btn("⤒", "Căn trên", () => alignSel("t"));
    btn("↔", "Dàn đều theo chiều ngang", () => alignSel("h")); btn("↕", "Dàn đều theo chiều dọc", () => alignSel("v"));
    btn("▦", "Xếp lưới…", gridSel);
    btn("🗑", "Xoá khỏi bảng (Delete) – file gốc không bị xoá", deleteSelection, "danger");
  }
  btn("✕", "Bỏ chọn (Esc)", () => { sel.clear(); applySelection(); });
}
function openOriginal(k) {
  const [doc, page] = k.split("#"), d = board.docs[doc]; if (!d) return;
  const u = src.openUrl(d.path);
  if (u) window.open(u + (src.kind === "local" ? "#page=" + page : ""), "_blank"); else status("Chưa tìm thấy file trên Drive (đang đồng bộ?)", 4000);
}

/* ----- đánh dấu màu (mọi người cùng thấy) ----- */
function markOf(k) { let r = null; for (const [owner, d] of Object.entries(notes)) { const c = d.marks && d.marks[k]; if (c) { if (me && owner === me.email) return c; r = r || c; } } return r; }
function setMark(keys, c) {
  if (!me) return status("Cần đăng nhập để đánh dấu", 3000);
  const m = (myNotes().marks = myNotes().marks || {});
  for (const k of keys) { if (c) m[k] = c; else delete m[k]; }
  queueSave(); renderMarks();
  status(c ? "Đã đánh dấu " + keys.length + " trang: " + MK[c][1] : "Đã bỏ đánh dấu", 2000);
}
function renderMarks() {
  for (const [k, n] of nodeEls) {
    if (!isPageKey(k)) continue;
    const c = markOf(k);
    if (c && MK[c]) { n.el.dataset.mark = c; n.el.style.setProperty("--mk", MK[c][0]); n.el.title = MK[c][1]; }
    else { delete n.el.dataset.mark; n.el.style.removeProperty("--mk"); n.el.removeAttribute("title"); }
  }
}

/* ----- ghim lên trang ----- */
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
      box.appendChild(pb);
      box.firstChild.onclick = () => box.classList.toggle("open");
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

/* ----- kéo thả khi sửa bố cục ----- */
let eDrag = null;
function editPointerDown(e) {
  const t = e.target;
  const grp = t.closest(".grp");
  if (t.closest(".gx")) { e.preventDefault(); deleteGroup(grp.dataset.gid); return true; }
  if (t.closest(".gr")) { e.preventDefault(); renameGroup(grp.dataset.gid); return true; }
  const gt = t.closest(".gt,.gm"), gh = t.closest(".gh");
  if (gt || gh) {
    const g = board.groups.find((x) => x.id === grp.dataset.gid); if (!g) return false;
    const inside = [];
    if (gt) for (const n of nodeEls.values()) { const b = boxOf(n), cx = b.x + b.w / 2, cy = b.y + b.h / 2; if (cx >= g.x && cx <= g.x + g.w && cy >= g.y && cy <= g.y + g.h) inside.push({ n, ox: n.it.x, oy: n.it.y }); }
    eDrag = { type: gt ? "group" : "resize", pid: e.pointerId, sx: e.clientX, sy: e.clientY, g, ox: g.x, oy: g.y, ow: g.w, oh: g.h, inside, moved: false };
    vp.setPointerCapture(e.pointerId); vp.classList.add("panning"); return true;
  }
  const nd = t.closest(".pg,.lbl,.lnk");
  if (nd) {
    const k = nd.dataset.k, multi = e.shiftKey || e.ctrlKey || e.metaKey; let collapse = null;
    if (!sel.has(k)) { if (!multi) sel.clear(); sel.add(k); paintSel(); renderSelBar(); }
    else collapse = multi ? "toggle" : "single";
    eDrag = { type: "move", pid: e.pointerId, sx: e.clientX, sy: e.clientY, k, collapse, moved: false, items: selNodes().map((n) => ({ n, ox: n.it.x, oy: n.it.y })) };
    vp.setPointerCapture(e.pointerId); return true;
  }
  if (t.closest(".note,.pin")) return false;
  // nền: quét khung chọn nhiều
  const multi = e.shiftKey || e.ctrlKey || e.metaKey;
  eDrag = { type: "marq", pid: e.pointerId, sx: e.clientX, sy: e.clientY, base: multi ? new Set(sel) : new Set(), moved: false };
  if (!multi && sel.size) { sel.clear(); paintSel(); renderSelBar(); }
  vp.setPointerCapture(e.pointerId); return true;
}
function eDragMove(e) {
  const d = eDrag, dx = (e.clientX - d.sx) / view.s, dy = (e.clientY - d.sy) / view.s;
  if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 4) return;
  d.moved = true;
  if (d.type === "move") { for (const o of d.items) moveNode(o.n, o.ox + dx, o.oy + dy); placePins(); }
  else if (d.type === "group") {
    d.g.x = Math.round(d.ox + dx); d.g.y = Math.round(d.oy + dy);
    const ge = world.querySelector(`.grp[data-gid="${CSS.escape(d.g.id)}"]`); ge.style.left = d.g.x + "px"; ge.style.top = d.g.y + "px";
    for (const o of d.inside) moveNode(o.n, o.ox + dx, o.oy + dy); placePins();
  } else if (d.type === "resize") {
    d.g.w = Math.max(400, Math.round(d.ow + dx)); d.g.h = Math.max(300, Math.round(d.oh + dy));
    const ge = world.querySelector(`.grp[data-gid="${CSS.escape(d.g.id)}"]`); ge.style.width = d.g.w + "px"; ge.style.height = d.g.h + "px";
  } else if (d.type === "marq") {
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
  const d = eDrag; eDrag = null; vp.classList.remove("panning"); $("#marq").classList.add("hidden");
  if (!d) return;
  if (cancelled) { rebuildBoard(); return; }
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
  else if (d.type === "group") { saveGroup(d.g); recordMoves(d.inside.map((o) => o.n)); }
  else if (d.type === "resize") saveGroup(d.g);
  commit();
}
function saveGroup(g) { if (!g.nw) L.g[g.id] = Object.assign(L.g[g.id] || {}, { x: g.x, y: g.y, w: g.w, h: g.h, title: g.title }); }
function deleteGroup(gid) {
  const g = board.groups.find((x) => x.id === gid); if (!g) return;
  if (!confirm("Xoá vùng “" + g.title + "”?\nCác trang bên trong vẫn giữ nguyên trên bảng.")) return;
  if (g.nw) L.ng = L.ng.filter((x) => x.id !== gid); else L.g[gid] = Object.assign(L.g[gid] || {}, { del: 1 });
  commit(); rebuildBoard();
}
function renameGroup(gid) {
  const g = board.groups.find((x) => x.id === gid); if (!g) return;
  const v = prompt("Tên vùng:", g.title); if (v == null || !v.trim()) return;
  g.title = v.trim(); saveGroup(g); commit(); rebuildBoard();
}
function addGroup() {
  const c = viewCenter();
  L.ng.push({ id: "Z" + Date.now().toString(36), title: "Vùng mới", color: "#7c3aed", x: Math.round(c.x - 600), y: Math.round(c.y - 400), w: 1200, h: 800, nw: 1 });
  commit(); rebuildBoard(); status("Đã thêm vùng mới – kéo tiêu đề để di chuyển, kéo góc dưới phải để đổi cỡ, ✎ để đổi tên", 5000);
}
function deleteSelection() {
  if (!editMode || !sel.size) return;
  if (sel.size > 3 && !confirm("Xoá " + sel.size + " mục khỏi bảng?\n(File gốc không bị xoá; có thể khôi phục bằng “＋ Thêm trang”.)")) return;
  const n0 = sel.size;
  for (const k of [...sel]) {
    const n = nodeEls.get(k); if (!n) continue;
    const i = L.add.indexOf(n.it); if (i >= 0) L.add.splice(i, 1); else if (!L.hide.includes(k)) L.hide.push(k);
  }
  sel.clear(); commit(); rebuildBoard(); status("Đã xoá " + n0 + " mục khỏi bảng (Ctrl+Z để hoàn tác)", 3500);
}
function nudgeSel(key, step) {
  const ns = selNodes(); if (!ns.length) return;
  const dx = key === "ArrowLeft" ? -step : key === "ArrowRight" ? step : 0, dy = key === "ArrowUp" ? -step : key === "ArrowDown" ? step : 0;
  for (const n of ns) moveNode(n, n.it.x + dx, n.it.y + dy);
  recordMoves(ns); placePins(); clearTimeout(nudgeSel.t); nudgeSel.t = setTimeout(commit, 400);
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
  recordMoves(ns); placePins(); commit();
}
function gridSel() {
  const ns = selNodes(); if (ns.length < 2) return status("Chọn ít nhất 2 mục", 2500);
  const cols = parseInt(prompt("Xếp thành mấy cột?", String(Math.min(ns.length, 5))), 10); if (!cols || cols < 1) return;
  const bx = ns.map(boxOf), x0 = Math.min(...bx.map((b) => b.x)), y0 = Math.min(...bx.map((b) => b.y));
  const cw = Math.max(...bx.map((b) => b.w)) + 15, ch = Math.max(...bx.map((b) => b.h)) + 15, rh = bx.reduce((s2, b) => s2 + b.h, 0) / bx.length;
  const order = ns.map((n, i) => ({ n, b: bx[i], row: Math.round(bx[i].y / rh) })).sort((a, b) => a.row - b.row || a.b.x - b.b.x);
  order.forEach((o, i) => moveNode(o.n, x0 + (i % cols) * cw, y0 + Math.floor(i / cols) * ch));
  recordMoves(ns); placePins(); commit();
}

/* ----- cửa sổ phụ ----- */
function openModal(title, node) { $("#mTitle").textContent = title; const b = $("#mBody"); b.innerHTML = ""; b.appendChild(node); $("#modal").classList.remove("hidden"); }
function closeModal() { $("#modal").classList.add("hidden"); $("#mBody").innerHTML = ""; }
$("#mClose").onclick = closeModal;
$("#modal").addEventListener("pointerdown", (e) => { if (e.target.id === "modal") closeModal(); });

/* ----- gắn trang vào hạng mục WBS ----- */
function wbsPick(keys) {
  if (!wbs) return status("Chưa có dữ liệu WBS cho dự án này", 3000);
  if (!me) return status("Cần đăng nhập để gắn vào WBS", 3000);
  const B = el("div"), q = el("input"); q.type = "search"; q.placeholder = "Tìm hạng mục (tên, nhóm, STT)…"; B.appendChild(q);
  const list = el("div", "mlist"); B.appendChild(list);
  const draw = () => {
    list.innerHTML = ""; const nq = norm(q.value); let c = 0;
    for (const { z, p, it } of allWbsItems()) {
      if (nq && !norm(it.stt + " " + it.name + " " + it.cat + " " + p.title).includes(nq)) continue;
      if (++c > 80) break;
      const r = el("div", "mrow"); r.append(el("b", null, it.stt + ". " + it.name), el("small", null, z.title + " · " + p.title + " · " + it.cat));
      r.onclick = () => { addToWbs(it.id, keys); closeModal(); }; list.appendChild(r);
    }
    if (!c) list.appendChild(el("div", "wbox", "Không có hạng mục phù hợp"));
  };
  q.oninput = draw; draw(); openModal("Gắn " + keys.length + " trang vào hạng mục WBS", B); q.focus();
}
function addToWbs(id, keys) {
  const st = wbsState(id); st.extra = st.extra || []; let n = 0;
  for (const k of keys) { const [doc, pg] = k.split("#"), page = +pg; if (!st.extra.some((x) => x.doc === doc && x.page === page)) { st.extra.push({ doc, page }); n++; } }
  st.by = me.name || me.email; st.at = new Date().toISOString().slice(0, 10); queueSave();
  status("Đã gắn " + n + " trang vào hạng mục", 3000);
  $("#side").classList.remove("hidden"); setSideTab("wbs"); openWbsItem(id, true);
}

/* ----- thêm trang: khôi phục trang đã xoá / thêm file PDF mới ----- */
const hashStr = (s2) => { let h = 5381; for (let i = 0; i < s2.length; i++) h = ((h << 5) + h + s2.charCodeAt(i)) | 0; return Math.abs(h).toString(36); };
function parseRange(spec, n) {
  const out = new Set();
  for (const part of String(spec).split(/[,;\s]+/)) { const m = part.match(/^(\d+)(?:-(\d+))?$/); if (!m) continue; const a = +m[1], b = m[2] ? +m[2] : a; for (let i = Math.max(1, Math.min(a, b)); i <= Math.min(n, Math.max(a, b)); i++) out.add(i); }
  return [...out].sort((a, b) => a - b);
}
function describeItem(it) { return it.type === "page" ? ((baseBoard.docs[it.doc] || {}).name || it.doc) + " — tr." + it.page : it.type === "label" ? "Tiêu đề: " + it.text : "File: " + it.name; }
function openAddDialog() {
  if (!editMode) return;
  const B = el("div"), tabs = el("div", "mtabs"), t1 = el("button", "on", "Trang đã xoá"), t2 = el("button", null, "Thêm file PDF mới");
  tabs.append(t1, t2); B.appendChild(tabs);
  const p1 = el("div"), p2 = el("div", "hidden"); B.append(p1, p2);
  // --- tab 1
  const hidden = baseBoard.items.filter((it) => L.hide.includes(keyOf(it)));
  if (!hidden.length) p1.appendChild(el("div", "wbox", "Chưa có mục nào bị xoá khỏi bảng. Khi xoá trang, nó sẽ nằm ở đây để khôi phục."));
  else {
    const chosen = new Set(), rows = [];
    const all = el("label", "mrow"), ca = el("input"); ca.type = "checkbox"; all.append(ca, document.createTextNode(" Chọn tất cả (" + hidden.length + ")")); p1.appendChild(all);
    const lst = el("div", "mlist"); p1.appendChild(lst);
    for (const it of hidden) {
      const k = keyOf(it), l = el("label", "mrow"), c = el("input"); c.type = "checkbox"; rows.push(c);
      c.onchange = () => { if (c.checked) chosen.add(k); else chosen.delete(k); };
      l.append(c, document.createTextNode(" " + describeItem(it))); lst.appendChild(l);
    }
    ca.onchange = () => rows.forEach((c) => { c.checked = ca.checked; c.onchange(); });
    const go = el("button", "primary", "Khôi phục mục đã chọn");
    go.onclick = () => { if (!chosen.size) return status("Chưa chọn mục nào", 2000); const n = chosen.size; L.hide = L.hide.filter((k) => !chosen.has(k)); commit(); rebuildBoard(); closeModal(); status("Đã khôi phục " + n + " mục về đúng chỗ cũ", 3000); };
    p1.appendChild(go);
  }
  // --- tab 2
  let pdfList = null;
  const fq = el("input"); fq.type = "search"; fq.placeholder = "Lọc theo tên file / thư mục…";
  const lst2 = el("div", "mlist"), info = el("div", "msub"); p2.append(fq, lst2, info);
  const drawList = () => {
    lst2.innerHTML = ""; const nq = norm(fq.value), used = new Set(Object.values(board.docs).map((d) => d.path)); let c = 0;
    for (const f of pdfList) {
      if (used.has(f.path) || (nq && !norm(f.path).includes(nq))) continue;
      if (++c > 100) break;
      const r = el("div", "mrow"); r.append(el("b", null, f.name), el("small", null, f.path)); r.onclick = () => pickPdf(f); lst2.appendChild(r);
    }
    if (!c) lst2.appendChild(el("div", "wbox", "Không có file PDF nào chưa nằm trên bảng" + (nq ? " khớp bộ lọc." : ".")));
  };
  fq.oninput = () => pdfList && drawList();
  async function pickPdf(f) {
    info.textContent = "Đang mở " + f.name + " …";
    const id = "x" + hashStr(f.path);
    board.docs[id] = board.docs[id] || { name: f.name, path: f.path, pages: 0, kind: "pdf", group: "", dupes: [], scanned: false };
    let pdf; try { pdf = await getPdf(id); } catch (e) { info.textContent = "Không mở được file: " + e.message; return; }
    board.docs[id].pages = pdf.numPages; lst2.classList.add("hidden"); fq.classList.add("hidden"); info.innerHTML = "";
    info.append(el("b", null, f.name), el("div", "msub", pdf.numPages + " trang · lưu ý: trang thêm mới chưa tìm kiếm được bằng ô Tìm"));
    const rg = el("input"); rg.value = "1-" + Math.min(pdf.numPages, 20); rg.placeholder = "VD: 1-10,15";
    const go = el("button", "primary", "Thêm vào bảng"); go.onclick = () => addPdfPages(id, f, pdf, rg.value, go);
    info.append(el("div", null, "Trang cần thêm (tối đa 60 trang một lần):"), rg, go);
  }
  t1.onclick = () => { t1.className = "on"; t2.className = ""; p1.classList.remove("hidden"); p2.classList.add("hidden"); };
  t2.onclick = async () => {
    t2.className = "on"; t1.className = ""; p2.classList.remove("hidden"); p1.classList.add("hidden");
    if (!pdfList) { info.textContent = "Đang đọc danh sách file PDF trên Drive…"; try { pdfList = await src.listPdfs(); } catch (e) { pdfList = []; } info.textContent = ""; }
    drawList(); fq.focus();
  };
  openModal("Thêm trang vào bảng", B);
}
async function addPdfPages(id, f, pdf, spec, goBtn) {
  const pgs = parseRange(spec, pdf.numPages).slice(0, 60); if (!pgs.length) return status("Chưa chọn trang nào", 3000);
  goBtn.disabled = true; goBtn.textContent = "Đang thêm…";
  const c = viewCenter(), cols = 5, gap = 15; let x = c.x, y = c.y, rowH = 0, col = 0; const items = [];
  for (const pn of pgs) {
    const page = await pdf.getPage(pn), v = page.getViewport({ scale: 1 }), w = Math.round(v.width * 0.3528 * 10) / 10, h = Math.round(v.height * 0.3528 * 10) / 10;
    if (col === cols) { col = 0; x = c.x; y += rowH + gap; rowH = 0; }
    items.push({ type: "page", doc: id, page: pn, x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, w, h, render: 1, add: 1 });
    x += w + gap; rowH = Math.max(rowH, h); col++;
  }
  const gid = (board.groups.find((g) => c.x >= g.x && c.x <= g.x + g.w && c.y >= g.y && c.y <= g.y + g.h) || {}).id || "";
  L.docs[id] = { name: f.name, path: f.path, pages: pdf.numPages, kind: "pdf", group: gid, dupes: [], scanned: false };
  const exist = new Set(L.add.map(keyOf)), fresh = items.filter((it) => !exist.has(keyOf(it)));
  const lab = { type: "label", x: Math.round(c.x), y: Math.round(c.y - 50), text: f.name, doc: id, sub: f.path, add: 1 };
  if (!exist.has(keyOf(lab))) L.add.push(lab);
  L.add.push(...fresh);
  commit(); rebuildBoard(); closeModal();
  const x0 = Math.min(...fresh.map((i) => i.x)), y0 = Math.min(...fresh.map((i) => i.y - 50)), x1 = Math.max(...fresh.map((i) => i.x + i.w)), y1 = Math.max(...fresh.map((i) => i.y + i.h));
  focusRect({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, 0.08);
  status("Đã thêm " + fresh.length + " trang từ " + f.name + " – kéo chúng vào đúng vùng", 5000);
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
})();
