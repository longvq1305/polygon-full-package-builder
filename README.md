# Polygon Full Package Builder

Web tool chạy cục bộ để:

- nhận API key và secret key của Codeforces Polygon;
- gọi `problems.list` và chỉ giữ các problem có `accessType = OWNER`;
- build package bằng `problem.buildPackage` với `full=true`;
- theo dõi package qua `problem.packages` đến trạng thái `READY` hoặc `FAILED`;
- giới hạn 1–4 problem build song song và hiển thị lỗi riêng cho từng problem.
- tự bỏ qua revision đã có full package và problem đang có thay đổi chưa commit.
- tự điều tiết request và chờ/thử lại khi Polygon trả HTTP 429.
- tùy chọn ghi nhớ credential bằng Windows DPAPI để dùng lại sau khi restart và giữa nhiều job.
- danh sách chỉ hiển thị problem **Chưa build** hoặc mới có package **Standard**; problem đã có **Full package** được ẩn.

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

Mở [http://127.0.0.1:4173](http://127.0.0.1:4173), nhập API key và secret key, bật **Ghi nhớ** nếu muốn dùng lại, chọn problem rồi nhấn **Build full package**.

Không cần `npm install` vì project chỉ dùng thư viện chuẩn của Node.js.

Đổi cổng nếu cần:

```powershell
$env:PORT=5000
npm start
```

## Bảo mật

- Server mặc định chỉ lắng nghe trên `127.0.0.1`, không mở ra mạng LAN.
- Credential được gửi bằng POST tới tiến trình cục bộ, không nằm trong URL hay log.
- Khi bật **Ghi nhớ**, credential được Windows DPAPI mã hóa cho tài khoản Windows hiện tại và lưu tại `%APPDATA%\PolygonFullPackageBuilder\credentials.dat`; không lưu plaintext, local storage hoặc cookie.
- Khi không bật **Ghi nhớ**, credential chỉ tồn tại trong RAM. Nút **Quên khóa đã lưu** xóa file DPAPI.
- Một phiên/client được dùng lại giữa nhiều job để giữ chung hàng đợi và cooldown rate limit.
- File `.env*` được bỏ qua bởi Git để giảm nguy cơ commit nhầm secret.

## Hành vi cần lưu ý

- Nút **Dừng theo dõi** ngừng gửi problem mới và ngừng poll. Các package đã gửi lên Polygon có thể vẫn tiếp tục build; Polygon API không cung cấp thao tác hủy build trong tool này.
- **Verify solutions** yêu cầu Polygon chạy tất cả solution trên tất cả test và có thể làm job lâu hơn đáng kể.
- Full package được tạo trên Polygon. Tool này không tự tải file ZIP xuống máy.
- Một problem lỗi không làm dừng các problem còn lại.
- Revision đã có full package `READY` được đánh dấu **Đã có package**, không bị báo lỗi và không tạo bản trùng.
- Problem có working copy chưa commit được hiển thị nhưng không được chọn; hãy commit trên Polygon rồi kết nối lại.
- Request được tuần tự hóa, mặc định cách nhau ít nhất 5 giây. Sau HTTP 429, khoảng cách tăng ít nhất 10 giây và tool tự backoff tối đa 8 lần.
- Loại package được đọc tuần tự trong nền và tạm dừng khi job build chạy để không chiếm hàng đợi request.

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
| `POST` | `/api/sessions/saved` | Mở phiên bằng credential DPAPI đã lưu |
| `DELETE` | `/api/sessions/:id` | Đóng phiên/client đang giữ trong RAM |
| `GET` | `/api/sessions/:id/problems/:problemId/package-status` | Đọc loại package gần nhất của một problem |
| `GET` | `/api/credentials/status` | Kiểm tra có credential đã lưu hay chưa |
| `DELETE` | `/api/credentials` | Xóa credential DPAPI đã lưu |
| `POST` | `/api/sessions/:id/build` | Tạo job build cho danh sách đã chọn |
| `GET` | `/api/jobs/:id` | Lấy tiến độ job |
| `DELETE` | `/api/jobs/:id` | Dừng gửi mới/theo dõi job |
| `GET` | `/api/health` | Health check |

Tài liệu API tham chiếu: [Polygon API Documentation](https://codeforces.github.io/polygon-misc/API).
