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

const VERSION = 'v8';
const { Client: PgClient } = require('pg');

// ─── Config ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8330277879:AAEP8GA04teWfpFDWDjrR64X1CCmfdsp4L0';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '5018943895';
const GRACE_HOURS = parseFloat(process.env.GRACE_HOURS || '3');
const CHECK_INTERVAL_MIN = parseFloat(process.env.CHECK_INTERVAL_MIN || '30');
const TELEGRAM_POLL_SEC = 5;
const MORNING_HOUR = 8; // 8h Brasilia
const GITHUB_ORG = 'BGPGO';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

// Colaboradores monitorados
const TEAM = {
  'ae1f50da-000e-4db6-b4f1-5027a782321e': { name: 'Caio', github: ['caioBertuzzi'] },
  'aff0dba8-4ad1-4dcd-92f0-d1107da6e3a2': { name: 'Oliver', github: ['Aimocorp', 'oliver'] },
  '5e62ef84-e6a5-4b0f-ad7b-f90ee6f9668b': { name: 'Edu', github: ['Eduardo Lasacoski', 'edulasacoski'] },
};

const PG_CONFIG = {
  host: 'aws-1-sa-east-1.pooler.supabase.com',
  port: 6543,
  user: 'postgres.pbtheffdoebfryttkyge',
  password: 'fiffUd-1turpe-nikhyg',
  database: 'postgres',
  ssl: { rejectUnauthorized: false }
};

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
      } else if (text === '/briefing' || text === '/equipe' || text === '/morning') {
        await handleBriefing(chatId);
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
    '/status   - Saude de todos os scripts',
    '/server   - BGPSERVER ta vivo?',
    '/briefing - Resumo: ontem (GitHub) + hoje (demandas)',
    '/erros    - Ultimos erros',
    '/help     - Essa mensagem',
    '',
    `Grace period: ${GRACE_HOURS}h`,
    `Scripts monitorados: ${Object.keys(heartbeats).length || 'nenhum ainda'}`,
  ].join('\n');
  await sendTelegram(msg, chatId);
}

// ─── GitHub: commits de ontem ────────────────────────────────────────────────
function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const opts = new URL(url);
    const req = https.get({
      hostname: opts.hostname, path: opts.pathname + opts.search,
      headers: { 'User-Agent': 'BGP-Monitor', Accept: 'application/vnd.github+json', ...headers }
    }, res => {
      let body = ''; res.on('data', c => body += c);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve([]); } });
    });
    req.on('error', reject);
  });
}

async function getYesterdayCommits() {
  const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
  const since = yesterday.toISOString().slice(0, 10) + 'T00:00:00Z';
  const until = new Date().toISOString().slice(0, 10) + 'T00:00:00Z';
  const authHeader = GITHUB_TOKEN ? { Authorization: `Bearer ${GITHUB_TOKEN}` } : {};

  // Get all repos
  let repos = [];
  try {
    repos = await httpsGet(`https://api.github.com/orgs/${GITHUB_ORG}/repos?per_page=50`, authHeader);
    if (!Array.isArray(repos)) repos = [];
  } catch { repos = []; }

  // All github aliases (lowercase)
  const allAliases = {};
  for (const [id, info] of Object.entries(TEAM)) {
    for (const alias of info.github) allAliases[alias.toLowerCase()] = id;
  }

  // Collect commits per person
  const commitsByPerson = {}; // id -> [{repo, msg, time}]
  for (const id of Object.keys(TEAM)) commitsByPerson[id] = [];

  for (const repo of repos) {
    try {
      const commits = await httpsGet(
        `https://api.github.com/repos/${repo.full_name}/commits?since=${since}&until=${until}&per_page=100`,
        authHeader
      );
      if (!Array.isArray(commits)) continue;
      for (const c of commits) {
        const authorName = (c.commit?.author?.name || '').toLowerCase();
        const authorLogin = (c.author?.login || '').toLowerCase();
        const personId = allAliases[authorName] || allAliases[authorLogin];
        if (personId) {
          commitsByPerson[personId].push({
            repo: repo.name,
            msg: (c.commit?.message || '').split('\n')[0].slice(0, 80),
            time: c.commit?.author?.date
          });
        }
      }
    } catch { continue; }
  }

  return commitsByPerson;
}

// ─── Claude Haiku: resumo com IA ────────────────────────────────────────────
function callClaude(prompt) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }]
    });
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(data)
      }
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          resolve(j.content?.[0]?.text || 'Sem resumo');
        } catch { resolve('Erro ao parsear resposta IA'); }
      });
    });
    req.on('error', () => resolve('IA indisponivel'));
    req.setTimeout(15000, () => { req.destroy(); resolve('IA timeout'); });
    req.write(data);
    req.end();
  });
}

async function summarizeCommits(repoName, commitMsgs) {
  if (commitMsgs.length === 0) return null;
  const prompt = `Voce e um assistente que resume atividades de desenvolvimento para gestores nao-tecnicos.

Projeto: ${repoName}
Commits de ontem:
${commitMsgs.map(m => `- ${m}`).join('\n')}

Resuma em 1-2 frases curtas e objetivas em portugues o que foi feito nesse projeto. Foque no resultado para o negocio, nao em termos tecnicos. Seja direto, sem introducao.`;

  return callClaude(prompt);
}

// ─── Demands: tarefas do dia (agrupadas por projeto) ────────────────────────
async function getTodayDemands() {
  const pg = new PgClient(PG_CONFIG);
  // Returns: { personId: { projectName: [titles...] } }
  const demandsByPerson = {};
  for (const id of Object.keys(TEAM)) demandsByPerson[id] = {};

  try {
    await pg.connect();
    const ids = Object.keys(TEAM).map(id => `'${id}'`).join(',');
    const today = new Date().toISOString().slice(0, 10);

    const result = await pg.query(`
      SELECT d.title, d.priority, d.assignee_id,
             COALESCE(pr.name, 'Geral') as project
      FROM demands d
      LEFT JOIN projects pr ON pr.id = d.project_id
      WHERE d.assignee_id IN (${ids})
        AND d.status NOT IN ('completed', 'cancelled')
        AND (d.due_date IS NULL OR d.due_date::date <= '${today}'::date)
      ORDER BY pr.name, d.priority DESC
    `);

    for (const row of result.rows) {
      const person = demandsByPerson[row.assignee_id];
      if (!person) continue;
      const proj = row.project || 'Geral';
      if (!person[proj]) person[proj] = [];
      person[proj].push({ title: row.title, priority: row.priority });
    }
  } catch (e) {
    console.error('[Demands error]', e.message);
  } finally {
    await pg.end().catch(() => {});
  }

  return demandsByPerson;
}

// ─── Briefing ───────────────────────────────────────────────────────────────
async function buildBriefing() {
  const [commits, demands] = await Promise.all([
    getYesterdayCommits().catch(() => ({})),
    getTodayDemands().catch(() => ({}))
  ]);

  const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const todayStr = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });

  // --- PARTE 1: Resumo por projeto (GitHub) com IA ---
  // Agrupar todos os commits por repo (de todas as pessoas)
  const allByRepo = {};
  for (const [id, info] of Object.entries(TEAM)) {
    for (const c of (commits[id] || [])) {
      if (!allByRepo[c.repo]) allByRepo[c.repo] = { msgs: [], authors: new Set() };
      allByRepo[c.repo].msgs.push(c.msg);
      allByRepo[c.repo].authors.add(info.name);
    }
  }

  const part1 = [`--- O QUE FOI FEITO ONTEM (${yesterdayStr}) ---`, ''];

  if (Object.keys(allByRepo).length === 0) {
    part1.push('Nenhum commit no GitHub ontem.');
  } else {
    // Summarize each repo with AI (in parallel)
    const summaryPromises = Object.entries(allByRepo).map(async ([repo, data]) => {
      const summary = await summarizeCommits(repo, data.msgs);
      return { repo, summary, authors: [...data.authors], count: data.msgs.length };
    });
    const summaries = await Promise.all(summaryPromises);

    for (const s of summaries) {
      part1.push(`[${s.repo}] (${s.count} alteracoes - ${s.authors.join(', ')})`);
      part1.push(`  ${s.summary}`);
      part1.push('');
    }
  }

  // --- PARTE 2: Demandas de hoje por pessoa, agrupadas por projeto ---
  const part2 = [`--- AGENDA DE HOJE (${todayStr}) ---`, ''];

  for (const [id, info] of Object.entries(TEAM)) {
    const personDemands = demands[id] || {};
    const projects = Object.entries(personDemands);
    const totalCount = projects.reduce((s, [, items]) => s + items.length, 0);

    part2.push(`>> ${info.name.toUpperCase()} (${totalCount} demandas)`);

    if (totalCount === 0) {
      part2.push('  Sem demandas pendentes');
    } else {
      for (const [proj, items] of projects) {
        const highCount = items.filter(i => i.priority === 'high' || i.priority === 'urgent').length;
        const priLabel = highCount > 0 ? ` (${highCount} urgente)` : '';
        if (items.length <= 3) {
          // Poucas: lista todas
          part2.push(`  ${proj}${priLabel}:`);
          for (const item of items) {
            const pri = item.priority === 'urgent' ? '!!! ' : item.priority === 'high' ? '!! ' : '';
            part2.push(`    ${pri}${item.title}`);
          }
        } else {
          // Muitas: conta + lista urgentes
          const urgents = items.filter(i => i.priority === 'high' || i.priority === 'urgent');
          part2.push(`  ${proj}: ${items.length} tarefas${priLabel}`);
          if (urgents.length > 0) {
            for (const u of urgents) {
              part2.push(`    !! ${u.title}`);
            }
          }
        }
      }
    }
    part2.push('');
  }

  return part1.join('\n') + '\n' + part2.join('\n');
}

async function handleBriefing(chatId) {
  await sendTelegram('Gerando briefing... aguarde', chatId);
  try {
    const text = await buildBriefing();
    // Split if too long (Telegram limit 4096 chars)
    if (text.length > 4000) {
      const mid = text.lastIndexOf('\n\n', 2000);
      await sendTelegram(text.slice(0, mid), chatId);
      await sendTelegram(text.slice(mid), chatId);
    } else {
      await sendTelegram(text, chatId);
    }
  } catch (e) {
    await sendTelegram(`Erro ao gerar briefing: ${e.message}`, chatId);
  }
}

// ─── Morning auto-briefing (8h Brasilia) ────────────────────────────────────
let lastBriefingDate = '';
function checkMorningBriefing() {
  const now = new Date();
  const brHour = parseInt(now.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo', hour: 'numeric', hour12: false }));
  const brDate = now.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });

  if (brHour === MORNING_HOUR && brDate !== lastBriefingDate) {
    lastBriefingDate = brDate;
    console.log(`[Briefing] Sending morning briefing at ${brDate} ${brHour}h`);
    buildBriefing()
      .then(text => {
        if (text.length > 4000) {
          const mid = text.lastIndexOf('\n\n', 2000);
          return sendTelegram(text.slice(0, mid)).then(() => sendTelegram(text.slice(mid)));
        }
        return sendTelegram(text);
      })
      .catch(e => console.error('[Briefing error]', e.message));
  }
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
  // Simple path parsing without URL constructor (more compatible)
  const [pathPart, queryPart] = (req.url || '/').split('?');
  const parts = pathPart.split('/').filter(Boolean);
  const params = new URLSearchParams(queryPart || '');

  console.log(`[REQ] ${req.url} parts=${JSON.stringify(parts)} hb_keys=${JSON.stringify(Object.keys(heartbeats))}`);

  // GET /hb/:scriptName (heartbeat)
  if (parts[0] === 'hb' && parts.length >= 2) {
    const name = decodeURIComponent(parts.slice(1).join('/'));
    const wasLate = heartbeats[name] && heartbeats[name].alertSent;
    heartbeats[name] = { lastPing: new Date(), status: 'OK', lastError: null, alertSent: false };
    console.log(`[PING] ${name} saved. Total: ${Object.keys(heartbeats).length}`);
    if (wasLate) {
      sendTelegram(`RECUPERADO - ${name}\n\nVoltou a pingar em ${brDate(new Date())}`).catch(() => {});
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(`OK:${name}:${Object.keys(heartbeats).length}`);
    return;
  }

  // GET /err/:scriptName?err=...
  if (parts[0] === 'err' && parts.length >= 2) {
    const name = decodeURIComponent(parts.slice(1).join('/'));
    const errorMsg = params.get('err') || 'Erro desconhecido';
    heartbeats[name] = { lastPing: new Date(), status: 'ERROR', lastError: errorMsg, alertSent: false };
    errorLog.push({ time: new Date(), script: name, error: errorMsg });
    if (errorLog.length > 50) errorLog.shift();
    const msg = `ERRO - ${name}\n\n${brDate(new Date())}\n\n${errorMsg.slice(0, 800)}`;
    console.log(`[FAIL] ${name}: ${errorMsg.slice(0, 100)}`);
    sendTelegram(msg).catch(e => console.error('[Telegram error]', e.message));
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('FAIL registered');
    return;
  }

  // GET /status
  if (parts[0] === 'status') {
    const now = Date.now();
    const scripts = Object.entries(heartbeats).map(([n, hb]) => ({
      script: n, status: hb.status, lastPing: hb.lastPing.toISOString(),
      minutesAgo: Math.round((now - hb.lastPing.getTime()) / 60000),
      alertSent: hb.alertSent, lastError: hb.lastError
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ version: VERSION, monitor_since: monitorStartedAt.toISOString(), grace_hours: GRACE_HOURS, scripts, recent_errors: errorLog.slice(-5) }, null, 2));
    return;
  }

  // GET /
  if (pathPart === '/' || pathPart === '/health') {
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

  // Cron: checa heartbeats (cada 30min)
  setInterval(checkHeartbeats, CHECK_INTERVAL_MIN * 60 * 1000);

  // Cron: briefing matinal (checa a cada 5min se sao 8h Brasilia)
  setInterval(checkMorningBriefing, 5 * 60 * 1000);

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
