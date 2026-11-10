# Máy chủ Gemini cho app Tự học tiếng Hoa 52 tuần

Giữ Gemini API key trên Render. App trên Netlify không chứa key.

- `GET /health`: kiểm tra máy chủ
- `POST /api/generate`: chấm phát âm, nhận xét, chấm bài nói
- WebSocket: Gemini Live

## Biến môi trường trên Render (Environment)

| Tên | Bắt buộc | Ví dụ |
|---|---|---|
| GEMINI_API_KEY | có | key lấy từ Google AI Studio |
| ALLOWED_ORIGINS | nên có | https://ten-app.netlify.app |
| EVAL_MODEL | không | gemini-3.8-flash |
| LIVE_MODEL | không | gemini-3.8-live |
| RATE_LIMIT | không | 120 (số lần gọi mỗi 10 phút cho một IP) |

Render: Build Command `npm install`, Start Command `npm start`.
