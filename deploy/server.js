// Court Hunter — постоянный сервер вместо функций Vercel.
//
// Те же обработчики из api/*.js и та же панель из public/, но в одном долгоживущем
// процессе. Лимитов «Fluid CPU / память» здесь нет, а эстафета фоновых веток
// (api/tick.js) работает как раньше: звено зовёт следующее по адресу APP_URL.
//
// Зависимостей нет. Запуск: node server.js (порт берётся из переменной PORT).
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 10000;
const API_DIR = path.join(__dirname, 'api');
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff'
};

// Процесс не должен падать из-за одного неудачного запроса: эстафете нужен живой сервер.
process.on('unhandledRejection', e => console.error('unhandledRejection:', (e && e.stack) || e));
process.on('uncaughtException', e => console.error('uncaughtException:', (e && e.stack) || e));

// ---------- обработчики api/<имя>.js, как в Vercel ----------
const modules = {};
function loadApi(name) {
  if (!/^[a-z0-9_-]+$/i.test(name)) return null;
  if (modules[name]) return modules[name];
  const file = path.join(API_DIR, name + '.js');
  if (!fs.existsSync(file)) return null;
  return (modules[name] = require(file));
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Как Vercel: JSON приходит уже разобранным, пустое тело — undefined.
function parseBody(req, raw) {
  if (!raw.length) return undefined;
  const s = raw.toString('utf8');
  const ct = String(req.headers['content-type'] || '');
  if (/x-www-form-urlencoded/i.test(ct)) return Object.fromEntries(new URLSearchParams(s));
  try { return JSON.parse(s); } catch (e) { return s; }
}

// Методы res.status().json(), которых нет у голого http.ServerResponse.
// res.json — обычное свойство: api/app.js перехватывает его через res.json.bind(res).
function shim(res) {
  res.on('error', () => {});
  res.status = code => { res.statusCode = code; return res; };
  res.json = obj => {
    if (!res.headersSent) res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(obj));
    return res;
  };
  res.send = body => {
    if (body !== null && typeof body === 'object' && !Buffer.isBuffer(body)) return res.json(body);
    if (!res.headersSent && !res.getHeader('Content-Type')) res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end(body == null ? '' : body);
    return res;
  };
  return res;
}

// ---------- статика: public/ ----------
async function serveStatic(pathname, req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(405).json({ ok: false });
  let rel;
  try { rel = decodeURIComponent(pathname); } catch (e) { return res.status(400).json({ ok: false }); }
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) return res.status(403).json({ ok: false });
  try {
    const data = await fs.promises.readFile(file);
    const ext = path.extname(file).toLowerCase();
    res.statusCode = 200;
    res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
    res.setHeader('Cache-Control', ext === '.html' ? 'no-cache' : 'public, max-age=3600');
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch (e) {
    res.status(404).json({ ok: false, error: 'not found' });
  }
}

const server = http.createServer(async (req, res) => {
  shim(res);
  let url;
  try { url = new URL(req.url, 'http://localhost'); }
  catch (e) { return res.status(400).json({ ok: false }); }
  const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;

  // Лёгкая проверка для хостинга: не трогает ни базу, ни сайт кортов.
  if (pathname === '/healthz') return res.status(200).send('ok');

  if (pathname.startsWith('/api/')) {
    const handler = loadApi(pathname.slice(5));
    if (!handler) return res.status(404).json({ ok: false, error: 'not found' });
    try {
      req.query = Object.fromEntries(url.searchParams);
      req.body = parseBody(req, await readBody(req, 2 * 1024 * 1024));
      await handler(req, res);
    } catch (e) {
      console.error(`${pathname}:`, (e && e.stack) || e);
      if (!res.headersSent) res.status(500).json({ ok: false, error: String((e && e.message) || e) });
      else res.end();
    }
    return;
  }

  return serveStatic(pathname, req, res);
});

// За прокси хостинга: не рвём соединения раньше него.
server.keepAliveTimeout = 120 * 1000;
server.headersTimeout = 125 * 1000;

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Court Hunter слушает порт ${PORT}`);
  if (!(process.env.APP_URL || '').trim()) console.warn('APP_URL не задан — фоновые ветки не смогут звать сами себя');
  if (!process.env.TICK_KEY) console.warn('TICK_KEY не задан — фоновый поиск и пингер не заработают');
});

// ---------- суточная сводка владельцу (раньше — cron в vercel.json) ----------
// 04:00 UTC = 09:00 в Астане. Раз в сутки зовём тот же обработчик, что звал Vercel.
let lastSummary = '';
setInterval(() => {
  const d = new Date();
  if (d.getUTCHours() !== 4 || d.getUTCMinutes() > 4 || !process.env.TICK_KEY) return;
  const day = d.toISOString().slice(0, 10);
  if (lastSummary === day) return;
  lastSummary = day;
  fetch(`http://127.0.0.1:${PORT}/api/tick?key=${encodeURIComponent(process.env.TICK_KEY)}&job=summary`)
    .catch(e => console.error('summary:', e.message));
}, 30 * 1000).unref();

// ---------- утренний режим: точный будильник ----------
// Охоты с флагом «Каждое утро в 7:00» просыпаются в начале окна (по умолчанию 06:59).
// Не ждём минутного пингера: сами зовём тот же обработчик, как только окно открылось.
let morning = null;
try { morning = require('./lib/morning'); } catch (e) { console.error('Утренний режим не загрузился:', e.message); }
let lastMorning = '';
setInterval(() => {
  if (!morning || !process.env.TICK_KEY || !morning.inWindow()) return;
  const day = new Date(Date.now() + (Number(process.env.TZ_OFFSET) || 5) * 3600e3).toISOString().slice(0, 10);
  if (lastMorning === day) return;
  lastMorning = day;
  fetch(`http://127.0.0.1:${PORT}/api/tick?key=${encodeURIComponent(process.env.TICK_KEY)}&job=morning`)
    .then(r => r.json())
    .then(j => { if (!j || j.ok !== true) { lastMorning = ''; console.error('morning:', JSON.stringify(j)); } })
    .catch(e => { lastMorning = ''; console.error('morning:', e.message); });
}, 5 * 1000).unref();

// Хостинг при обновлении шлёт SIGTERM: закрываемся аккуратно, эстафету поднимет пингер.
process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
});
