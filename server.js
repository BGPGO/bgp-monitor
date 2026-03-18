/**
 * BGP Monitor — Dead Man's Switch + Alertas Telegram
 *
 * Deploy: Coolify (Hostinger)
 *
 * Endpoints:
 *   GET /ping/:script         — BGPSERVER manda quando script roda OK
 *   GET /fail/:script?err=... — BGPSERVER manda quando script falha (alerta imediato)
 *   GET /status               — Mostra status de todos os scripts
 *
 * Lógica:
 *   - Cada script TEM que pingar pelo menos a cada GRACE_HOURS
 *   - Se não pingar → Telegram "SERVIDOR OFFLINE / SCRIPT NÃO RODOU"
 *   - Se /fail → Telegram imediato com o erro
 */

const http = require('http');
const https = require('https');

// ─── Config ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8330277879:AAEP8GA04teWfpFDWDjrR64X1CCmfdsp4L0';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '5018943895';
const GRACE_HOURS = parseFloat(process.env.GRACE_HOURS || '3');
const CHECK_INTERVAL_MIN = parseFloat(process.env.CHECK_INTERVAL_MIN || '30');

// ─── State ──────────────────────────────────────────────────────────────────
const heartbeats = {};
// { "BI marketing": { lastPing: Date, status: "OK", lastError: null, alertSent: false } }

// ─── Telegram ───────────────────────────────────────────────────────────────
function sendTelegram(text) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text });
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        console.log(`[Telegram] ${res.statusCode}: ${body.slice(0, 100)}`);
        resolve(body);
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ─── Dead Man's Switch Check ────────────────────────────────────────────────
function checkHeartbeats() {
  const now = Date.now();
  const graceMs = GRACE_HOURS * 60 * 60 * 1000;
  const timestamp = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

  for (const [name, hb] of Object.entries(heartbeats)) {
    const elapsed = now - hb.lastPing.getTime();

    if (elapsed > graceMs && !hb.alertSent) {
      // Script não pingou dentro da janela de graça
      const hoursAgo = (elapsed / 3600000).toFixed(1);
      const lastPingStr = hb.lastPing.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
      const msg = [
        `ALERTA - ${name}`,
        ``,
        `Nenhum heartbeat ha ${hoursAgo}h`,
        `Ultimo ping: ${lastPingStr}`,
        ``,
        `Possivel causa:`,
        `- BGPSERVER desligado`,
        `- Task Scheduler parou`,
        `- Script travou sem retornar`,
        ``,
        `Verificar: ${timestamp}`
      ].join('\n');

      console.log(`[ALERTA] ${name} sem ping ha ${hoursAgo}h`);
      sendTelegram(msg).catch(e => console.error('[Telegram error]', e.message));
      hb.alertSent = true;
    }
  }
}

// ─── HTTP Server ────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const parts = url.pathname.split('/').filter(Boolean);

  // GET /ping/:scriptName
  if (parts[0] === 'ping' && parts[1]) {
    const name = decodeURIComponent(parts[1]);
    heartbeats[name] = {
      lastPing: new Date(),
      status: 'OK',
      lastError: null,
      alertSent: false  // reseta alerta quando recebe ping
    };
    console.log(`[PING] ${name} OK`);
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
    return;
  }

  // GET /fail/:scriptName?err=...
  if (parts[0] === 'fail' && parts[1]) {
    const name = decodeURIComponent(parts[1]);
    const errorMsg = url.searchParams.get('err') || 'Erro desconhecido';
    const timestamp = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

    heartbeats[name] = {
      lastPing: new Date(),
      status: 'ERROR',
      lastError: errorMsg,
      alertSent: false
    };

    const msg = [
      `ERRO - ${name}`,
      ``,
      `${timestamp}`,
      ``,
      `${errorMsg.slice(0, 800)}`
    ].join('\n');

    console.log(`[FAIL] ${name}: ${errorMsg.slice(0, 100)}`);
    sendTelegram(msg).catch(e => console.error('[Telegram error]', e.message));

    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('FAIL registered');
    return;
  }

  // GET /status
  if (parts[0] === 'status') {
    const now = Date.now();
    const status = Object.entries(heartbeats).map(([name, hb]) => ({
      script: name,
      status: hb.status,
      lastPing: hb.lastPing.toISOString(),
      minutesAgo: Math.round((now - hb.lastPing.getTime()) / 60000),
      alertSent: hb.alertSent,
      lastError: hb.lastError
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ grace_hours: GRACE_HOURS, scripts: status }, null, 2));
    return;
  }

  // GET / — health check
  if (url.pathname === '/' || url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('BGP Monitor running');
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

// ─── Start ──────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`BGP Monitor rodando na porta ${PORT}`);
  console.log(`Grace period: ${GRACE_HOURS}h | Check interval: ${CHECK_INTERVAL_MIN}min`);
  console.log(`Telegram: chat ${TELEGRAM_CHAT_ID}`);
  console.log('');
  console.log('Endpoints:');
  console.log(`  GET /ping/<script>        — heartbeat OK`);
  console.log(`  GET /fail/<script>?err=.. — reportar erro`);
  console.log(`  GET /status               — ver status`);

  // Cron: checa heartbeats
  setInterval(checkHeartbeats, CHECK_INTERVAL_MIN * 60 * 1000);

  // Manda msg de boot
  sendTelegram(`BGP Monitor iniciou\n\nGrace period: ${GRACE_HOURS}h\nCheck interval: ${CHECK_INTERVAL_MIN}min`).catch(() => {});
});
