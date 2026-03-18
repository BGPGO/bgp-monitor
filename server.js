/**
 * BGP Monitor — Dead Man's Switch + Alertas + Bot Telegram interativo
 *
 * Deploy: Coolify (Hostinger)
 *
 * HTTP Endpoints (recebe do BGPSERVER):
 *   GET /ping/:script         — heartbeat OK
 *   GET /fail/:script?err=... — reportar erro (alerta imediato)
 *   GET /status               — JSON com status
 *
 * Comandos Telegram (manda pro bot):
 *   /status    — saude de todos os scripts
 *   /server    — BGPSERVER ta vivo?
 *   /erros     — ultimos erros
 *   /help      — lista comandos
 */

const http = require('http');
const https = require('https');
const os = require('os');

const VERSION = 'v3';

// ─── Config ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8330277879:AAEP8GA04teWfpFDWDjrR64X1CCmfdsp4L0';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '5018943895';
const GRACE_HOURS = parseFloat(process.env.GRACE_HOURS || '3');
const CHECK_INTERVAL_MIN = parseFloat(process.env.CHECK_INTERVAL_MIN || '30');
const TELEGRAM_POLL_SEC = 5;

// ─── State ──────────────────────────────────────────────────────────────────
const heartbeats = {};
const errorLog = [];       // ultimos 50 erros
let lastUpdateId = 0;      // Telegram polling offset
let monitorStartedAt = new Date();

// ─── Helpers ────────────────────────────────────────────────────────────────
function brDate(d) {
  if (!d) return '-';
  return new Date(d).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

function timeAgo(date) {
  const ms = Date.now() - new Date(date).getTime();
  if (ms < 60000) return `${Math.round(ms / 1000)}s atras`;
  if (ms < 3600000) return `${Math.round(ms / 60000)}min atras`;
  return `${(ms / 3600000).toFixed(1)}h atras`;
}

// ─── Telegram Send ──────────────────────────────────────────────────────────
function sendTelegram(text, chatId) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ chat_id: chatId || TELEGRAM_CHAT_ID, text });
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ─── Telegram Polling ───────────────────────────────────────────────────────
function telegramGetUpdates() {
  return new Promise((resolve, reject) => {
    const path = `/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=1`;
    https.get(`https://api.telegram.org${path}`, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch { resolve({ ok: false, result: [] }); }
      });
    }).on('error', reject);
  });
}

async function pollTelegram() {
  try {
    const data = await telegramGetUpdates();
    if (!data.ok || !data.result || data.result.length === 0) return;

    for (const update of data.result) {
      lastUpdateId = update.update_id;
      const msg = update.message;
      if (!msg || !msg.text) continue;

      const chatId = msg.chat.id;
      const text = msg.text.trim().toLowerCase();
      const userName = msg.from.first_name || 'amigo';

      console.log(`[Bot] ${userName}: ${text}`);

      if (text === '/status' || text === '/saude' || text === '/health') {
        await handleStatus(chatId);
      } else if (text === '/server' || text === '/servidor') {
        await handleServer(chatId);
      } else if (text === '/erros' || text === '/errors' || text === '/log') {
        await handleErrors(chatId);
      } else if (text === '/help' || text === '/start' || text === '/ajuda') {
        await handleHelp(chatId, userName);
      } else {
        await sendTelegram(`Nao entendi. Manda /help pra ver os comandos.`, chatId);
      }
    }
  } catch (e) {
    // silently ignore polling errors
  }
}

// ─── Bot Command Handlers ───────────────────────────────────────────────────
async function handleStatus(chatId) {
  const now = Date.now();
  const graceMs = GRACE_HOURS * 3600000;
  const scripts = Object.entries(heartbeats);

  if (scripts.length === 0) {
    await sendTelegram('Nenhum script registrado ainda.\n\nOs scripts precisam rodar pelo menos 1x para aparecer aqui.', chatId);
    return;
  }

  const lines = ['--- STATUS DOS SCRIPTS ---', ''];

  for (const [name, hb] of scripts) {
    const elapsed = now - hb.lastPing.getTime();
    const isLate = elapsed > graceMs;
    const icon = hb.status === 'ERROR' ? '!!' : isLate ? '!!' : 'OK';

    lines.push(`${icon} ${name}`);
    lines.push(`   Status: ${hb.status}`);
    lines.push(`   Ultimo ping: ${brDate(hb.lastPing)} (${timeAgo(hb.lastPing)})`);

    if (hb.status === 'ERROR' && hb.lastError) {
      lines.push(`   Erro: ${hb.lastError.slice(0, 150)}`);
    }
    if (isLate) {
      lines.push(`   ATRASADO - sem ping ha ${(elapsed / 3600000).toFixed(1)}h (limite: ${GRACE_HOURS}h)`);
    }
    lines.push('');
  }

  lines.push(`Monitor ativo desde: ${brDate(monitorStartedAt)}`);
  await sendTelegram(lines.join('\n'), chatId);
}

async function handleServer(chatId) {
  const now = Date.now();
  const graceMs = GRACE_HOURS * 3600000;
  const scripts = Object.entries(heartbeats);

  if (scripts.length === 0) {
    await sendTelegram('Sem dados. Nenhum script pingou ainda.', chatId);
    return;
  }

  // Servidor esta vivo se ALGUM script pingou dentro da janela
  const lastAnyPing = Math.max(...scripts.map(([, hb]) => hb.lastPing.getTime()));
  const elapsed = now - lastAnyPing;
  const alive = elapsed < graceMs;

  const lines = [];
  if (alive) {
    lines.push('BGPSERVER: ONLINE');
    lines.push('');
    lines.push(`Ultimo sinal: ${timeAgo(new Date(lastAnyPing))}`);
  } else {
    lines.push('BGPSERVER: POSSIVELMENTE OFFLINE');
    lines.push('');
    lines.push(`Ultimo sinal: ${timeAgo(new Date(lastAnyPing))}`);
    lines.push(`Sem contato ha ${(elapsed / 3600000).toFixed(1)}h`);
    lines.push('');
    lines.push('Possiveis causas:');
    lines.push('- Servidor desligado');
    lines.push('- Task Scheduler parado');
    lines.push('- Internet do servidor fora');
  }

  // Resumo rapido dos scripts
  lines.push('');
  lines.push('--- Scripts ---');
  for (const [name, hb] of scripts) {
    const icon = hb.status === 'OK' ? 'OK' : '!!';
    lines.push(`${icon} ${name}: ${timeAgo(hb.lastPing)}`);
  }

  await sendTelegram(lines.join('\n'), chatId);
}

async function handleErrors(chatId) {
  if (errorLog.length === 0) {
    await sendTelegram('Nenhum erro registrado desde o inicio do monitor.', chatId);
    return;
  }

  const lines = ['--- ULTIMOS ERROS ---', ''];
  const recent = errorLog.slice(-5).reverse();

  for (const err of recent) {
    lines.push(`${brDate(err.time)} - ${err.script}`);
    lines.push(`  ${err.error.slice(0, 200)}`);
    lines.push('');
  }

  lines.push(`Total de erros: ${errorLog.length}`);
  await sendTelegram(lines.join('\n'), chatId);
}

async function handleHelp(chatId, name) {
  const msg = [
    `Fala ${name}! Sou o BGP Monitor.`,
    '',
    'Comandos:',
    '/status  - Saude de todos os scripts',
    '/server  - BGPSERVER ta vivo?',
    '/erros   - Ultimos erros',
    '/help    - Essa mensagem',
    '',
    `Grace period: ${GRACE_HOURS}h`,
    `Scripts monitorados: ${Object.keys(heartbeats).length || 'nenhum ainda'}`,
  ].join('\n');
  await sendTelegram(msg, chatId);
}

// ─── Dead Man's Switch Check ────────────────────────────────────────────────
function checkHeartbeats() {
  const now = Date.now();
  const graceMs = GRACE_HOURS * 60 * 60 * 1000;
  const timestamp = brDate(new Date());

  for (const [name, hb] of Object.entries(heartbeats)) {
    const elapsed = now - hb.lastPing.getTime();

    if (elapsed > graceMs && !hb.alertSent) {
      const hoursAgo = (elapsed / 3600000).toFixed(1);
      const msg = [
        `ALERTA - ${name}`,
        ``,
        `Nenhum heartbeat ha ${hoursAgo}h`,
        `Ultimo ping: ${brDate(hb.lastPing)}`,
        ``,
        `Possivel causa:`,
        `- BGPSERVER desligado`,
        `- Task Scheduler parou`,
        `- Script travou sem retornar`,
        ``,
        `Verificar: ${timestamp}`,
        ``,
        `Mande /status para ver tudo`
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
    const wasLate = heartbeats[name]?.alertSent;
    heartbeats[name] = {
      lastPing: new Date(),
      status: 'OK',
      lastError: null,
      alertSent: false
    };
    console.log(`[PING] ${name} OK`);

    // Se estava atrasado e voltou, avisa
    if (wasLate) {
      sendTelegram(`RECUPERADO - ${name}\n\nVoltou a pingar em ${brDate(new Date())}`).catch(() => {});
    }

    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
    return;
  }

  // GET /fail/:scriptName?err=...
  if (parts[0] === 'fail' && parts[1]) {
    const name = decodeURIComponent(parts[1]);
    const errorMsg = url.searchParams.get('err') || 'Erro desconhecido';
    const timestamp = brDate(new Date());

    heartbeats[name] = {
      lastPing: new Date(),
      status: 'ERROR',
      lastError: errorMsg,
      alertSent: false
    };

    // Salva no log de erros
    errorLog.push({ time: new Date(), script: name, error: errorMsg });
    if (errorLog.length > 50) errorLog.shift();

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
    res.end(JSON.stringify({
      monitor_since: monitorStartedAt.toISOString(),
      grace_hours: GRACE_HOURS,
      scripts: status,
      recent_errors: errorLog.slice(-5)
    }, null, 2));
    return;
  }

  // GET /
  if (url.pathname === '/' || url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(`BGP Monitor ${VERSION} running | scripts: ${Object.keys(heartbeats).length}`);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

// ─── Start ──────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`BGP Monitor rodando na porta ${PORT}`);
  console.log(`Grace period: ${GRACE_HOURS}h | Check: ${CHECK_INTERVAL_MIN}min | Poll: ${TELEGRAM_POLL_SEC}s`);
  console.log(`Telegram bot polling ativo`);

  // Cron: checa heartbeats
  setInterval(checkHeartbeats, CHECK_INTERVAL_MIN * 60 * 1000);

  // Telegram polling
  setInterval(pollTelegram, TELEGRAM_POLL_SEC * 1000);

  // Boot message
  sendTelegram([
    'BGP Monitor iniciou',
    '',
    `Grace period: ${GRACE_HOURS}h`,
    `Check interval: ${CHECK_INTERVAL_MIN}min`,
    '',
    'Comandos disponiveis:',
    '/status /server /erros /help'
  ].join('\n')).catch(() => {});
});
