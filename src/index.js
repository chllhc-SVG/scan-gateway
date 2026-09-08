/**
 * 独立扫码网关服务（与 MCP 平台完全解耦）。
 *
 * 职责单一：为"数字人共享终端接待"提供扫码身份确认能力。
 *   1. POST /raphael-healing/api/v1/machine-scan/session/create
 *      → 生成一次性登记会话 + 真实可扫的二维码（PNG dataURL）
 *   2. GET  /raphael-healing/api/v1/machine-scan/session/status?sessionId=...
 *      → 数字人客户端轮询扫码/填写进度（WAITING → SCANNED → SUBMITTED）
 *   3. GET  /m/scan/:sessionId
 *      → 二维码指向的 H5 登记页（手机扫码打开，填姓名电话）
 *   4. POST /raphael-healing/api/v1/machine-scan/session/submit?sessionId=...
 *      → H5 登记页提交（兼容内网直连与反向代理两种部署）
 *
 * 与数字人客户端的对接协议保持不变：客户端只关心
 * create / status 两个接口与 MachineScanResponse 结构，
 * 因此换回生产小程序后端时仅需改网关地址，客户端零改动。
 *
 * 独立部署的原因：扫码是"终端能力"，不属于 MCP 工具编排；
 * MCP 平台重启/升级不影响接待中的扫码会话。
 */

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import QRCode from 'qrcode';

const PORT = Number(process.env.SCAN_GATEWAY_PORT || 3101);
const HOST = process.env.SCAN_GATEWAY_HOST || '0.0.0.0';
const SESSION_TTL_MS = Number(process.env.SCAN_SESSION_TTL_MS || 5 * 60 * 1000);
const API_BASE = '/raphael-healing/api/v1/machine-scan';

/** sessionId → session（内存态：临时接待语义，重启即清空） */
const sessions = new Map();

function cleanupExpired() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.createdAt > SESSION_TTL_MS) sessions.delete(id);
  }
}

function json(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

/** 生成真实可扫二维码：内容为 H5 登记页 URL，微信相机/任何扫码器均可识别。 */
async function buildQrDataUrl(text) {
  return QRCode.toDataURL(text, {
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 512,
    color: { dark: '#111111', light: '#FFFFFF' },
  });
}

function fillPageHtml(session) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>顾客信息登记</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, "PingFang SC", sans-serif; background: #f6f2ee; margin: 0; display: grid; place-items: center; min-height: 100vh; }
  .card { width: min(22em, 92vw); background: #fff; border-radius: 16px; padding: 24px; box-shadow: 0 12px 40px rgba(60,30,10,.12); }
  h1 { font-size: 18px; margin: 0 0 4px; color: #3d2f24; }
  p.sub { color: #8a7a6d; font-size: 13px; margin: 0 0 18px; }
  label { display: block; font-size: 13px; color: #5c4f45; margin: 12px 0 6px; }
  label .req { color: #d84315; margin-left: 2px; }
  input { width: 100%; padding: 12px; font-size: 16px; border: 1px solid #e2d8cf; border-radius: 10px; outline: none; }
  input:focus { border-color: #b4662b; }
  input.invalid { border-color: #d84315; background: #fff6f4; }
  .err { display: none; color: #d84315; font-size: 12px; margin-top: 6px; }
  button { width: 100%; margin-top: 20px; padding: 13px; font-size: 16px; border: 0; border-radius: 10px; background: #b4662b; color: #fff; cursor: pointer; }
  button:disabled { opacity: .5; }
  .done { text-align: center; color: #2e7d32; display: none; }
</style>
</head>
<body>
  <div class="card">
    <h1>顾客信息登记</h1>
    <p class="sub">填写后即可在数字人上继续预约 / 查询</p>
    <div id="form">
      <label>姓名<span class="req">*</span></label>
      <input id="name" placeholder="如：王女士" autocomplete="name" />
      <div id="nameErr" class="err">请填写姓名</div>
      <label>手机号<span class="req">*</span></label>
      <input id="phone" inputmode="numeric" maxlength="11" placeholder="11 位手机号" autocomplete="tel" />
      <div id="phoneErr" class="err">请填写正确的 11 位手机号</div>
      <button id="submit">确认登记</button>
    </div>
    <div id="ok" class="done">
      <h1>✓ 登记成功</h1>
      <p class="sub">请回到数字人屏幕继续对话</p>
    </div>
  </div>
  <script>
    var sessionId = ${JSON.stringify(session.sessionId)};
    var nameInput = document.getElementById('name');
    var phoneInput = document.getElementById('phone');
    var nameErr = document.getElementById('nameErr');
    var phoneErr = document.getElementById('phoneErr');

    // 中国大陆手机号：1 开头 + 10 位数字
    function isValidPhone(value) { return /^1\\d{10}$/.test(value); }

    function validateName() {
      var ok = nameInput.value.trim().length > 0;
      nameErr.style.display = ok ? 'none' : 'block';
      nameInput.classList.toggle('invalid', !ok);
      return ok;
    }

    function validatePhone() {
      var digits = phoneInput.value.replace(/\\D/g, '').slice(0, 11);
      if (digits !== phoneInput.value) phoneInput.value = digits;
      var ok = isValidPhone(digits);
      phoneErr.style.display = ok ? 'none' : 'block';
      phoneInput.classList.toggle('invalid', !ok);
      return ok;
    }

    // 输入即校验：出错后一旦修正，红框和提示实时消失
    nameInput.addEventListener('input', function () { if (nameErr.style.display === 'block') validateName(); });
    phoneInput.addEventListener('input', function () { if (phoneErr.style.display === 'block') validatePhone(); });

    document.getElementById('submit').onclick = async function () {
      var okName = validateName();
      var okPhone = validatePhone();
      if (!okName || !okPhone) {
        (okName ? phoneInput : nameInput).focus();
        return;
      }
      var button = document.getElementById('submit');
      button.disabled = true;
      try {
        var resp = await fetch('${API_BASE}/session/submit?sessionId=' + encodeURIComponent(sessionId), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone: phoneInput.value.replace(/\\D/g, ''), name: nameInput.value.trim() })
        });
        if (!resp.ok) {
          var payload = await resp.json().catch(function () { return null; });
          throw new Error((payload && payload.msg) || ('HTTP ' + resp.status));
        }
        document.getElementById('form').style.display = 'none';
        document.getElementById('ok').style.display = 'block';
      } catch (error) {
        alert('提交失败：' + error.message);
        button.disabled = false;
      }
    };
  <\/script>
</body>
</html>`;
}

async function handle(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    });
    res.end();
    return;
  }

  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  // 健康检查
  if (req.method === 'GET' && url.pathname === '/health') {
    cleanupExpired();
    json(res, 200, { ok: true, service: 'scan-gateway', sessions: sessions.size });
    return;
  }

  // 创建扫码会话：生成真实二维码（PNG dataURL）
  if (req.method === 'POST' && url.pathname === `${API_BASE}/session/create`) {
    cleanupExpired();
    const sessionId = `mscan_${randomUUID()}`;
    sessions.set(sessionId, {
      sessionId,
      status: 'WAITING',
      createdAt: Date.now(),
      scannedAt: null,
      userId: null,
      userInfo: null,
    });
    const host = req.headers.host || `localhost:${PORT}`;
    // 二维码内容 = H5 登记页：手机扫码直接打开，无需小程序
    const fillUrl = `http://${host}/m/scan/${sessionId}`;
    const qrcodeBase64 = await buildQrDataUrl(fillUrl);
    json(res, 200, {
      code: '00000',
      data: {
        sessionId,
        status: 'WAITING',
        qrcodeBase64,
        fillUrl,
        expireAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
      },
    });
    return;
  }

  // 状态轮询（数字人客户端 2s 一次）
  if (req.method === 'GET' && url.pathname === `${API_BASE}/session/status`) {
    const sessionId = String(url.searchParams.get('sessionId') || '');
    const session = sessions.get(sessionId);
    if (!session) {
      json(res, 200, { code: '00000', data: { sessionId, status: 'EXPIRED' } });
      return;
    }
    json(res, 200, {
      code: '00000',
      data: {
        sessionId: session.sessionId,
        status: session.status,
        ...(session.userId !== null ? { userId: session.userId } : {}),
        ...(session.userInfo ? { userInfo: session.userInfo } : {}),
      },
    });
    return;
  }

  // H5 登记页（二维码指向这里）
  const matchFill = url.pathname.match(/^\/m\/scan\/([^/]+)$/);
  if (req.method === 'GET' && matchFill) {
    const sessionId = decodeURIComponent(matchFill[1]);
    const session = sessions.get(sessionId);
    if (!session) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<meta charset="utf-8"><body style="font-family:system-ui;display:grid;place-items:center;min-height:100vh;"><p>登记会话不存在或已过期，请在数字人屏幕上重新扫码</p></body>');
      return;
    }
    // 标记已扫码（客户端轮询可见 SCANNED 状态）
    if (session.status === 'WAITING') {
      session.status = 'SCANNED';
      session.scannedAt = Date.now();
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fillPageHtml(session));
    return;
  }

  // 登记提交
  if (req.method === 'POST' && url.pathname === `${API_BASE}/session/submit`) {
    const sessionId = String(url.searchParams.get('sessionId') || '');
    const session = sessions.get(sessionId);
    if (!session) {
      json(res, 404, { code: 'A0404', msg: '会话不存在或已过期' });
      return;
    }
    let body;
    try {
      body = await readBody(req);
    } catch {
      json(res, 400, { code: 'A0400', msg: '请求体不是合法 JSON' });
      return;
    }
    const phone = String(body.phone ?? '').replace(/\D/g, '');
    const name = String(body.name ?? '').trim();
    // 与 H5 表单同规则的双保险：姓名必填，手机号必须是中国大陆 11 位（1 开头）
    if (!name) {
      json(res, 400, { code: 'A0400', msg: '请填写姓名' });
      return;
    }
    if (!/^1\d{10}$/.test(phone)) {
      json(res, 400, { code: 'A0400', msg: '请填写正确的 11 位手机号' });
      return;
    }
    session.status = 'SUBMITTED';
    session.userId = phone;
    session.userInfo = { id: phone, phone, nickname: name || undefined };
    json(res, 200, { code: '00000', msg: 'ok', data: { sessionId, status: 'SUBMITTED' } });
    return;
  }

  json(res, 404, { ok: false, error: 'Not Found' });
}

const server = createServer((req, res) => {
  handle(req, res).catch((error) => {
    json(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[scan-gateway] listening on http://${HOST}:${PORT}`);
  console.log(`[scan-gateway] create:  POST http://<host>:${PORT}${API_BASE}/session/create`);
  console.log(`[scan-gateway] status:  GET  http://<host>:${PORT}${API_BASE}/session/status?sessionId=...`);
});
