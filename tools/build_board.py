#!/usr/bin/env python3
"""Project Board builder.

Quet thu muc du an, render trang PDF/anh thanh WebP, trich chu (OCR neu la ban scan),
roi sinh _BOARD/board.json (bo cuc) va _BOARD/index.json (chi muc tim kiem).

Chay lai bao nhieu lan cung duoc: buoc nao xong roi se bo qua.
  python3 build_board.py <thu-muc-du-an> [--budget GIAY] [--tessdata DIR]
Thoat voi ma 3 neu het thoi gian ma chua xong (chay lai de lam tiep).
"""
import argparse, hashlib, json, os, re, subprocess, sys, time, tempfile, html
from pathlib import Path
from PIL import Image

Image.MAX_IMAGE_PIXELS = None
BOARD = "_BOARD"
SKIP_EXT = {".ini", ".dwl", ".dwl2", ".bak", ".tmp", ".lnk", ".db", ".log"}
IMG_EXT = {".jpg", ".jpeg", ".png", ".tif", ".tiff", ".bmp", ".webp"}
THUMB = 640
T0 = time.time()

DEFAULT_GROUPS = {
    "_huong_dan": "Moi nhom co 'match': danh sach regex (khong phan biet hoa thuong) so voi duong dan tuong doi. File khop nhom dau tien. 'prefer' dung khi 2 file PDF trung noi dung.",
    "groups": [
        {"id": "A", "title": "A. Bản vẽ thiết kế (TKKT/DD, SD)", "color": "#2563eb",
         "match": [r"TKKT_DD/DWGs", r"_SD_", r" - 3D SD", r"\.zip$"]},
        {"id": "B", "title": "B. SPEC", "color": "#16a34a",
         "match": [r"/SPEC/", r"LOOSE FURNITURE", r"MATERIAL&FINISHES", r"SWITCHES"]},
        {"id": "C", "title": "C. Phạm vi công việc & Tiến độ", "color": "#ea580c",
         "match": [r"ti[eế]n [dđ][oộ]", r"PH[AẠ]M VI"]},
        {"id": "D", "title": "D. HSSE – An ninh an toàn hàng không", "color": "#dc2626",
         "match": [r"HSSE", r"an ninh"]},
        {"id": "E", "title": "E. Nhân sự & Ngân sách", "color": "#7c3aed",
         "match": [r"Nh[aâ]n S[uự]", r"B[aá]o gi[aá]", r"Ng[aâ]n s[aá]ch"]},
        {"id": "G", "title": "G. Hợp đồng", "color": "#0891b2", "match": [r"h[oợ]p [dđ][oồ]ng", r"contract"]},
        {"id": "H", "title": "H. Phối hợp & Hiện trường", "color": "#ca8a04", "match": [r"02-PHOI HOP", r"03-HIEN TRUONG"]},
        {"id": "F", "title": "F. Bản vẽ nội bộ (01-DRAWING)", "color": "#475569", "match": [r"^01-DRAWING/"]},
        {"id": "Z", "title": "Z. Khác", "color": "#64748b", "match": [r".*"]},
    ],
    "prefer": [r"/SPEC/", r"/DWGs/"],
    "skip": [r"/xref/", r"^05-BACK UP/", r"^00-MO HINH/"],
}


def log(*a):
    print(*a, flush=True)


def over(budget):
    return time.time() - T0 > budget


def md5(p):
    h = hashlib.md5()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def load_json(p, default):
    try:
        return json.loads(Path(p).read_text(encoding="utf-8"))
    except Exception:
        return default


def save_json(p, obj, compact=False):
    p = Path(p)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(p.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":") if compact else None,
                              indent=None if compact else 1), encoding="utf-8")
    os.replace(tmp, p)


def pdf_pages(path):
    out = subprocess.run(["pdfinfo", str(path)], capture_output=True, text=True, errors="ignore").stdout
    n = int(re.search(r"Pages:\s+(\d+)", out).group(1))
    sizes = []
    # kich thuoc tung trang
    out = subprocess.run(["pdfinfo", "-f", "1", "-l", str(n), str(path)], capture_output=True, text=True,
                         errors="ignore").stdout
    for m in re.finditer(r"Page\s+\d+ size:\s+([\d.]+) x ([\d.]+)", out):
        sizes.append((float(m.group(1)), float(m.group(2))))
    rot = [int(m.group(1)) for m in re.finditer(r"Page\s+\d+ rot:\s+(\d+)", out)]
    if not sizes:
        m = re.search(r"Page size:\s+([\d.]+) x ([\d.]+)", out)
        sizes = [(float(m.group(1)), float(m.group(2)))] * n
    for i, r in enumerate(rot[:len(sizes)]):
        if r in (90, 270):
            sizes[i] = (sizes[i][1], sizes[i][0])
    return n, sizes


def target_long_px(long_in):
    return int(min(8000, max(2400, long_in * 150)))


def save_webp(img, full_path, thumb_path):
    img = img.convert("RGB")
    img.save(full_path, "WEBP", quality=72, method=4)
    t = img.copy()
    t.thumbnail((THUMB, THUMB))
    t.save(thumb_path, "WEBP", quality=70)


def render_pdf_page(pdf, pageno, size_pt, outdir):
    full = outdir / f"p{pageno:03d}.webp"
    thumb = outdir / f"p{pageno:03d}_t.webp"
    long_in = max(size_pt) / 72
    if full.exists() and thumb.exists():
        try:
            with Image.open(full) as im:
                if max(im.size) >= 0.9 * target_long_px(long_in):
                    return False
        except Exception:
            pass
    dpi = max(36, int(target_long_px(long_in) / long_in))
    with tempfile.TemporaryDirectory() as td:
        base = Path(td) / "r"
        subprocess.run(["pdftoppm", "-f", str(pageno), "-l", str(pageno), "-r", str(dpi), "-png", "-singlefile",
                        str(pdf), str(base)], check=True, capture_output=True)
        with Image.open(str(base) + ".png") as im:
            save_webp(im, full, thumb)
    return True


def parse_bbox_html(xhtml):
    pages = []
    for pm in re.finditer(r'<page width="([\d.]+)" height="([\d.]+)">(.*?)</page>', xhtml, re.S):
        W, H = float(pm.group(1)), float(pm.group(2))
        words = []
        for wm in re.finditer(r'<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">(.*?)</word>',
                              pm.group(3)):
            x0, y0, x1, y1 = (float(wm.group(i)) for i in range(1, 5))
            words.append([round(x0 / W, 4), round(y0 / H, 4), round(x1 / W, 4), round(y1 / H, 4),
                          html.unescape(wm.group(5))])
        pages.append(words)
    return pages


def ocr_page(pdf, pageno, tessdata, lang):
    with tempfile.TemporaryDirectory() as td:
        base = Path(td) / "o"
        subprocess.run(["pdftoppm", "-f", str(pageno), "-l", str(pageno), "-r", "240", "-gray", "-png",
                        "-singlefile", str(pdf), str(base)], check=True, capture_output=True)
        png = str(base) + ".png"
        with Image.open(png) as im:
            W, H = im.size
        env = dict(os.environ, OMP_THREAD_LIMIT="1")
        if tessdata:
            env["TESSDATA_PREFIX"] = tessdata
        out = subprocess.run(["tesseract", png, "stdout", "-l", lang, "--psm", "3", "tsv"], capture_output=True,
                             text=True, env=env, errors="ignore").stdout
    words = []
    for line in out.splitlines()[1:]:
        c = line.split("\t")
        if len(c) < 12 or c[0] != "5" or not c[11].strip():
            continue
        try:
            conf = float(c[10])
        except ValueError:
            conf = 0
        if conf < 30:
            continue
        x, y, w, h = (int(v) for v in c[6:10])
        words.append([round(x / W, 4), round(y / H, 4), round((x + w) / W, 4), round((y + h) / H, 4), c[11]])
    return words


def deaccent(s):
    import unicodedata
    s = unicodedata.normalize("NFD", s).replace("\u0111", "d").replace("\u0110", "D")
    return "".join(c for c in s if unicodedata.category(c) != "Mn")


def classify(rel, cfg):
    plain = deaccent(rel)
    for g in cfg["groups"]:
        for pat in g["match"]:
            if re.search(pat, rel, re.I) or re.search(deaccent(pat), plain, re.I):
                return g["id"]
    return cfg["groups"][-1]["id"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("root")
    ap.add_argument("--budget", type=float, default=1e9)
    ap.add_argument("--tessdata", default=os.environ.get("TESSDATA_PREFIX", ""))
    ap.add_argument("--lang", default="vie+eng")
    ap.add_argument("--jobs", type=int, default=os.cpu_count() or 2)
    a = ap.parse_args()
    root = Path(a.root).resolve()
    bd = root / BOARD
    (bd / "pages").mkdir(parents=True, exist_ok=True)
    (bd / "text").mkdir(parents=True, exist_ok=True)
    cfg_path = bd / "groups.json"
    if not cfg_path.exists():
        save_json(cfg_path, DEFAULT_GROUPS)
    cfg = load_json(cfg_path, DEFAULT_GROUPS)
    cache = load_json(bd / "cache.json", {})

    # 1. quet file
    files = []
    for dp, dn, fn in os.walk(root):
        rd = Path(dp).relative_to(root).as_posix()
        if rd == BOARD or rd.startswith(BOARD + "/"):
            dn[:] = []
            continue
        for f in fn:
            ext = Path(f).suffix.lower()
            if ext in SKIP_EXT or f.startswith("~$") or f.startswith("."):
                continue
            rel = (Path(rd) / f).as_posix() if rd != "." else f
            if any(re.search(p, rel, re.I) for p in cfg.get("skip", [])):
                continue
            st = (root / rel).stat()
            files.append({"path": rel, "name": f, "ext": ext, "size": st.st_size, "mtime": int(st.st_mtime)})
    files.sort(key=lambda x: x["path"].lower())

    # 2. hash + so trang (co cache)
    for f in files:
        if f["ext"] != ".pdf" and f["ext"] not in IMG_EXT:
            continue
        key = f"{f['path']}|{f['size']}|{f['mtime']}"
        c = cache.get(key)
        if not c:
            c = {"md5": md5(root / f["path"])}
            if f["ext"] == ".pdf":
                n, sizes = pdf_pages(root / f["path"])
                c.update(pages=n, sizes=[[round(w, 1), round(h, 1)] for w, h in sizes])
            else:
                with Image.open(root / f["path"]) as im:
                    c.update(pages=1, px=list(im.size))
            cache[key] = c
        f.update(c)
    cache = {f"{f['path']}|{f['size']}|{f['mtime']}": {k: f[k] for k in ("md5", "pages", "sizes", "px") if k in f}
             for f in files if "md5" in f}
    save_json(bd / "cache.json", cache)

    # 3. bo trung, gan nhom
    docs, links, seen = {}, [], {}
    viewable = [f for f in files if "md5" in f]

    def pref(f):
        return -sum(1 for p in cfg.get("prefer", []) if re.search(p, f["path"], re.I))

    for f in sorted(viewable, key=lambda f: (pref(f), f["path"].lower())):
        did = f["md5"][:10]
        if did in docs:
            docs[did]["dupes"].append(f["path"])
            continue
        docs[did] = {"id": did, "name": f["name"], "path": f["path"], "kind": "pdf" if f["ext"] == ".pdf" else "img",
                     "pages": f["pages"], "sizes": f.get("sizes"), "px": f.get("px"),
                     "group": classify(f["path"], cfg), "dupes": [], "scanned": False}
    for f in files:
        if "md5" not in f:
            links.append({"path": f["path"], "name": f["name"], "ext": f["ext"].lstrip("."), "size": f["size"],
                          "group": classify(f["path"], cfg)})

    # 4. render
    todo = [(d, p) for d in docs.values() for p in range(1, d["pages"] + 1)
            if not (bd / "pages" / d["id"] / f"p{p:03d}_t.webp").exists()
            or (d["kind"] == "pdf" and max(d["sizes"][p - 1]) / 72 * 150 > 2400 * 1.1)]
    log(f"render: con {len(todo)} trang")
    for d, p in todo:
        if over(a.budget):
            log("HET GIO o buoc render")
            sys.exit(3)
        od = bd / "pages" / d["id"]
        od.mkdir(parents=True, exist_ok=True)
        if d["kind"] == "pdf":
            render_pdf_page(root / d["path"], p, d["sizes"][p - 1], od)
        else:
            with Image.open(root / d["path"]) as im:
                im.thumbnail((6000, 6000))
                save_webp(im, od / "p001.webp", od / "p001_t.webp")
        log(f"  {d['id']} p{p}")

    # 5. trich chu
    for d in docs.values():
        tp = bd / "text" / f"{d['id']}.json"
        if tp.exists():
            t = load_json(tp, {})
            d["scanned"] = t.get("scanned", False)
            continue
        if d["kind"] != "pdf":
            save_json(tp, {"scanned": False, "pages": [[]]}, compact=True)
            continue
        x = subprocess.run(["pdftotext", "-bbox", str(root / d["path"]), "-"], capture_output=True, text=True,
                           errors="ignore").stdout
        pages = parse_bbox_html(x)
        nchar = sum(len(w[4]) for pg in pages for w in pg)
        if nchar >= 40 * d["pages"]:
            save_json(tp, {"scanned": False, "pages": pages}, compact=True)
            continue
        # ban scan -> OCR tung trang, luu tam de chay tiep
        d["scanned"] = True
        od = bd / "text" / d["id"]
        od.mkdir(exist_ok=True)
        from concurrent.futures import ThreadPoolExecutor
        left = [p for p in range(1, d["pages"] + 1) if not (od / f"p{p:03d}.v2.json").exists()]
        with ThreadPoolExecutor(a.jobs) as ex:
            for i in range(0, len(left), a.jobs):
                if over(a.budget):
                    log(f"HET GIO o buoc OCR ({d['name']} con {len(left) - i} trang)")
                    sys.exit(3)
                batch = left[i:i + a.jobs]
                for p, w in zip(batch, ex.map(lambda p: ocr_page(root / d["path"], p, a.tessdata, a.lang), batch)):
                    save_json(od / f"p{p:03d}.v2.json", w, compact=True)
                    log(f"  OCR {d['id']} p{p}")
        pages = [load_json(od / f"p{p:03d}.v2.json", []) for p in range(1, d["pages"] + 1)]
        save_json(tp, {"scanned": True, "pages": pages}, compact=True)

    # 6. bo cuc (don vi: mm)
    gmap = {g["id"]: g for g in cfg["groups"]}
    items, groups_out, spans = [], [], []
    GAP, MAXW, Y = 15, 3600, 0
    PX_MM = 420 / 3000  # anh: coi nhu ban ve A3 ngang neu rong 3000px
    for g in cfg["groups"]:
        gd = [d for d in docs.values() if d["group"] == g["id"]]
        gl = [l for l in links if l["group"] == g["id"]]
        if not gd and not gl:
            continue
        gd.sort(key=lambda d: d["path"].lower())
        i0 = len(items)
        x0, y = 40, Y + 140
        gw = 1200
        for d in gd:
            items.append({"type": "label", "x": x0, "y": y, "text": d["name"], "doc": d["id"],
                          "sub": d["path"] + ("  · OCR" if d["scanned"] else "")})
            y += 50
            x, rowh = x0, 0
            for p in range(1, d["pages"] + 1):
                if d["kind"] == "pdf":
                    w, h = d["sizes"][p - 1]
                    w, h = w * 25.4 / 72, h * 25.4 / 72
                else:
                    w, h = d["px"][0] * PX_MM, d["px"][1] * PX_MM
                    s = min(1, 841 / max(w, h))
                    w, h = w * s, h * s
                if x > x0 and x + w > x0 + MAXW:
                    y += rowh + GAP
                    x, rowh = x0, 0
                items.append({"type": "page", "doc": d["id"], "page": p, "x": round(x, 1), "y": round(y, 1),
                              "w": round(w, 1), "h": round(h, 1),
                              "src": f"{BOARD}/pages/{d['id']}/p{p:03d}.webp",
                              "thumb": f"{BOARD}/pages/{d['id']}/p{p:03d}_t.webp"})
                x += w + GAP
                rowh = max(rowh, h)
                gw = max(gw, x - GAP)
            y += rowh + 60
        if gl:
            items.append({"type": "label", "x": x0, "y": y, "text": f"File gốc khác ({len(gl)})", "sub": "Bấm để mở trên Google Drive"})
            y += 50
            CW, CH, cols = 230, 46, 6
            for i, l in enumerate(sorted(gl, key=lambda l: l["path"].lower())):
                items.append({"type": "link", "x": x0 + (i % cols) * (CW + 12), "y": y + (i // cols) * (CH + 12),
                              "w": CW, "h": CH, "name": l["name"], "path": l["path"], "ext": l["ext"],
                              "size": l["size"]})
            y += ((len(gl) - 1) // cols + 1) * (CH + 12) + 40
            gw = max(gw, cols * (CW + 12))
        groups_out.append({"id": g["id"], "title": g["title"], "color": g.get("color", "#64748b"),
                           "x": 0, "y": Y, "w": round(gw + 80), "h": round(y - Y + 40)})
        spans.append((i0, len(items)))
        Y = y + 260
    # xep nhom thanh cot (masonry) cho de nhin tong the
    ncol = max(1, min(int(cfg.get("columns", 3)), len(groups_out)))
    colx, coly, cx = [], [0] * ncol, 0
    colw = max([g["w"] for g in groups_out] or [0]) + 300
    colx = [i * colw for i in range(ncol)]
    for g, (a, b) in zip(groups_out, spans):
        c = min(range(ncol), key=lambda k: coly[k])
        dx, dy = colx[c] - g["x"], coly[c] - g["y"]
        g["x"] += dx; g["y"] += dy
        for it in items[a:b]:
            it["x"] = round(it["x"] + dx, 1); it["y"] = round(it["y"] + dy, 1)
        coly[c] += g["h"] + 300

    board = {"version": 1, "project": root.name, "generated": time.strftime("%Y-%m-%d %H:%M"),
             "units": "mm", "groups": groups_out, "items": items,
             "docs": {d["id"]: {k: d[k] for k in ("name", "path", "pages", "group", "dupes", "scanned", "kind")}
                      for d in docs.values()}}
    save_json(bd / "board.json", board, compact=True)

    # 7. chi muc tim kiem
    idx = []
    for d in docs.values():
        t = load_json(bd / "text" / f"{d['id']}.json", {"pages": []})
        for i, words in enumerate(t["pages"], 1):
            txt = " ".join(w[4] for w in words)
            if txt.strip():
                idx.append({"doc": d["id"], "page": i, "text": txt})
    save_json(bd / "index.json", {"generated": board["generated"], "pages": idx}, compact=True)
    log(f"XONG: {len(docs)} tai lieu, {sum(d['pages'] for d in docs.values())} trang, {len(links)} link, "
        f"{len(idx)} trang co chu, {time.time() - T0:.0f}s")


if __name__ == "__main__":
    main()
