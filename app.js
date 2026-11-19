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
  board = await src.json("_BOARD/board.json");
  $("#projName").textContent = board.project;
  document.title = board.project + " – Project Board";
  build();
  fitAll();
  status(`Đã mở: ${Object.keys(board.docs).length} tài liệu, ${board.items.filter((i) => i.type === "page").length} trang`);
  src.json("_BOARD/index.json").then((d) => { index = d.pages; index.forEach((p) => { p.text = p.text.normalize("NFC"); p.n = normC(p.text); }); $("#q").placeholder = `Tìm trong ${index.length} trang… (Ctrl+F)`; }).catch(() => status("Chưa có index.json – không tìm kiếm được", 5000));
  src.json("_BOARD/wbs.json").then((w) => { if (w && w.zones) { wbs = w; $("#btnWbs").classList.remove("hidden"); document.querySelector("[data-tab=wbs]").classList.remove("hidden"); renderWbs(); } }).catch(() => {});
  origReady = src.indexOriginals();
  origReady.then(() => document.querySelectorAll(".lnk").forEach((e) => e.classList.toggle("nf", !src.has(e.dataset.path))));
  src.loadNotes().then((n) => { notes = n; renderNotes(); }).catch((e) => console.warn(e));
}

function build() {
  world.innerHTML = ""; pageEls.length = 0;
  for (const g of board.groups) {
    const d = el("div", "grp"); Object.assign(d.style, { left: g.x + "px", top: g.y + "px", width: g.w + "px", height: g.h + "px", borderColor: g.color });
    const t = el("div", "gt", g.title); t.style.color = g.color; d.appendChild(t); world.appendChild(d);
  }
  for (const it of board.items) {
    if (it.type === "label") {
      const d = el("div", "lbl"); d.style.left = it.x + "px"; d.style.top = it.y + "px";
      d.appendChild(el("b", null, it.text)); if (it.sub) d.appendChild(el("small", null, it.sub)); world.appendChild(d);
    } else if (it.type === "page") {
      const d = el("div", "pg"); Object.assign(d.style, { left: it.x + "px", top: it.y + "px", width: it.w + "px", height: it.h + "px" });
      d.dataset.doc = it.doc; d.dataset.page = it.page;
      const img = el("img"); img.alt = ""; img.draggable = false; d.appendChild(img);
      d.appendChild(el("span", "pn", it.page + "/" + board.docs[it.doc].pages));
      world.appendChild(d); pageEls.push({ it, el: d, img, level: 0, want: 0 });
      d.addEventListener("dblclick", (e) => { e.stopPropagation(); focusRect(it, 0.04); });
    } else if (it.type === "link") {
      const d = el("div", "lnk"); Object.assign(d.style, { left: it.x + "px", top: it.y + "px", width: it.w + "px", height: it.h + "px" });
      d.dataset.path = it.path; d.title = it.path + "\n(bấm để mở)";
      d.appendChild(el("span", "ext " + it.ext, it.ext)); d.appendChild(el("span", "nm", it.name));
      d.addEventListener("click", () => { const u = src.openUrl(it.path); if (u) window.open(u, "_blank"); else status("Chưa tìm thấy file trên Drive (đang đồng bộ?)", 4000); });
      world.appendChild(d);
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
  if (e.target.closest(".note") && e.button === 0 && !spaceDown) return;
  if (e.target.closest(".lnk") && e.button === 0 && !spaceDown) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (tool === "note" && e.button === 0 && pointers.size === 1) { e.preventDefault(); pointers.delete(e.pointerId); addNoteAt(e); return; }
  vp.setPointerCapture(e.pointerId);
  if (pointers.size === 1) { drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false }; vp.classList.add("panning"); }
  else drag = null;
});
vp.addEventListener("pointermove", (e) => {
  if (!pointers.has(e.pointerId)) return;
  const prev = pointers.get(e.pointerId); pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()]; const pa = e.pointerId === [...pointers.keys()][0] ? prev : a, pb = e.pointerId === [...pointers.keys()][1] ? prev : b;
    const d0 = Math.hypot(pa.x - pb.x, pa.y - pb.y), d1 = Math.hypot(a.x - b.x, a.y - b.y);
    const r = vp.getBoundingClientRect(), cx = (a.x + b.x) / 2 - r.left, cy = (a.y + b.y) / 2 - r.top;
    view.x += ((a.x + b.x) - (pa.x + pb.x)) / 2; view.y += ((a.y + b.y) - (pa.y + pb.y)) / 2;
    if (d0 > 0) zoomAt(d1 / d0, cx, cy); else apply();
  } else if (drag) { view.x = drag.vx + e.clientX - drag.x; view.y = drag.vy + e.clientY - drag.y; drag.moved = true; apply(); }
});
const up = (e) => { pointers.delete(e.pointerId); if (!pointers.size) { drag = null; vp.classList.remove("panning"); } };
vp.addEventListener("pointerup", up); vp.addEventListener("pointercancel", up);

window.addEventListener("keydown", (e) => {
  const typing = e.target.closest("input,textarea,[contenteditable=true]");
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") { e.preventDefault(); $("#q").focus(); $("#q").select(); return; }
  if (typing) { if (e.key === "Escape") e.target.blur(); return; }
  if (e.key === " ") spaceDown = true;
  if (e.shiftKey && (e.key === "!" || e.code === "Digit1")) { e.preventDefault(); fitAll(); }
  else if (e.key === "v" || e.key === "V") setTool("select");
  else if (e.key === "n" || e.key === "N") setTool("note");
  else if (e.key === "\\") $("#side").classList.toggle("hidden");
  else if (e.key === "Escape") { setTool("select"); clearHl(); }
  else if (e.key === "Enter" || e.key === "F3") stepResult(e.shiftKey ? -1 : 1);
  else if (e.key === "+" || e.key === "=") zoomAt(1.25, vp.clientWidth / 2, vp.clientHeight / 2);
  else if (e.key === "-") zoomAt(0.8, vp.clientWidth / 2, vp.clientHeight / 2);
});
window.addEventListener("keyup", (e) => { if (e.key === " ") spaceDown = false; });
window.addEventListener("resize", apply);
function setTool(t) { tool = t; document.querySelectorAll("[data-tool]").forEach((b) => b.classList.toggle("on", b.dataset.tool === t)); vp.classList.toggle("tool-note", t === "note"); }
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
function openWbsItem(id) {
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
  const first = it.drawings[0] || it.specs[0]; if (first) goPage(first.doc, first.page);
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
