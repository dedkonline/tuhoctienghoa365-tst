// Máy chủ trung gian cho app Tự học tiếng Hoa 52 tuần.
// Giữ Gemini API key ở phía máy chủ (biến môi trường trên Render), trình duyệt không bao giờ thấy key.
//   GET  /health        : kiểm tra máy chủ còn sống (app gọi để đánh thức Render)
//   POST /api/generate  : chấm phát âm, nhận xét, chấm bài nói (Gemini generateContent)
//   WebSocket (mọi đường dẫn): Gemini Live, đàm thoại giọng nói trực tiếp
'use strict';
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');

const KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.API_KEY || '';
const PORT = process.env.PORT || 10000;
const EVAL_MODEL = process.env.EVAL_MODEL || 'gemini-3.8-flash';
const LIVE_MODEL = process.env.LIVE_MODEL || 'gemini-3.8-live';
const LIVE_VOICE = process.env.LIVE_VOICE || 'Kore';
const MAX_LIVE_MIN = +(process.env.MAX_LIVE_MINUTES || 15);
const RATE_PER_10MIN = +(process.env.RATE_LIMIT || 120);
// Chỉ cho phép trang của anh gọi tới. Ví dụ: https://ten-app.netlify.app (nhiều trang thì cách nhau dấu phẩy)
const ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean);
const HTTP_BASE = process.env.GEMINI_HTTP_BASE || 'https://generativelanguage.googleapis.com';
const WS_BASE = process.env.GEMINI_WS_URL || 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const DEFAULT_SYSTEM = 'Bạn là gia sư tiếng Phổ thông Trung Quốc (普通话), dạy người Việt bằng tiếng Việt miền Nam tự nhiên. Hỏi từng câu, đợi người học trả lời, sửa phát âm và ngữ pháp. Không độc thoại dài.';

if (!KEY) console.warn('CHƯA CÓ GEMINI_API_KEY trong Environment của Render!');

function originOk(o) {
  if (!ORIGINS.length) return true; // chưa cấu hình thì tạm cho tất cả (nên cấu hình ngay)
  if (!o) return false;
  o = o.replace(/\/$/, '');
  return ORIGINS.some(a => a === o || (a.startsWith('*.') && o.endsWith(a.slice(1))));
}
// Giới hạn số lần gọi theo IP để lỡ ai biết địa chỉ cũng không xài hết hạn mức
const hits = new Map();
function rateOk(ip) {
  const now = Date.now(), w = 10 * 60 * 1000;
  const a = (hits.get(ip) || []).filter(t => now - t < w); a.push(now); hits.set(ip, a);
  return a.length <= RATE_PER_10MIN;
}
setInterval(() => { const now = Date.now(); for (const [k, a] of hits) if (!a.some(t => now - t < 600000)) hits.delete(k) }, 600000).unref();
const ipOf = req => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;

function cors(req, res) {
  const o = req.headers.origin;
  if (o && originOk(o)) { res.setHeader('Access-Control-Allow-Origin', o); res.setHeader('Vary', 'Origin') }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}
function send(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)) }

const server = http.createServer(async (req, res) => {
  cors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end() }
  const path = req.url.split('?')[0];
  if (req.method === 'GET' && (path === '/' || path === '/health')) return send(res, 200, { ok: true, key: !!KEY, evalModel: EVAL_MODEL, liveModel: LIVE_MODEL, version: 2 });
  if (req.method === 'POST' && path === '/api/generate') {
    if (!originOk(req.headers.origin)) return send(res, 403, { error: { message: 'Trang này không được phép dùng máy chủ.' } });
    if (!rateOk(ipOf(req))) return send(res, 429, { error: { message: 'Gọi quá nhiều lần, chờ vài phút rồi thử lại.' } });
    if (!KEY) return send(res, 500, { error: { message: 'Máy chủ chưa có GEMINI_API_KEY.' } });
    let size = 0; const chunks = [];
    try {
      for await (const c of req) { size += c.length; if (size > 20 * 1024 * 1024) return send(res, 413, { error: { message: 'Âm thanh quá dài.' } }); chunks.push(c) }
      const b = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      // Chỉ chuyển tiếp các trường cần thiết, model do máy chủ quyết định
      const body = { contents: b.contents, generationConfig: b.generationConfig || {} };
      if (b.systemInstruction) body.systemInstruction = b.systemInstruction;
      if (!Array.isArray(body.contents)) return send(res, 400, { error: { message: 'Thiếu nội dung.' } });
      const r = await fetch(`${HTTP_BASE}/v1beta/models/${EVAL_MODEL}:generateContent`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': KEY }, body: JSON.stringify(body) });
      const txt = await r.text();
      res.writeHead(r.status, { 'Content-Type': 'application/json; charset=utf-8' }); return res.end(txt);
    } catch (e) { return send(res, 502, { error: { message: 'Lỗi máy chủ trung gian: ' + e.message } }) }
  }
  send(res, 404, { error: { message: 'Không có đường dẫn này.' } });
});

// ===== Gemini Live =====
const wss = new WebSocketServer({ server, maxPayload: 8 * 1024 * 1024 });
function cleanSetup(s) {
  s = s || {};
  const gc = s.generationConfig || {};
  const voice = gc.speechConfig?.voiceConfig?.prebuiltVoiceConfig?.voiceName || LIVE_VOICE;
  const setup = {
    model: 'models/' + LIVE_MODEL,
    generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: String(voice).slice(0, 30) } } } },
    systemInstruction: { parts: [{ text: String(s.systemInstruction?.parts?.map(p => p.text || '').join('\n') || DEFAULT_SYSTEM).slice(0, 20000) }] },
    inputAudioTranscription: {}, outputAudioTranscription: {}
  };
  return { setup };
}
wss.on('connection', (client, req) => {
  if (!originOk(req.headers.origin) || !rateOk(ipOf(req))) { client.close(1008, 'not allowed'); return }
  if (!KEY) { client.close(1011, 'server missing key'); return }
  let upstream = null, ready = false, setupSent = false; const queue = [];
  const timer = setTimeout(() => close(1000, 'Hết thời gian phiên'), MAX_LIVE_MIN * 60000);
  function close(code, reason) {
    clearTimeout(timer);
    try { client.readyState === WebSocket.OPEN && client.close(code, reason) } catch (e) { }
    try { upstream && upstream.readyState <= 1 && upstream.close() } catch (e) { }
  }
  function openUpstream(setupMsg) {
    upstream = new WebSocket(`${WS_BASE}?key=${encodeURIComponent(KEY)}`);
    upstream.on('open', () => { upstream.send(JSON.stringify(setupMsg)); setupSent = true });
    upstream.on('message', data => {
      const t = data.toString('utf8');
      if (!ready && t.includes('setupComplete')) { ready = true; for (const m of queue.splice(0)) upstream.send(m) }
      if (client.readyState === WebSocket.OPEN) client.send(t);
    });
    upstream.on('close', (code, reason) => close(code === 1000 ? 1000 : 1011, String(reason || '').slice(0, 120)));
    upstream.on('error', e => close(1011, 'Gemini: ' + e.message.slice(0, 100)));
  }
  client.on('message', data => {
    const t = data.toString('utf8');
    let m; try { m = JSON.parse(t) } catch (e) { return }
    if (!upstream) {
      if (m.setup) { openUpstream(cleanSetup(m.setup)); return }
      openUpstream(cleanSetup(null)); // app cũ không gửi setup
    }
    if (m.setup) return; // không cho đổi setup giữa phiên
    // Chuyển định dạng âm thanh cũ (mediaChunks) sang định dạng mới
    if (m.realtimeInput?.mediaChunks) { const c = m.realtimeInput.mediaChunks[0]; m = { realtimeInput: { audio: { data: c.data, mimeType: 'audio/pcm;rate=16000' } } } }
    const out = JSON.stringify(m);
    if (ready && upstream.readyState === WebSocket.OPEN) upstream.send(out); else if (queue.length < 400) queue.push(out);
  });
  client.on('close', () => close(1000));
  client.on('error', () => close(1011));
});

server.listen(PORT, () => console.log(`Proxy chạy cổng ${PORT} · eval ${EVAL_MODEL} · live ${LIVE_MODEL} · origins: ${ORIGINS.join(', ') || '(chưa giới hạn)'}`));
