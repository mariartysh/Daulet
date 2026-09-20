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

// Все окна кэша вынесены в переменные окружения: если однажды понадобится
// реакция побыстрее — поднимаете тариф базы и уменьшаете числа, код трогать не надо.
const WORK_MS = 44000;
const WATCH_MS = 10000;
const TAKEOVER = 30000;
const FLOOR_MS = 20000;
const N = (k, d) => Number(process.env[k] || d);
const G_FRESH = N('G_FRESH_MS', 60000);     // глобальное состояние берём из памяти до 60 с
const U_FRESH = N('U_FRESH_MS', 30000);     // профили — до 30 с (стоп из панели подхватится за полминуты)
const SAVE_MS = N('SAVE_MS', 45000);        // обычные изменения пишем не чаще раза в 45 с
const BEATS_MS = N('BEATS_MS', 20000);      // как часто звено сверяется с соседями

const authOk = req => {
  const q = req.query || {};
  return !!((q.key && q.key === process.env.TICK_KEY)
    || (process.env.CRON_SECRET && (req.headers.authorization || '') === `Bearer ${process.env.CRON_SECRET}`));
};

// Один проход по всем пользователям. Возвращает {any, pace, results}
// Ночная пауза. Vercel на бесплатном тарифе считает не запросы, а ВРЕМЯ жизни функции,
// поэтому каждый час простоя охоты стоит денег в его лимитах. Если вам не нужен поиск
// глубокой ночью — задайте переменную QUIET_HOURS, например 01:00-07:00, и бот в это
// время спит целиком. По умолчанию выключено: ищет круглосуточно.
function inQuietHours() {
  const q = String(process.env.QUIET_HOURS || '').trim();
  const m = q.match(/^(\d{1,2}):(\d{2})\s*[-–]\s*(\d{1,2}):(\d{2})$/);
  if (!m) return false;
  const off = (Number(process.env.TZ_OFFSET) || 5) * 60;
  const local = (Math.floor(Date.now() / 60000) + off) % 1440;
  const from = +m[1] * 60 + +m[2], to = +m[3] * 60 + +m[4];
  return from <= to ? (local >= from && local < to) : (local >= from || local < to);
}

async function sweepAll() {
  if (inQuietHours()) return { any: false, pace: 60000, quiet: true };
  const g = await store.loadGlobal(G_FRESH);
  if (g.botOn === false) { await store.setAct({ h: 0, b: 0 }); return { any: false, pace: 60000, off: true }; }
  const rows = (g.users || []).filter(x => !x.blocked);
  const users = await store.loadUsers(rows, U_FRESH);

  // Защита от аварии с лимитом базы: дошли до бюджета — ставим охоты на паузу и предупреждаем,
  // а не ждём, пока Upstash начнёт отказывать во всём сразу.
  if (store.overBudget(g)) {
    for (const u of users) {
      if (!u.hunts.some(h => h.active)) continue;
      svc.bind(g, u);
      for (const h of u.hunts) { h.active = false; h.actBy = 'budget'; }
      store.log(u, 'Охоты остановлены: израсходован месячный бюджет обращений к базе', 1);
      await store.saveUser(u, { merge: true });
      await hunt.sendTo(u, '⚠️ <b>Остановил охоты</b>\nМесячный счётчик обращений к базе дошёл до потолка — иначе бот ляжет целиком.\nСбросится 1-го числа. Сбросить вручную: откройте <code>/api/health?key=ВАШ_TICK_KEY&amp;resetcmd=1</code>. Потолок задаётся переменной CMD_BUDGET (0 — выключить проверку).').catch(() => {});
    }
    await store.setAct({ h: 0, b: 0 });
    await store.saveGlobal(g);
    return { any: false, pace: 60000, off: true, budget: true };
  }
  let any = false, pace = 60000, hAct = 0, bAct = 0;
  const results = [];
  for (const u of users) {
    svc.bind(g, u);
    let changed = false, important = false;
    for (const h of u.hunts) {
      if (!h.active) continue;
      if (await hunt.autoStop(u, h)) { changed = true; important = true; continue; }
      let r;
      try { r = await hunt.sweep(u, h); }
      catch (e) { h.stats.errors++; store.log(u, 'Сбой прохода: ' + e.message, 1); r = { error: e.message }; }
      await hunt.noteResult(u, h, r);
      results.push({ uid: u.uid, hunt: h.id, ...r });
      any = true; changed = true;
      if (r && (r.booked || r.found || r.offered || r.error)) important = true;   // события пишем сразу
      pace = Math.min(pace, hunt.pace(u, h));
    }
    try { if (await hunt.reminders(u)) { changed = true; important = true; } } catch (e) {}
    hAct += u.hunts.filter(h => h.active).length;
    bAct += hunt.allActiveBookings(u).length;
    if (changed) store.markDirty(u.uid);
    if (important || store.dirtyFor(u.uid) > SAVE_MS) {
      u.lastTick = Date.now();
      await store.saveUser(u, { merge: true });      // не затираем правки из панели и бота
    }
  }
  await store.setAct({ h: hAct, b: bAct });
  return { any, pace: Math.max(N('MIN_PACE_MS', 900), pace), results };
}

// ---------- звено ветки ----------
async function link(req, res, strand, run, delaySec) {
  const before = await chain.beats().catch(() => ({}));
  await chain.beat(strand, run);
  // Ветка A работает, B только страхует — лишних запросов к сайту не делаем.
  const first = strand === 'a' ? await sweepAll() : { any: await anyActive(true), pace: 10000 };
  if (!first.any) { await chain.drop(); await store.flushCmd(); return res.status(200).json({ ok: true, strand, idle: true }); }
  if (!chain.alive(before, strand)) {
    const g = await store.loadGlobal(G_FRESH);
    store.log(g, `Фоновый поиск запущен (ветка ${strand.toUpperCase()})`);
    await store.saveGlobal(g);
  }
  if (delaySec) await chain.sleep(delaySec * 1000);

  const until = Date.now() + WORK_MS;
  let sweeps = 0, stop = '', respawn = 0, pace = first.pace;
  let b = {}, seen = 0;
  while (Date.now() < until) {
    if (Date.now() - seen > BEATS_MS) { b = await chain.beats().catch(() => ({})); seen = Date.now(); }
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
    const still = await anyActive(true);
    if (still) {
      handed = await chain.spawn(req, strand, { confirm: true });
      const other = strand === 'a' ? 'b' : 'a';
      if (chain.STRANDS.includes(other)) {
        const b2 = await chain.beats().catch(() => ({}));
        if (!chain.alive(b2, other)) neighbour = await chain.spawn(req, other, { confirm: false, delay: other === 'b' ? 20 : 0 });
      }
    } else await chain.drop();
  }
  await store.flushCmd();   // записать израсходованное, пока звено ещё живо
  return res.status(200).json({ ok: true, at: L.fmt(Date.now()), strand, run, sweeps, pace, stop: stop || 'budget', handed, neighbour });
}

async function anyActive(cheap) {
  const a = await store.getAct();
  if (a && !a.h) return false;                       // одна короткая команда вместо чтения всего состояния
  if (cheap && a && a.h) return true;                // ключ уже говорит «охоты идут» — пересчитывать незачем
  const g = await store.loadGlobal(G_FRESH);
  if (g.botOn === false) return false;
  const users = await store.loadUsers((g.users || []).filter(x => !x.blocked), U_FRESH);
  const h = users.reduce((n, u) => n + u.hunts.filter(x => x.active).length, 0);
  const b = users.reduce((n, u) => n + hunt.allActiveBookings(u).length, 0);
  await store.setAct({ h, b });
  return h > 0;
}

// ---------- пингер ----------
async function guard(req, res) {
  // Одно чтение приносит и сердцебиения веток, и признак «есть ли активные охоты».
  // Раньше на это уходило два обращения, а в простое пингер зовётся круглые сутки.
  const b0 = await chain.beats().catch(() => ({}));
  const a = b0.act;
  // Ни охот, ни броней — выходим сразу. В простое это 1 команда на вызов пингера.
  if (a && !a.h && !a.b) return res.status(200).json({ ok: true, active: false, idle: true });
  // Ключ уже сказал «охоты идут» — верим ему и не перечитываем всё состояние заново.
  const active = (a && a.h) ? true : await anyActive();
  if (!active) {
    await chain.drop();
    const g = await store.loadGlobal(G_FRESH);
    const users = await store.loadUsers((g.users || []).filter(x => !x.blocked), U_FRESH);
    for (const u of users) { svc.bind(g, u); try { await hunt.reminders(u); await store.saveUser(u); } catch (e) {} }
    await store.flushCmd();
    return res.status(200).json({ ok: true, active: false });
  }
  const b = b0;                      // то же чтение, что и выше — второй раз базу не трогаем
  const wasAlive = chain.aliveList(b);
  const age = Math.max(chain.at(b, 'a'), chain.at(b, 'b'));
  let swept = false;
  if (!age || Date.now() - age > FLOOR_MS) { await sweepAll(); swept = true; }
  const started = await chain.revive(req, { confirm: true, beats: b });
  await store.flushCmd();
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
