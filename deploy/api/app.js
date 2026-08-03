// API панели: логин, состояние, автосохранение, старт/стоп, проверка, отмена.
const crypto = require('crypto');
const store = require('../lib/store');
const hunt = require('../lib/hunt');
const chain = require('../lib/chain');
const L = require('../lib/logic');

// Поднять мёртвые фоновые ветки (не чаще раза в 20 сек). Состояние должно быть УЖЕ сохранено.
async function kick(req, s, confirm) {
  if (!s.task.active || s.botOn === false || !process.env.TICK_KEY) return [];
  if (Date.now() - (s.kickAt || 0) < 20e3) return [];
  s.kickAt = Date.now();
  return chain.revive(req, { confirm: !!confirm });
}

const token = pw => crypto.createHash('sha256').update(pw + '|' + (process.env.TICK_KEY || 'salt')).digest('hex');

function normPhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.startsWith('8')) d = '7' + d.slice(1);
  if (d && !d.startsWith('7')) d = '7' + d;
  d = d.slice(0, 11);
  return d.length === 11 ? '+' + d : '';
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ ok: false });
  const body = req.body || {};
  const s = await store.load();
  const authed = req.headers['x-auth'] && req.headers['x-auth'] === token(s.password);

  if (body.action === 'login') {
    if (body.password === s.password) return res.status(200).json({ ok: true, token: token(s.password) });
    return res.status(401).json({ ok: false, error: 'Пароль не подошёл' });
  }
  if (!authed) return res.status(401).json({ ok: false, error: 'auth' });

  try {
    switch (body.action) {
      case 'state': {
        const bts = await chain.beats().catch(() => ({}));
        const live = chain.aliveList(bts);
        if (!live.length) {
          const started = await kick(req, s, false);
          if (started.length) { store.log(s, 'Поднимаю фоновый поиск'); await store.save(s); }
        }
        const act = hunt.activeBookings(s).sort((a, b) => a.start - b.start);
        return res.status(200).json({
          ok: true,
          task: s.task, profile: s.profile, stats: s.stats,
          tg: (s.chats || []).length,
          botOn: s.botOn !== false,
          goalHours: hunt.goalHours(s), bookedHours: hunt.bookedHours(s),
          perDay: hunt.dayPlan(s).map(d => ({ iso: d.iso, need: d.need, got: Math.min(d.need, d.got) })),
          pace: Math.round(hunt.pace(s) / 1000),
          lastTick: s.lastTick || 0,
          chainAt: s.chainAt || 0,
          bg: live.length > 0,
          strands: live,
          bookings: act.map(b => {
            const d = L.deadlines(b.start);
            return { id: b.id, title: hunt.courtTitle(b, b.name), when: L.whenText(b.start, b.dur), start: b.start,
              price: b.price, online: d.online, phone: d.phone,
              midnight: L.hm(b.start) === '00:00' };
          }),
          offers: (s.offers || []).map(o => ({ id: o.id, title: hunt.courtTitle(o, o.name), when: L.whenText(o.start, o.dur), price: o.price, start: o.start, midnight: L.hm(o.start) === '00:00' })),
          log: s.log.slice(0, 60)
        });
      }
      case 'save': {
        const before = JSON.stringify({ ...s.task, active: 0 });
        if (body.task) {
          const t = { ...s.task, ...body.task };
          t.active = s.task.active; // запуск только явной командой
          t.needed = Math.max(1, Math.min(10, Number(t.needed) || 1));
          t.dayOffsets = (t.dayOffsets || [0]).filter(o => [0, 1, 2].includes(o));
          if (!t.dayOffsets.length) t.dayOffsets = [0];
          if (!['any', 'indoor', 'outdoor'].includes(t.type)) t.type = 'any';
          if (![60, 120].includes(t.dur)) t.dur = 60;
          if (![10, 15, 30, 60].includes(Number(t.interval))) t.interval = 10;
          t.interval = Number(t.interval);
          t.split = t.split !== false;
          if (t.type === 'any') t.courts = [];
          L.fitWindow(t);
          const fchg = JSON.stringify({ ...s.task, active: 0 }) !== JSON.stringify({ ...t, active: 0 });
          s.task = t;
          if (fchg) { hunt.pruneOffers(s); s.seen = {}; }
        }
        if (body.profile) {
          s.profile.name = String(body.profile.name || '').slice(0, 60);
          s.profile.phone = normPhone(body.profile.phone) || String(body.profile.phone || '').slice(0, 20);
          s.profile.email = String(body.profile.email || '').slice(0, 80);
        }
        const changed = JSON.stringify({ ...s.task, active: 0 }) !== before;
        if (changed && s.task.active && Date.now() - (s.lastPlanPing || 0) > 120e3) {
          s.lastPlanPing = Date.now();
          await hunt.sendAll(s, '✏️ <b>План поменяли в панели</b> — ловлю уже по-новому.\n\n' + hunt.statusText(s));
        }
        await store.save(s);
        return res.status(200).json({ ok: true });
      }
      case 'start': {
        if (s.botOn === false) return res.status(200).json({ ok: false, error: 'Бот выключен владельцем' });
        if (!s.profile.phone || !s.profile.name) return res.status(200).json({ ok: false, error: 'Сначала имя и телефон — на кого бронировать?' });
        if (hunt.leftHours(s) <= 0) return res.status(200).json({ ok: false, error: 'Цель уже набрана — добавьте дней или кортов' });
        s.task.active = true;
        s.stats.startedAt = Date.now();
        s.bo = { fails: 0 };
        hunt.dropPhantoms(s);
        s.offers = []; s.seen = {};
        const iv = Number(s.task.interval) || 10;
        store.log(s, `Охота запущена: проверка каждые ${iv} с, нужно ${s.task.needed} на каждый день, ${s.task.timeFrom}–${s.task.timeTo}`);
        await hunt.sendAll(s, `🟢 <b>Охота запущена</b> — из панели.\nПроверяю расписание каждые ${iv} с — Telegram можно закрыть, ищу на сервере.\n\n` + hunt.statusText(s));
        await hunt.sweep(s).catch(e => store.log(s, 'Первый проход не удался: ' + e.message, 1));
        s.kickAt = Date.now();
        await store.save(s);                      // сохраняем ДО запуска веток — иначе они увидят старое состояние
        await chain.drop();
        const okA = await chain.spawn(req, 'a', { confirm: true });
        await chain.spawn(req, 'b', { confirm: false, delay: 20 });
        if (!okA) {
          const f = await store.load();
          store.log(f, 'Фоновая ветка не поднялась — проверьте APP_URL/TICK_KEY и пингер', 1);
          await store.save(f);
        }
        return res.status(200).json({ ok: true, bg: okA });
      }
      case 'stop': {
        const was = s.task.active;
        s.task.active = false;
        s.chainAt = 0;
        store.log(s, 'Охота остановлена из панели');
        if (was) await hunt.sendAll(s, '⏹ <b>Охота остановлена</b> — из панели.\nВключить снова: /menu');
        await store.save(s);
        await chain.drop();
        return res.status(200).json({ ok: true });
      }
      case 'cancelBooking': {
        const r = await hunt.doCancel(s, body.id);
        if (r.ok) await hunt.sendAll(s, `↩️ <b>Бронь отменена</b> — из панели.\n${hunt.courtTitle(r.b, r.b.name)} · ${L.whenText(r.b.start, r.b.dur)}\nСлот снова свободен на сайте.`);
        await store.save(s);
        return res.status(200).json(r.ok ? { ok: true } : { ok: false, error: r.why });
      }
      case 'pulse': {
        if (s.botOn === false || !s.task.active) return res.status(200).json({ ok: true, idle: true });
        const minGap = Math.max(3000, hunt.pace(s) - 1500);
        if (Date.now() - (s.lastPulse || 0) < minGap) return res.status(200).json({ ok: true, skipped: true });
        s.lastPulse = Date.now(); s.lastTick = Date.now();
        const r = await hunt.sweep(s);
        await hunt.noteResult(s, r);
        await store.save(s);
        return res.status(200).json({ ok: true, result: r });
      }
      case 'reset': {
        s.bookings = []; s.offers = []; s.seen = {}; s.reminded = {};
        s.targets = null; s.svcCache = null; s.task.active = false;
        s.stats = { checks: 0, found: 0, booked: 0, errors: 0, startedAt: 0 };
        store.log(s, 'Данные о бронях и вариантах очищены');
        await store.save(s);
        return res.status(200).json({ ok: true });
      }
      case 'takeOffer': {
        const r = await hunt.takeOffer(s, body.id);
        await store.save(s);
        return res.status(200).json(r.ok ? { ok: true } : { ok: false, error: r.why });
      }
      case 'skipOffer': {
        hunt.dropOffer(s, body.id);
        await store.save(s);
        return res.status(200).json({ ok: true });
      }
      case 'probe': {
        const out = { tg: !!process.env.TELEGRAM_TOKEN, tgLinked: (s.chats || []).length, kv: !!process.env.UPSTASH_REDIS_REST_URL };
        try {
          const list = await hunt.ensureTargets(s);
          out.altegio = true;
          out.courts = list.length;
          out.matching = list.filter(x => L.courtOk(s.task, x)).length;
        } catch (e) { out.altegio = false; out.error = e.message; }
        await store.save(s);
        return res.status(200).json({ ok: true, probe: out });
      }
      case 'check': {
        if (!s.task.active) return res.status(200).json({ ok: false, error: 'Охота на паузе — сначала запустите' });
        const r = await hunt.sweep(s);
        await hunt.noteResult(s, r);
        await store.save(s);
        return res.status(200).json({ ok: true, result: r });
      }
      default:
        return res.status(400).json({ ok: false, error: 'unknown action' });
    }
  } catch (e) {
    store.log(s, 'Сбой панели: ' + e.message, 1);
    await store.save(s);
    return res.status(500).json({ ok: false, error: e.message });
  }
};
