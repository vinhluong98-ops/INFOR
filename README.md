# Project Board

Bảng xem tài liệu dự án từ Google Drive: trang PDF dàn theo nhóm, ô link mở file gốc (DWG, Excel…), tìm kiếm toàn văn (kể cả bản scan đã OCR), ghi chú dùng chung cho cả nhóm.

## Cách hoạt động
1. `tools/build_board.py` chạy trên máy có thư mục dự án (Drive for desktop):
   ```
   python3 build_board.py "E:\GDRIVE\OS GROUP\16-SAN BAY DA NANG"
   ```
   Tạo `_BOARD/` trong thư mục dự án: `board.json` (bố cục), `index.json` (chữ từng trang), `pages/` (ảnh trang), `text/` (vị trí chữ để tô sáng), `groups.json` (quy tắc chia nhóm — sửa được).
   Cần: Python 3 + Pillow, poppler-utils (pdftoppm, pdftotext, pdfinfo), tesseract + gói tiếng Việt (vie).
2. Drive tự đồng bộ `_BOARD` lên mạng.
3. Mở app → đăng nhập Google → dán link thư mục dự án. Link chia sẻ cho nhóm: `.../?folder=<ID thư mục>`.

## Cấu hình
`config.js` → `clientId` (OAuth Client ID, loại Web application, origin = địa chỉ GitHub Pages).

## Phím tắt
Kéo chuột / Space+kéo: di chuyển · Lăn chuột hoặc Ctrl+lăn: phóng to · Double-click trang: xem trang · Shift+1: xem toàn bộ · Ctrl+F: tìm · Enter/Shift+Enter: kết quả tiếp/trước · N: ghi chú · \ : danh mục · Esc: thoát.

## Thử không cần Google
Chạy web server tĩnh ở thư mục cha, mở `index.html?local=<đường dẫn thư mục dự án>/`.
