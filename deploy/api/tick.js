// Пингуется внешним кроном (cron-job.org) раз в минуту: /api/tick?key=TICK_KEY
// Внутри делает несколько проходов с паузой — получается суб-минутный опрос.
// Vercel cron (раз в день) дергает /api/tick?job=summary для сводки.
const store = require('../lib/store');
const hunt = require('../lib/hunt');
const L = require('../lib/logic');

const sleep = ms => new Promise(r => setTimeout(r, ms));

module.exports = async (req, res) => {
  const q = req.query || {};
  const okKey = q.key && q.key === process.env.TICK_KEY;
  const okCron = (req.headers.authorization || '') === `Bearer ${process.env.CRON_SECRET}` && process.env.CRON_SECRET;
  if (!okKey && !okCron) return res.status(401).json({ ok: false, error: 'bad key' });

  const s = await store.load();

  if (q.job === 'summary') {
    const act = hunt.activeBookings(s);
    let txt = `📊 <b>Сводка за день</b>\n${hunt.statusText(s)}`;
    if (!act.length && !s.task.active) txt += '\nБроней нет, задание выключено.';
    await hunt.ownerSend(s, txt);
    await store.save(s);
    return res.status(200).json({ ok: true, job: 'summary' });
  }

  if (!s.task.active) {
    await hunt.reminders(s);           // напоминания работают и при выключенном задании
    await store.save(s);
    return res.status(200).json({ ok: true, active: false });
  }

  const sweeps = Math.max(1, Math.min(3, Number(process.env.SWEEPS_PER_CALL || 2)));
  const spacing = Math.max(5, Number(process.env.POLL_INTERVAL_SEC || 15)) * 1000;
  const results = [];
  for (let i = 0; i < sweeps; i++) {
    try { results.push(await hunt.sweep(s)); }
    catch (e) { s.stats.errors++; store.log(s, 'Сбой прохода: ' + e.message, 1); results.push({ error: e.message }); }
    await store.save(s);               // сохраняем после каждого прохода
    if (!s.task.active) break;
    if (i < sweeps - 1) await sleep(spacing);
  }
  return res.status(200).json({ ok: true, at: L.fmt(Date.now()), results });
};
