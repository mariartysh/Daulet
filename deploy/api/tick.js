// Фоновая охота. Три независимых движка, чтобы поиск шёл при закрытом телефоне:
//  1) ЦЕПОЧКА: каждый вызов, отработав ~45 сек, сам дёргает следующий — бот живёт сам,
//     пока задание активно. Ничего внешнего не нужно.
//  2) ПИНГЕР (cron-job.org, раз в минуту) — страховка, если цепочка порвалась.
//  3) Vercel Cron раз в день — ежедневная сводка + перезапуск цепочки.
const store = require('../lib/store');
const hunt = require('../lib/hunt');
const L = require('../lib/logic');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const CHAIN_TTL = 75e3;           // цепочка жива, если звено отметилось меньше 75 сек назад

function selfUrl(req) {
  const env = (process.env.APP_URL || '').replace(/\/+$/, '');
  if (env) return env;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return host ? `https://${host}` : null;
}

// Передать эстафету следующему звену.
// Ждём, пока запрос ГАРАНТИРОВАННО уйдёт (иначе Vercel заморозит инстанс раньше),
// затем обрываем соединение — принимающий вызов продолжает жить сам по себе.
async function passBaton(req) {
  const base = selfUrl(req);
  if (!base || !process.env.TICK_KEY) return false;
  const url = `${base}/api/tick?key=${encodeURIComponent(process.env.TICK_KEY)}&chain=1&n=${Date.now()}`;
  const ac = new AbortController();
  const started = fetch(url, { method: 'GET', headers: { 'x-chain': '1' }, signal: ac.signal }).catch(() => {});
  await Promise.race([started, sleep(2500)]);   // 2.5 сек хватает, чтобы Vercel принял запрос
  try { ac.abort(); } catch (e) {}
  return true;
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
  const spacing = Math.max(1, Math.min(60, Number(s.task.interval || process.env.POLL_INTERVAL_SEC || 15))) * 1000;
  const budget = 45000;                                  // ~45 сек работы, остальное на эстафету
  const sweeps = Math.max(1, Math.min(45, Math.floor(budget / spacing)));
  const results = [];
  const until = Date.now() + budget;

  for (let i = 0; i < sweeps && Date.now() < until; i++) {
    s = await store.load();                        // свежее состояние: могли остановить из бота
    if (s.botOn === false || !s.task.active) { results.push({ stopped: true }); break; }
    s.chainAt = Date.now();
    s.lastTick = Date.now();
    try { results.push(await hunt.sweep(s)); }
    catch (e) { s.stats.errors++; store.log(s, 'Сбой прохода: ' + e.message, 1); results.push({ error: e.message }); }
    await store.save(s);
    if (i < sweeps - 1) await sleep(spacing);
  }

  // --- эстафета следующему звену ---
  const fresh = await store.load();
  let handed = false;
  if (fresh.task.active && fresh.botOn !== false) {
    fresh.chainAt = Date.now();
    await store.save(fresh);
    handed = await passBaton(req);
    if (!handed) { fresh.chainAt = 0; await store.save(fresh); }
  } else { fresh.chainAt = 0; await store.save(fresh); }

  return res.status(200).json({ ok: true, at: L.fmt(Date.now()), chain: isChain ? 'link' : 'started', handed, sweeps: results.length, results: results.slice(-3) });
};
