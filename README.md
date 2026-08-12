# Polygon Full Package Builder

Web tool chạy cục bộ để:

- nhận API key và secret key của Codeforces Polygon;
- gọi `problems.list` và chỉ giữ các problem có `accessType = OWNER`;
- build package bằng `problem.buildPackage` với `full=true`;
- theo dõi package qua `problem.packages` đến trạng thái `READY` hoặc `FAILED`;
- giới hạn 1–4 problem build song song và hiển thị lỗi riêng cho từng problem.
- tự bỏ qua revision đã có full package và problem đang có thay đổi chưa commit.

## Yêu cầu

- Node.js 20 trở lên.
- API key/secret được tạo trong **Polygon → Settings → API**.
- Các problem phải không có thay đổi chưa commit thì Polygon mới có thể tạo package.

## Chạy tool

### Cách nhanh nhất trên Windows

Nhấp đúp file **`Chay Polygon Builder.cmd`**. Tool sẽ tự khởi động và mở
`http://127.0.0.1:4173` trong trình duyệt mặc định. Giữ cửa sổ lệnh đang mở;
đóng cửa sổ đó khi muốn tắt tool.

### Chạy bằng terminal

```powershell
npm start
```

Mở [http://127.0.0.1:4173](http://127.0.0.1:4173), nhập API key và secret key, chọn problem rồi nhấn **Build full package**.

Không cần `npm install` vì project chỉ dùng thư viện chuẩn của Node.js.

Đổi cổng nếu cần:

```powershell
$env:PORT=5000
npm start
```

## Bảo mật

- Server mặc định chỉ lắng nghe trên `127.0.0.1`, không mở ra mạng LAN.
- Credential được gửi bằng POST tới tiến trình cục bộ, không nằm trong URL hay log.
- Credential chỉ giữ trong RAM. Phiên chưa build hết hạn sau 15 phút; credential của job bị xóa ngay khi job kết thúc.
- Tool không lưu credential vào file, local storage hoặc cookie.
- File `.env*` được bỏ qua bởi Git để giảm nguy cơ commit nhầm secret.

## Hành vi cần lưu ý

- Nút **Dừng theo dõi** ngừng gửi problem mới và ngừng poll. Các package đã gửi lên Polygon có thể vẫn tiếp tục build; Polygon API không cung cấp thao tác hủy build trong tool này.
- **Verify solutions** yêu cầu Polygon chạy tất cả solution trên tất cả test và có thể làm job lâu hơn đáng kể.
- Full package được tạo trên Polygon. Tool này không tự tải file ZIP xuống máy.
- Một problem lỗi không làm dừng các problem còn lại.
- Revision đã có full package `READY` được đánh dấu **Đã có package**, không bị báo lỗi và không tạo bản trùng.
- Problem có working copy chưa commit được hiển thị nhưng không được chọn; hãy commit trên Polygon rồi kết nối lại.

## Kiểm thử

```powershell
npm test
npm run check
```

Các test dùng Polygon client giả, không gọi API thật và không cần credential.

## API nội bộ

| Method | Endpoint | Mục đích |
|---|---|---|
| `POST` | `/api/sessions` | Xác thực và lấy danh sách problem OWNER |
| `DELETE` | `/api/sessions/:id` | Xóa credential của phiên chưa build |
| `POST` | `/api/sessions/:id/build` | Tạo job build cho danh sách đã chọn |
| `GET` | `/api/jobs/:id` | Lấy tiến độ job |
| `DELETE` | `/api/jobs/:id` | Dừng gửi mới/theo dõi job |
| `GET` | `/api/health` | Health check |

Tài liệu API tham chiếu: [Polygon API Documentation](https://codeforces.github.io/polygon-misc/API).
