// Фоновая охота. Три независимых движка, чтобы поиск шёл при закрытом телефоне:
//  1) ЦЕПОЧКА: каждый вызов, отработав ~45 сек, сам дёргает следующий — бот живёт сам,
//     пока задание активно. Ничего внешнего не нужно.
//  2) ПИНГЕР (cron-job.org, раз в минуту) — страховка, если цепочка порвалась.
//  3) Vercel Cron раз в день — ежедневная сводка + перезапуск цепочки.
const store = require('../lib/store');
const hunt = require('../lib/hunt');
const L = require('../lib/logic');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const CHAIN_TTL = 100e3;          // цепочка считается живой, если звено было меньше 100 сек назад

function selfUrl(req) {
  const env = (process.env.APP_URL || '').replace(/\/+$/, '');
  if (env) return env;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return host ? `https://${host}` : null;
}

// Запустить следующее звено, не дожидаясь ответа
function passBaton(req, extra) {
  const base = selfUrl(req);
  if (!base || !process.env.TICK_KEY) return;
  const url = `${base}/api/tick?key=${encodeURIComponent(process.env.TICK_KEY)}&chain=1${extra || ''}`;
  try { fetch(url, { method: 'GET', headers: { 'x-chain': '1' } }).catch(() => {}); } catch (e) {}
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const q = req.query || {};
  const okKey = q.key && q.key === process.env.TICK_KEY;
  const okCron = process.env.CRON_SECRET && (req.headers.authorization || '') === `Bearer ${process.env.CRON_SECRET}`;
  if (!okKey && !okCron) return res.status(401).json({ ok: false, error: 'bad key' });

  let s = await store.load();

  // --- ежедневная сводка (Vercel Cron) ---
  if (q.job === 'summary') {
    await hunt.sendAll(s, '📊 <b>Сводка за день</b>\n' + hunt.statusText(s));
    s.lastTick = Date.now();
    await store.save(s);
    if (s.task.active && s.botOn !== false) passBaton(req);   // заодно поднимаем цепочку
    return res.status(200).json({ ok: true, job: 'summary' });
  }

  const isChain = q.chain === '1';
  const now = Date.now();
  const chainAlive = s.chainAt && now - s.chainAt < CHAIN_TTL;

  // Внешний пингер не мешает живой цепочке — только следит и поднимает упавшую
  if (!isChain && chainAlive) {
    return res.status(200).json({ ok: true, chain: 'alive', lastTick: s.lastTick || 0 });
  }

  if (s.botOn === false || !s.task.active) {
    s.chainAt = 0;                       // цепочку не тянем, но напоминания об отмене нужны
    s.lastTick = now;
    await hunt.reminders(s);
    await store.save(s);
    return res.status(200).json({ ok: true, active: false });
  }

  // --- рабочее звено: ~45 сек проходов каждые 15 сек ---
  const spacing = Math.max(10, Number(process.env.POLL_INTERVAL_SEC || 15)) * 1000;
  const sweeps = Math.max(1, Math.min(4, Number(process.env.SWEEPS_PER_CALL || 3)));
  const results = [];

  for (let i = 0; i < sweeps; i++) {
    s = await store.load();                        // свежее состояние: могли остановить из бота
    if (s.botOn === false || !s.task.active) { results.push({ stopped: true }); break; }
    s.chainAt = Date.now();
    s.lastTick = Date.now();
    try { results.push(await hunt.sweep(s)); }
    catch (e) { s.stats.errors++; store.log(s, 'Сбой прохода: ' + e.message, 1); results.push({ error: e.message }); }
    await store.save(s);
    if (i < sweeps - 1) await sleep(spacing);
  }

  // --- передаём эстафету следующему звену ---
  const fresh = await store.load();
  if (fresh.task.active && fresh.botOn !== false) passBaton(req);
  else { fresh.chainAt = 0; await store.save(fresh); }

  return res.status(200).json({ ok: true, at: L.fmt(Date.now()), chain: isChain ? 'link' : 'started', results });
};
