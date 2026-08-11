// Фоновая охота. Живёт на сервере: Telegram и панель можно закрыть.
// Один проход обслуживает ВСЕХ пользователей и все их активные охоты.
//
// Вызовы:
//  1) звено цепочки (?chain=1&strand=a|b) — работает ~44 с и передаёт эстафету, дождавшись подтверждения;
//  2) пингер раз в минуту (?key=…) — поднимает мёртвые ветки и, если давно не было проверки, делает её сам;
//  3) ?job=summary — сводка владельцу.
const store = require('../lib/store');
const svc = require('../lib/svc');
const hunt = require('../lib/hunt');
const chain = require('../lib/chain');
const L = require('../lib/logic');

const WORK_MS = 44000;
const WATCH_MS = 10000;
const TAKEOVER = 30000;
const FLOOR_MS = 20000;

const authOk = req => {
  const q = req.query || {};
  return !!((q.key && q.key === process.env.TICK_KEY)
    || (process.env.CRON_SECRET && (req.headers.authorization || '') === `Bearer ${process.env.CRON_SECRET}`));
};

// Один проход по всем пользователям. Возвращает {any, pace, results}
async function sweepAll() {
  const g = await store.loadGlobal();
  if (g.botOn === false) return { any: false, pace: 60000, off: true };
  const rows = (g.users || []).filter(x => !x.blocked);
  const users = await store.loadUsers(rows);
  let any = false, pace = 60000;
  const results = [];
  for (const u of users) {
    svc.bind(g, u);
    let dirty = false;
    for (const h of u.hunts) {
      if (!h.active) continue;
      if (await hunt.autoStop(u, h)) { dirty = true; continue; }
      let r;
      try { r = await hunt.sweep(u, h); }
      catch (e) { h.stats.errors++; store.log(u, 'Сбой прохода: ' + e.message, 1); r = { error: e.message }; }
      await hunt.noteResult(u, h, r);
      results.push({ uid: u.uid, hunt: h.id, ...r });
      any = true; dirty = true;
      pace = Math.min(pace, hunt.pace(u, h));
    }
    try { await hunt.reminders(u); } catch (e) {}
    u.lastTick = Date.now();
    if (dirty || (u.hunts || []).some(h => (h.bookings || []).length)) { await store.saveUser(u); dirty = false; }
  }
  return { any, pace: Math.max(2000, pace), results };
}

// ---------- звено ветки ----------
async function link(req, res, strand, run, delaySec) {
  const before = await chain.beats().catch(() => ({}));
  await chain.beat(strand, run);
  // Ветка A работает, B только страхует — лишних запросов к сайту не делаем.
  const first = strand === 'a' ? await sweepAll() : { any: await anyActive(), pace: 10000 };
  if (!first.any) { await chain.drop(); return res.status(200).json({ ok: true, strand, idle: true }); }
  if (!chain.alive(before, strand)) {
    const g = await store.loadGlobal();
    store.log(g, `Фоновый поиск запущен (ветка ${strand.toUpperCase()})`);
    await store.saveGlobal(g);
  }
  if (delaySec) await chain.sleep(delaySec * 1000);

  const until = Date.now() + WORK_MS;
  let sweeps = 0, stop = '', respawn = 0, pace = first.pace;
  while (Date.now() < until) {
    const b = await chain.beats().catch(() => ({}));
    if (b[strand] && b[strand].run && b[strand].run !== run) { stop = 'taken'; break; }
    await chain.beat(strand, run);

    const workA = strand === 'a';
    const standIn = !workA && Date.now() - chain.at(b, 'a') > TAKEOVER;
    if (workA || standIn) {
      const r = await sweepAll();
      pace = r.pace;
      sweeps++;
      if (!r.any) { stop = 'done'; break; }
    }
    if (standIn && Date.now() - respawn > 60e3) {
      respawn = Date.now();
      await chain.spawn(req, 'a', { confirm: false });
    }
    const gap = (strand === 'a') ? pace : WATCH_MS;
    if (Date.now() + gap > until) break;
    await chain.sleep(gap);
  }

  let handed = false, neighbour = false;
  if (stop === 'done') await chain.drop();
  else if (stop !== 'taken') {
    const still = await anyActive();
    if (still) {
      handed = await chain.spawn(req, strand, { confirm: true });
      const other = strand === 'a' ? 'b' : 'a';
      const b2 = await chain.beats().catch(() => ({}));
      if (!chain.alive(b2, other)) neighbour = await chain.spawn(req, other, { confirm: false, delay: other === 'b' ? 20 : 0 });
    } else await chain.drop();
  }
  return res.status(200).json({ ok: true, at: L.fmt(Date.now()), strand, run, sweeps, pace, stop: stop || 'budget', handed, neighbour });
}

async function anyActive() {
  const g = await store.loadGlobal();
  if (g.botOn === false) return false;
  const users = await store.loadUsers((g.users || []).filter(x => !x.blocked));
  return users.some(u => (u.hunts || []).some(h => h.active));
}

async function lastTickAge() {
  const g = await store.loadGlobal();
  const users = await store.loadUsers((g.users || []).filter(x => !x.blocked));
  const t = Math.max(0, ...users.map(u => u.lastTick || 0));
  return t ? Date.now() - t : Infinity;
}

// ---------- пингер ----------
async function guard(req, res) {
  if (!(await anyActive())) {
    await chain.drop();
    const g = await store.loadGlobal();
    const users = await store.loadUsers((g.users || []).filter(x => !x.blocked));
    for (const u of users) { svc.bind(g, u); try { await hunt.reminders(u); await store.saveUser(u); } catch (e) {} }
    return res.status(200).json({ ok: true, active: false });
  }
  const b = await chain.beats().catch(() => ({}));
  const wasAlive = chain.aliveList(b);
  let swept = false;
  if ((await lastTickAge()) > FLOOR_MS) { await sweepAll(); swept = true; }
  const started = await chain.revive(req, { confirm: true });
  return res.status(200).json({ ok: true, at: L.fmt(Date.now()), alive: wasAlive, started, swept });
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!authOk(req)) return res.status(401).json({ ok: false, error: 'bad key' });
  const q = req.query || {};

  if (q.job === 'summary') {
    const g = await store.loadGlobal();
    const users = await store.loadUsers((g.users || []).filter(x => !x.blocked));
    for (const u of users) {
      svc.bind(g, u);
      if (!(u.hunts || []).some(h => h.active) && !hunt.allActiveBookings(u).length) continue;
      await hunt.sendTo(u, '📊 <b>Сводка</b>\n' + hunt.statusText(u, g));
      await store.saveUser(u);
    }
    if (await anyActive()) await chain.revive(req, { confirm: false });
    return res.status(200).json({ ok: true, job: 'summary' });
  }

  if (q.chain === '1') {
    const strand = q.strand === 'b' ? 'b' : 'a';
    const run = String(q.run || '').slice(0, 12) || Math.random().toString(36).slice(2, 9);
    const delay = Math.max(0, Math.min(30, Number(q.delay) || 0));
    try { return await link(req, res, strand, run, delay); }
    catch (e) {
      try { const g = await store.loadGlobal(); store.log(g, `Ветка ${strand.toUpperCase()} упала: ${e.message}`, 1); await store.saveGlobal(g); } catch (_) {}
      return res.status(200).json({ ok: false, strand, error: e.message });
    }
  }

  try { return await guard(req, res); }
  catch (e) { return res.status(200).json({ ok: false, error: e.message }); }
};
