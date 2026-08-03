// Фоновая охота. Работает на сервере и не зависит от Telegram и панели.
// Стоп только по: цель набрана · охота отменена · 12 часов поиска.
//
// Что вызывает этот файл:
//  1) ЗВЕНО ЦЕПОЧКИ (?chain=1&strand=a|b) — работает ~44 сек и передаёт эстафету дальше,
//     дождавшись подтверждения. Ветка A ищет, ветка B страхует и подхватывает.
//  2) ПИНГЕР раз в минуту (?key=…) — поднимает мёртвые ветки и, если давно не было
//     проверки, делает одну сам. Гарантированный минимум: 1 проверка в минуту.
//  3) Vercel Cron раз в сутки (?job=summary) — сводка + подъём веток.
const store = require('../lib/store');
const hunt = require('../lib/hunt');
const chain = require('../lib/chain');
const L = require('../lib/logic');

const WORK_MS = 44000;     // работа одного звена (maxDuration 60: остаток — на эстафету)
const WATCH_MS = 10000;    // шаг стража
const TAKEOVER = 30000;    // A молчит столько — страж начинает искать сам
const FLOOR_MS = 20000;    // пингер делает свою проверку, если последней не было столько

const authOk = req => {
  const q = req.query || {};
  return !!((q.key && q.key === process.env.TICK_KEY)
    || (process.env.CRON_SECRET && (req.headers.authorization || '') === `Bearer ${process.env.CRON_SECRET}`));
};

// Охота ещё идёт? (учитывает цель, 12 часов и общий выключатель). Мутации сохраняет сам.
async function running(s) {
  if (s.botOn === false || !s.task.active) return false;
  const stopped = await hunt.autoStop(s);
  if (stopped) await store.save(s);
  return !stopped;
}

async function sweepOnce(s) {
  s.lastTick = Date.now();
  s.chainAt = Date.now();
  let r;
  try { r = await hunt.sweep(s); }
  catch (e) { s.stats.errors++; store.log(s, 'Сбой прохода: ' + e.message, 1); r = { error: e.message }; }
  await hunt.noteResult(s, r);
  await store.save(s);
  return r;
}

// ---------- звено ветки ----------
async function link(req, res, strand, run, delaySec) {
  const before = await chain.beats().catch(() => ({}));
  await chain.beat(strand, run);
  let s = await store.load();
  if (!(await running(s))) { await chain.drop(); return res.status(200).json({ ok: true, strand, idle: true }); }
  if (!chain.alive(before, strand)) {
    store.log(s, `Фоновый поиск запущен (ветка ${strand.toUpperCase()})`);
    await store.save(s);
  }
  if (delaySec) await chain.sleep(delaySec * 1000);

  const until = Date.now() + WORK_MS;
  let sweeps = 0, stop = '', last = null, respawn = 0;
  while (Date.now() < until) {
    const b = await chain.beats().catch(() => ({}));
    if (b[strand] && b[strand].run && b[strand].run !== run) { stop = 'taken'; break; }
    await chain.beat(strand, run);
    s = await store.load();
    if (!(await running(s))) { stop = 'done'; break; }

    const workA = strand === 'a';
    const standIn = !workA && Date.now() - chain.at(b, 'a') > TAKEOVER;
    if (workA || standIn) { last = await sweepOnce(s); sweeps++; }
    if (standIn && Date.now() - respawn > 60e3) {   // рабочая ветка молчит — поднимаем
      respawn = Date.now();
      store.log(s, 'Рабочая ветка молчит — поднимаю её', 1);
      await store.save(s);
      await chain.spawn(req, 'a', { confirm: false });
    }
    const gap = workA ? hunt.pace(s) : WATCH_MS;
    if (Date.now() + gap > until) break;
    await chain.sleep(gap);
  }

  // ---------- эстафета ----------
  let handed = false, neighbour = false;
  if (stop === 'done') { await chain.drop(); }
  else if (stop !== 'taken') {
    const fresh = await store.load();
    if (await running(fresh)) {
      handed = await chain.spawn(req, strand, { confirm: true });
      if (!handed) {
        const f = await store.load();
        store.log(f, `Ветка ${strand.toUpperCase()} не смогла передать эстафету — поднимет пингер или сосед`, 1);
        await store.save(f);
      }
      const other = strand === 'a' ? 'b' : 'a';
      const b2 = await chain.beats().catch(() => ({}));
      if (!chain.alive(b2, other)) neighbour = await chain.spawn(req, other, { confirm: false, delay: other === 'b' ? 20 : 0 });
    } else await chain.drop();
  }
  return res.status(200).json({ ok: true, at: L.fmt(Date.now()), strand, run, sweeps, stop: stop || 'budget', handed, neighbour, last });
}

// ---------- пингер: сторож снаружи ----------
async function guard(req, res) {
  const s = await store.load();
  if (!(await running(s))) {
    await chain.drop();
    await hunt.reminders(s);
    await store.save(s);
    return res.status(200).json({ ok: true, active: false });
  }
  const b = await chain.beats().catch(() => ({}));
  const wasAlive = chain.aliveList(b);
  let swept = null;
  if (Date.now() - (s.lastTick || 0) > FLOOR_MS) swept = await sweepOnce(s);   // минимум раз в минуту
  const started = await chain.revive(req, { confirm: true });
  return res.status(200).json({
    ok: true, at: L.fmt(Date.now()), alive: wasAlive, started,
    swept: !!swept, checks: s.stats.checks, found: s.stats.found
  });
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!authOk(req)) return res.status(401).json({ ok: false, error: 'bad key' });
  const q = req.query || {};

  if (q.job === 'summary') {
    const s = await store.load();
    await hunt.sendAll(s, '📊 <b>Сводка за день</b>\n' + hunt.statusText(s));
    s.lastTick = Date.now();
    await store.save(s);
    if (s.task.active && s.botOn !== false) await chain.revive(req, { confirm: false });
    return res.status(200).json({ ok: true, job: 'summary' });
  }

  if (q.chain === '1') {
    const strand = q.strand === 'b' ? 'b' : 'a';
    const run = String(q.run || '').slice(0, 12) || Math.random().toString(36).slice(2, 9);
    const delay = Math.max(0, Math.min(30, Number(q.delay) || 0));
    try { return await link(req, res, strand, run, delay); }
    catch (e) {
      try { const s = await store.load(); store.log(s, `Ветка ${strand.toUpperCase()} упала: ${e.message}`, 1); await store.save(s); } catch (_) {}
      return res.status(200).json({ ok: false, strand, error: e.message });
    }
  }

  try { return await guard(req, res); }
  catch (e) { return res.status(200).json({ ok: false, error: e.message }); }
};
