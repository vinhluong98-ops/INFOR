#!/usr/bin/env python3
"""Dựng _BOARD/wbs.json (WBS Dictionary) cho khu Gate 10 từ báo giá NEM + SPEC + DD.
Chạy: python3 build_wbs.py <file_bao_gia.xlsx> <out_wbs.json>
Các liên kết SPEC/bản vẽ là GỢI Ý (conf) – người dùng duyệt trên app."""
import sys, json, openpyxl

MAT, LOOSE, DD = "0b13f55906", "d3d2502048", "d4407d2f69"
BOQ_FILE = "02-INCOMING/01-TENDER/Sân bay ĐN_Boarding Lounge & Toilet (Báo giá Ngân sách dự án)_Rev.00_05.11.2026.xlsx"
DWG = "02-INCOMING/01-TENDER/261109_RTS_1F1_BOARDING LOUNGE 10-TKKT_DD/TKKT_DD/DWGs/CAD/RTS-1F1.P5-%s.dwg"

# ---- mục lục SPEC (đọc từ bảng TABLE OF CONTENT, tất cả đánh dấu G.10) ----
S = {  # code: (doc, page, mô tả, vị trí, mã sản phẩm, nhà cung cấp)
 "ST1":(MAT,8,"Đá granite tự nhiên, màu sáng","Sàn nói chung","Granite amba white","Nhà thầu"),
 "ST2":(MAT,9,"Đá granite tự nhiên, màu sáng","Sàn nói chung","Arabescatus quartzite","Nhà thầu"),
 "ST3":(MAT,10,"Đá granite tự nhiên, xám nâu đậm","Sàn nói chung","Granite nâu ngọc trai","Nhà thầu"),
 "ST4":(MAT,11,"Đá veneer uốn dẻo","Tường","Marble MA-CY01 (t.b.c khi có mẫu)","IHC-Golhem, Inmat hoặc tương đương"),
 "ST4a":(MAT,12,"Đá travertine cắt CNC","Tường lượn sóng","Travertine Beige","Nhà thầu"),
 "CP1":(MAT,13,"Thảm hoa văn dệt tay / sàn vinyl","Sàn nhấn","Custom design","Gofloor hoặc tương đương"),
 "VN1":(MAT,14,"Sàn vinyl nâu nhạt","Sàn khu trẻ em","Gray rock FL04-0807","Phat Dat Group hoặc tương đương"),
 "VN2":(MAT,15,"Sàn vinyl nâu đậm","Sàn khu trẻ em","Gray rock FL04-0808","Phat Dat Group hoặc tương đương"),
 "ALP1":(MAT,16,"Trần kim loại","Trần","Do tư vấn CPG (khớp trần hiện hữu)","Tư vấn CPG"),
 "AL1":(MAT,17,"Tấm nhôm vân gỗ","Lam nhôm trang trí","Akzonobel – màu theo yêu cầu","Nhà thầu"),
 "MT1":(MAT,18,"Inox màu đồng","Chi tiết trang trí, đồ nội thất","DKP-003H-AFP","DKP hoặc tương đương"),
 "MT2":(MAT,19,"Inox xước","Tường vị trí cây nước","Hairline AFP","DKP hoặc tương đương"),
 "LQ1":(MAT,20,"Sơn mài họa tiết trên gỗ","Cột tròn","Custom design","DP Céline hoặc tương đương"),
 "WP1":(MAT,21,"Giấy dán tường họa tiết nhiều màu","Tường khu vui chơi trẻ em","Custom design","DP Céline hoặc tương đương"),
 "LA1":(MAT,22,"Laminate màu trắng","Tường khu vui chơi trẻ em","t.b.c khi có mẫu","Wilson Art, Formica hoặc tương đương"),
 "LA2":(MAT,23,"Laminate vân gỗ, màu sáng","Đồ nội thất","A7820 Degiant Oak","Wilson Art, Formica hoặc tương đương"),
 "LA3":(MAT,24,"Laminate vân vải","Vách chỗ ghế thư giãn, nội thất khu trẻ em","—","—"),
 "WD1":(MAT,25,"Thanh gỗ định hình","Tường","Màu theo yêu cầu","Nhà thầu"),
 "WD2":(MAT,26,"Gỗ tự nhiên","Đồ nội thất","—","—"),
 "SE1":(LOOSE,8,"Băng ghế chờ 7 chỗ","Khu chờ","Custom made","Sigviet, TND hoặc tương đương"),
 "SE2":(LOOSE,9,"Băng ghế chờ 3 chỗ","Khu chờ","Custom made","Sigviet, TND hoặc tương đương"),
 "RX1":(LOOSE,10,"Ghế thư giãn","Khu chờ","Eli-fly chaise lounge","Nhà thầu"),
 "MS1":(LOOSE,11,"Ghế massage","Khu chờ","—","Chủ đầu tư cấp"),
 "CH1":(LOOSE,12,"Ghế","Khu chờ","Custom made","Nhà thầu"),
 "CH2":(LOOSE,13,"Ghế","Khu trẻ em","Custom made","Nhà thầu"),
 "CH2a":(LOOSE,14,"Ghế","Khu trẻ em","Custom made","Nhà thầu"),
 "AC1":(LOOSE,15,"Ghế tay vịn","Khu chờ","Custom made","Nhà thầu"),
 "TB1":(LOOSE,16,"Bàn","Khu chờ","Custom made","Nhà thầu"),
 "TB2":(LOOSE,17,"Bàn","Khu chờ","Custom made","Nhà thầu"),
 "TB3":(LOOSE,18,"Bàn","Khu trẻ em","Custom made","Nhà thầu"),
 "CT1":(LOOSE,19,"Bàn cà phê","Khu chờ","Custom made","Nhà thầu"),
 "CT2":(LOOSE,20,"Bàn cà phê","Khu chờ","Custom made","Nhà thầu"),
 "STL1":(LOOSE,21,"Đôn / ghế bar","Khu chờ","Cluedo Counter Stool","Nhà thầu"),
 "BB1":(LOOSE,22,"Ghế lười","Khu trẻ em","Custom made","Nhà thầu"),
 "SC1":(LOOSE,23,"Tủ giày","Khu trẻ em","Custom made","Nhà thầu"),
 "PP1":(LOOSE,24,"Chậu cây","Khu chờ","Nhà thầu","Nhà thầu"),
 "P1":(LOOSE,25,"Vách ngắn","Khu chờ","Custom made","Nhà thầu"),
 "BE1":(LOOSE,26,"Băng ghế kết hợp bàn cố định","Khu chờ","Custom made","Nhà thầu"),
 "BE2":(LOOSE,27,"Băng ghế uốn cong cố định","Khu chờ","Custom made","Nhà thầu"),
 "BE3":(LOOSE,28,"Băng ghế","Khu chờ","Custom made","Nhà thầu"),
 "BE4":(LOOSE,29,"Băng ghế tròn","Khu trẻ em","Custom made","Nhà thầu"),
 "BE5":(LOOSE,30,"Băng ghế âm tường","Khu trẻ em","Custom made","Nhà thầu"),
 "DE1":(LOOSE,31,"Quầy check-in ra tàu bay","Cửa ra tàu bay","Custom made","Nhà thầu"),
 "WT1":(LOOSE,32,"Cây nước miễn phí","Khu chờ","LZOTL8WSLK","Chủ đầu tư / nhà thầu"),
}
# ---- bản vẽ DD (PDF 1F1.5 - DD 1st Submission, 15 trang) ----
D = {
 "302":(6,"Mặt bằng kích thước, cửa, vách"), "303":(7,"Mặt bằng tường hoàn thiện"),
 "304":(8,"Mặt bằng sàn hoàn thiện"), "305":(9,"Mặt bằng bố trí đồ nội thất"),
 "307":(10,"Mặt bằng hoàn thiện trần"), "308a":(11,"Mặt bằng đèn trần"),
 "308b":(12,"Đèn gián tiếp & trang trí"), "310":(13,"Ổ cắm & nguồn chờ"),
 "401":(15,"Mặt cắt 1-1"), "102":(5,"Mặt bằng định vị"), "004":(3,"Ghi chú chung"),
}
CAT_DRAW = {  # hạng mục theo ma trận -> bản vẽ DD cần xem
 "Hoàn thiện sàn":["304","102"], "Hoàn thiện tường":["303","401"], "Hoàn thiện trần":["307","308a"],
 "Nội thất liền tường":["305","303","401"], "Đồ rời & đèn trang trí":["305","308a","308b"],
 "Cửa, vách, lan can kính":["302"],
}
MATRIX = {  # ai làm theo ma trận phạm vi (ảnh 18/11/2026)
 "LOUNGE":{"Hoàn thiện sàn":"Central","Hoàn thiện trần":"Central","Hoàn thiện tường":"NEM","Nội thất liền tường":"NEM","Đồ rời & đèn trang trí":"NEM","Cửa, vách, lan can kính":"Central"},
 "WC":{"Hoàn thiện sàn":"Central","Hoàn thiện trần":"Central","Hoàn thiện tường":"Central","Cửa, vách, lan can kính":"Central","Nội thất liền tường":"","Đồ rời & đèn trang trí":""},
}
# ---- gán hạng mục (ma trận) + mã SPEC gợi ý + cảnh báo cho từng dòng BOQ ----
# stt: (cat, [(code, conf)], [cảnh báo])
SF, TU, TR, NT, DR, CV = "Hoàn thiện sàn","Hoàn thiện tường","Hoàn thiện trần","Nội thất liền tường","Đồ rời & đèn trang trí","Cửa, vách, lan can kính"
M = {
 1:(SF,[("ST1","cao"),("ST2","cao"),("ST3","cao")],["BOQ ghi gạch Ceramic mix 3 loại; bản vẽ sàn (DD-304) ghi 'Tile 1200x1200' còn SPEC ST1–ST3 ghi đá granite tự nhiên → cần chốt vật liệu."]),
 2:(SF,[],["BOQ có sàn đá terrazzo (18,72 m²) nhưng SPEC và bản vẽ DD không có mã terrazzo → cần bổ sung hoặc xác nhận với thiết kế."]),
 3:(SF,[("VN1","cao"),("VN2","cao")],[]),
 4:(TU,[("LA1","tham khảo"),("LA2","tham khảo")],["BOQ 'Tường laminate 8' chưa nói rõ mã laminate; SPEC có LA1 (trắng, tường khu trẻ em), LA2 (vân gỗ, nội thất) → duyệt mã đúng."]),
 5:(TU,[("ST4a","tham khảo"),("ST4","tham khảo")],["BOQ: sơn hiệu ứng giả đá + vách thạch cao cong; SPEC/bản vẽ: đá travertine cắt CNC (ST4a), đá veneer (ST4) → khác vật liệu."]),
 6:(TU,[("LQ1","tham khảo")],["BOQ: cột D1400 laminate vân đá + nhôm in; SPEC LQ1: sơn mài họa tiết trên gỗ cho cột tròn → khác vật liệu."]),
 7:(TU,[("WD1","tham khảo"),("WD2","tham khảo")],[]),
 8:(NT,[("WD1","tham khảo"),("P1","tham khảo")],[]),
 9:(NT,[("WP1","cao"),("LA1","cao"),("BE5","tham khảo")],[]),
 10:(NT,[("BE3","tham khảo"),("BE2","tham khảo")],[]),
 11:(NT,[("BE3","tham khảo"),("BE2","tham khảo")],[]),
 12:(NT,[],["Không thấy mã SPEC cho 'Tủ dịch vụ / phòng photobooth'."]),
 13:(TR,[("ALP1","cao"),("AL1","tham khảo")],["SPEC ALP1 ghi trần kim loại do tư vấn CPG cấp (khớp trần hiện hữu), trong khi BOQ có trần nhôm do NEM làm → xác nhận phạm vi."]),
 14:(NT,[("WD1","tham khảo")],[]),
 15:(NT,[("DE1","cao")],[]),
 16:(DR,[("SE2","cao")],["BOQ ghi ghế FCA-5043 (mẫu có sẵn); SPEC SE2 là băng ghế 3 chỗ custom made → thống nhất mẫu."]),
 17:(DR,[("SE1","tham khảo")],["BOQ: băng ghế 4 chỗ ×22; SPEC chỉ có băng 7 chỗ (SE1) và 3 chỗ (SE2), không có loại 4 chỗ."]),
 18:(DR,[("SC1","tham khảo")],["Không thấy mã SPEC 'Tủ thấp' – mã gần nhất là tủ giày SC1."]),
 19:(DR,[("SC1","tham khảo")],["Không thấy mã SPEC 'Tủ thấp'."]),
 20:(DR,[("SC1","tham khảo")],["Không thấy mã SPEC 'Tủ thấp'."]),
 21:(DR,[("BE3","tham khảo")],["BOQ: ghế bench đá terrazzo đúc; SPEC không có mã đá terrazzo."]),
 22:(DR,[("CT1","tham khảo"),("CT2","tham khảo")],[]),
 23:(DR,[("TB1","tham khảo"),("TB2","tham khảo")],[]),
 24:(DR,[("STL1","cao")],[]),
 25:(DR,[("CT1","tham khảo"),("CT2","tham khảo")],[]),
 26:(DR,[("TB1","tham khảo"),("TB2","tham khảo")],[]),
 27:(DR,[("CH1","cao")],[]),
 28:(DR,[("TB1","tham khảo"),("TB2","tham khảo")],[]),
 29:(DR,[("AC1","cao")],[]),
 30:(DR,[("CT1","tham khảo"),("CT2","tham khảo")],[]),
 31:(DR,[("TB3","cao"),("CH2","cao"),("CH2a","cao"),("BB1","cao")],[]),
 32:(DR,[("MS1","cao")],["BOQ ghi 'Không bao gồm' – SPEC MS1: chủ đầu tư cấp (khớp)."]),
 33:(DR,[],["Không thấy mã SPEC cho túi ngủ (BOQ ghi 'Không bao gồm')."]),
 34:(SF,[],["Chưa có SPEC toilet trong bộ hồ sơ (file SPEC chỉ có trang bìa 'Sanitarywares')."]),
 35:(TU,[],["Chưa có SPEC/bản vẽ chi tiết toilet."]),
 36:(TU,[],["Chưa có SPEC/bản vẽ chi tiết toilet."]),
 37:(TU,[],["Chưa có SPEC/bản vẽ chi tiết toilet."]),
 38:(NT,[],["Chưa có SPEC/bản vẽ chi tiết toilet."]),
 39:(CV,[],["Chưa có SPEC/bản vẽ chi tiết toilet."]),
 40:(CV,[],["Chưa có SPEC/bản vẽ chi tiết toilet."]),
 41:(NT,[("WD1","tham khảo")],["Chưa có bản vẽ chi tiết toilet."]),
 42:(TR,[],["Chưa có SPEC/bản vẽ chi tiết toilet."]),
 43:(TU,[],["Chưa có SPEC/bản vẽ chi tiết toilet."]),
 44:(NT,[],["Chưa có SPEC/bản vẽ chi tiết toilet."]),
 45:(NT,[],["Chưa có SPEC/bản vẽ chi tiết toilet."]),
 46:(NT,[],[]), 47:(NT,[],[]),
 48:(CV,[],["Chưa có SPEC/bản vẽ chi tiết toilet."]),
 49:(CV,[],[]), 50:(CV,[],[]),
}

def read_boq(path):
    ws = openpyxl.load_workbook(path, data_only=True, read_only=True).worksheets[0]
    pk, out = None, {"LOUNGE": [], "WC": []}
    sub = ""
    for r in ws.iter_rows(values_only=True):
        stt, name, _, desc, unit, qty = (list(r) + [None]*6)[:6]
        if isinstance(name, str) and name.strip().upper().startswith("BOARDING GATE LOUNGE"): pk = "LOUNGE"; area = qty; continue
        if isinstance(name, str) and name.strip().upper().startswith("TOILET GATE"): pk = "WC"; continue
        if pk is None: continue
        if stt is None and name and unit is None: sub = name.strip(); continue
        if isinstance(stt, (int, float)) and name:
            out[pk].append(dict(stt=int(stt), name=" ".join(str(name).split()), desc=(desc or "").strip(), unit=unit or "", qty=round(qty,2) if isinstance(qty,(int,float)) else None, boq_group=sub))
    return out

def main(xlsx, outp):
    boq = read_boq(xlsx)
    pk_meta = {"LOUNGE": ("Boarding Gate Lounge Gate 10 (1F1.5)", 765, "Báo giá ghi 'BOARDING GATE LOUNGE 5' (= lounge Gate 10: tiêu đề bản vẽ DD ghi 1F1.5_BOARDING LOUNGE GATE 10 / 1F1.P5_BOARDING GATE LOUNGE 5)"),
               "WC": ("Toilet Gate 10 (RR10)", 105, "Ma trận phạm vi: WC Gate 10 do Central làm kết cấu, xây, cửa, sàn, trần, tường; nội thất để trống")}
    zone = {"id": "G10", "title": "Gate 10 – 1F1.5", "note": "Khu mẫu WBS. SPEC 'Boarding Lounge Gate 4→10' hiện chỉ đánh dấu áp dụng cho G.10.", "packages": []}
    used = set()
    for key in ("LOUNGE", "WC"):
        title, area, note = pk_meta[key]
        pkg = {"id": "G10-" + key, "title": title, "area_m2": area, "note": note, "items": []}
        for b in boq[key]:
            cat, specs, warns = M[b["stt"]]
            who = MATRIX[key].get(cat, "")
            if who == "Central": warns = ["Ma trận phạm vi giao '%s' khu này cho Central, nhưng BOQ của NEM có dòng này → xác nhận ai làm." % cat] + list(warns)
            elif who == "" and key == "WC": warns = ["Ma trận chưa ghi nhà thầu cho '%s' của WC Gate 10." % cat] + list(warns)
            sp = []
            for code, conf in specs:
                doc, page, d, loc, prod, sup = S[code]
                sp.append(dict(code="1F1." + code, doc=doc, page=page, desc=d, loc=loc, product=prod, supplier=sup, conf=conf)); used.add(code)
            dr = []
            if key == "LOUNGE":
                for k in CAT_DRAW.get(cat, []):
                    pg, t = D[k]; dr.append(dict(label="RTS-1F1.P5-" + k + " " + t, doc=DD, page=pg))
            files = []
            if key == "LOUNGE":
                for k in CAT_DRAW.get(cat, [])[:1]:
                    if k in ("302","303","304","305","307","308a","308b","310"): files.append(dict(label="DWG " + k, path=DWG % k))
            pkg["items"].append(dict(id="G10-%s-%02d" % (key[0], b["stt"]), stt=b["stt"], cat=cat, name=b["name"], desc=b["desc"], unit=b["unit"], qty=b["qty"],
                                      boq_group=b["boq_group"], matrix=who or "chưa ghi", owner_boq="NEM", specs=sp, drawings=dr, files=files, warnings=warns))
        zone["packages"].append(pkg)
    # mã SPEC của G.10 chưa dòng BOQ nào dùng -> để kiểm tra "sót"
    zone["spec_unlinked"] = [dict(code="1F1." + c, doc=S[c][0], page=S[c][1], desc=S[c][2], loc=S[c][3]) for c in S if c not in used]
    out = dict(version=1, boq_file=BOQ_FILE, source="Gợi ý tự động – cần duyệt", zones=[zone])
    json.dump(out, open(outp, "w"), ensure_ascii=False, indent=1)
    n = sum(len(p["items"]) for p in zone["packages"])
    print("items", n, "| spec chưa gắn BOQ:", len(zone["spec_unlinked"]), [u["code"] for u in zone["spec_unlinked"]])

if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
