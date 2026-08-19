// API мини-приложения. Каждый пользователь видит только свои данные;
// владелец дополнительно получает админ-раздел. Все действия идут через lib/svc.js —
// те же самые, что за кнопками в Telegram.
const store = require('../lib/store');
const svc = require('../lib/svc');
const hunt = require('../lib/hunt');
const chain = require('../lib/chain');
const alt = require('../lib/altegio');
const L = require('../lib/logic');

const bookView = b => {
  const d = L.deadlines(b.start);
  return {
    id: b.id, title: hunt.courtTitle(b, b.name), when: L.whenText(b.start, 60), start: b.start,
    price: b.price, online: d.online, phone: d.phone, onName: b.onName || '',
    midnight: L.hm(b.start) === '00:00' || L.hm(b.start) === '01:00'
  };
};
const offerView = o => ({
  id: o.id, title: hunt.courtTitle(o, o.name), when: L.whenText(o.start, 60),
  price: o.price, start: o.start, midnight: L.hm(o.start) === '00:00' || L.hm(o.start) === '01:00'
});

function huntView(u, h) {
  return {
    id: h.id, title: h.title, label: hunt.label(h), active: !!h.active,
    mode: h.mode, needed: h.needed, type: h.type, courts: h.courts,
    days: h.days, timeFrom: h.timeFrom, timeTo: h.timeTo, interval: h.interval,
    goal: hunt.goalSlots(h), booked: hunt.bookedSlots(h),
    perDay: hunt.dayPlan(h).map(d => ({ iso: d.iso, need: d.need, got: Math.min(d.need, d.got) })),
    pace: Math.round(hunt.pace(u, h) / 1000),
    startedAt: h.startedAt, stats: h.stats,
    bookings: hunt.activeBookings(h).sort((a, b) => a.start - b.start).map(bookView),
    offers: (h.offers || []).map(offerView)
  };
}

function initUser(initData) {
  try { return JSON.parse(new URLSearchParams(initData).get('user') || '{}'); }
  catch (e) { return {}; }
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ ok: false });
  let body = req.body || {};
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  let g;
  try { g = await store.loadGlobal(); }
  catch (e) {
    const msg = store.live ? 'База не отвечает: ' + e.message : 'Хранилище не настроено — задайте UPSTASH_REDIS_REST_URL и TOKEN';
    return res.status(200).json(Object.assign({ ok: false, error: msg }, body.action === 'auth' ? { need: 'password' } : {}));
  }

  // ---------- вход ----------
  if (body.action === 'auth') {
    let uid = 0, from = null;
    if (body.initData) {
      uid = svc.checkInitData(body.initData);
      if (uid) from = initUser(body.initData);
    }
    if (!uid && body.tk) uid = svc.readToken(body.tk);
    let row = uid ? svc.userRow(g, uid) : null;

    if (uid && !row) {                                   // первый вход из Telegram — нужен пароль
      if (!body.password) return res.status(200).json({ ok: false, need: 'password', error: 'Пришлите пароль — доступ закрытый' });
      if (body.password !== g.password) return res.status(200).json({ ok: false, need: 'password', error: 'Пароль не подошёл' });
      const r = await svc.linkUser(g, from || { id: uid }, (from && from.id) || uid);
      row = r.row;
    }
    if (!uid) {                                          // браузер без Telegram: только владелец по паролю
      if (body.password && body.password === g.password && g.adminUid) uid = g.adminUid;
      else return res.status(200).json({ ok: false, need: 'password', error: g.adminUid ? 'Откройте панель кнопкой в боте — так я узнаю, кто вы' : 'Сначала подключитесь в Telegram-боте' });
      row = svc.userRow(g, uid);
    }
    if (row && row.blocked) return res.status(200).json({ ok: false, error: 'Доступ закрыт владельцем' });
    const u = await store.loadOrCreate(uid, (row && row.chat) || uid);
    svc.bind(g, u);
    await store.saveUser(u);
    return res.status(200).json({ ok: true, token: svc.mkToken(uid), uid, admin: svc.isAdmin(g, uid) });
  }

  const uid = svc.readToken(req.headers['x-auth']);
  if (!uid) return res.status(401).json({ ok: false, error: 'auth' });
  const row = svc.userRow(g, uid);
  if (!row || row.blocked) return res.status(401).json({ ok: false, error: 'auth' });
  const u = await store.loadUser(uid);
  if (!u) return res.status(401).json({ ok: false, error: 'auth' });
  svc.bind(g, u);
  const admin = svc.isAdmin(g, uid);
  const H = () => svc.findHunt(u, body.huntId || body.id);

  try {
    switch (body.action) {
      case 'state': {
        const bts = await chain.beats().catch(() => ({}));
        const live = chain.aliveList(bts);
        if (!live.length) {
          const started = await svc.kick(req, u);
          if (started.length) store.log(u, 'Поднимаю фоновый поиск');
        }
        for (const h of u.hunts) if (h.active) L.rollDays(h, Date.now());
        svc.touch(g, uid);
        await store.saveGlobal(g);
        await store.saveUser(u);
        return res.status(200).json({
          ok: true,
          me: { uid, name: u.name, u: u.u, admin },
          botOn: g.botOn !== false,
          maxHunts: store.MAX_HUNTS, maxContacts: store.MAX_CONTACTS, intervals: store.IVS,
          contacts: u.contacts || [],
          hunts: u.hunts.map(h => huntView(u, h)),
          bg: live.length > 0, strands: live,
          lastTick: u.lastTick || 0,
          banLeft: Math.ceil(alt.banLeft() / 1000),
          users: (g.users || []).length,
          log: (u.log || []).slice(0, 60)
        });
      }

      case 'saveHunt': {
        const h = H();
        const changed = svc.patchHunt(u, h, body.patch || {});
        if (changed && h.active) store.log(u, `${hunt.label(h)}: план изменён — ловлю уже по-новому`);
        await store.saveUser(u);
        return res.status(200).json({ ok: true, hunt: huntView(u, h) });
      }
      case 'addHunt': {
        const r = svc.addHunt(u);
        if (r.ok) await store.saveUser(u);
        return res.status(200).json(r.ok ? { ok: true, id: r.h.id } : { ok: false, error: r.why });
      }
      case 'removeHunt': {
        const r = svc.removeHunt(u, body.id);
        if (r.ok) await store.saveUser(u);
        return res.status(200).json(r.ok ? { ok: true } : { ok: false, error: r.why });
      }
      case 'start': {
        const h = H();
        if (body.patch) svc.patchHunt(u, h, body.patch);
        const r = await svc.startHunt(u, g, h, req, 'панель');
        return res.status(200).json(r.ok ? { ok: true, bg: r.bg } : { ok: false, error: r.why });
      }
      case 'stop': {
        const h = H();
        await svc.stopHunt(u, g, h, req, 'панель');
        return res.status(200).json({ ok: true });
      }
      case 'contacts': {
        svc.setContacts(u, body.list);
        store.log(u, 'Список контактов обновлён');
        await store.saveUser(u);
        return res.status(200).json({ ok: true, contacts: u.contacts });
      }
      case 'cancelBooking': {
        const r = await hunt.doCancel(u, body.id);
        if (r.ok) {
          await hunt.sendTo(u, `↩️ <b>Бронь отменена</b>\n${hunt.courtTitle(r.b, r.b.name)} · ${L.whenText(r.b.start, 60)}\nСлот снова свободен на сайте.`);
          await hunt.alertAdmin(u, `↩️ <b>${hunt.who(u)}</b> отменил: ${hunt.courtTitle(r.b, r.b.name)} · ${L.whenText(r.b.start, 60)}`);
        }
        await store.saveUser(u);
        return res.status(200).json(r.ok ? { ok: true } : { ok: false, error: r.why });
      }
      case 'takeOffer': {
        const r = await hunt.takeOffer(u, body.id);
        await store.saveUser(u);
        return res.status(200).json(r.ok ? { ok: true } : { ok: false, error: r.why });
      }
      case 'skipOffer': {
        hunt.dropOffer(u, body.id);
        await store.saveUser(u);
        return res.status(200).json({ ok: true });
      }
      case 'check': {
        const h = H();
        const r = await hunt.sweep(u, h);
        await hunt.noteResult(u, h, r);
        await store.saveUser(u);
        return res.status(200).json({ ok: true, result: r });
      }
      case 'reset': {
        const h = H();
        svc.sanitize(u, h);
        h.bookings = [];
        h.stats = { checks: 0, found: 0, booked: 0, errors: 0 };
        store.log(u, `${hunt.label(h)}: данные о бронях и вариантах очищены`);
        await store.saveUser(u);
        return res.status(200).json({ ok: true });
      }
      case 'probe': {
        const out = { tg: !!process.env.TELEGRAM_TOKEN, chat: !!u.chat, kv: store.live, users: (g.users || []).length };
        try {
          const list = await hunt.ensureTargets(u);
          out.altegio = true;
          out.courts = list.length;
          out.matching = list.filter(x => L.courtOk(u.hunts[0], x)).length;
        } catch (e) { out.altegio = false; out.error = e.message; }
        await store.saveUser(u);
        return res.status(200).json({ ok: true, probe: out });
      }

      // ---------- админ ----------
      case 'admin': {
        if (!admin) return res.status(403).json({ ok: false, error: 'Только для владельца' });
        const users = await store.loadUsers(g.users || []);
        return res.status(200).json({
          ok: true, botOn: g.botOn !== false, password: g.password,
          list: (g.users || []).map(r => {
            const x = users.find(y => y.uid === r.uid);
            return {
              uid: r.uid, name: r.name, u: r.u, at: r.at, last: r.last, acts: r.acts || 0, blocked: !!r.blocked,
              contacts: x ? (x.contacts || []).map(c => ({ name: c.name, phone: c.phone })) : [],
              hunts: x ? x.hunts.map(h => ({
                id: h.id, label: hunt.label(h), active: !!h.active,
                booked: hunt.bookedSlots(h), goal: hunt.goalSlots(h),
                days: h.days, timeFrom: h.timeFrom, timeTo: h.timeTo, interval: h.interval, mode: h.mode,
                bookings: hunt.activeBookings(h).map(bookView)
              })) : []
            };
          })
        });
      }
      case 'adminStop': {
        if (!admin) return res.status(403).json({ ok: false, error: 'Только для владельца' });
        const t = await store.loadUser(body.uid);
        if (!t) return res.status(200).json({ ok: false, error: 'Пользователь не найден' });
        svc.bind(g, t);
        for (const h of t.hunts) if (!body.huntId || h.id === body.huntId) {
          if (h.active) { h.active = false; store.log(t, `${hunt.label(h)}: остановлена владельцем`, 1); }
        }
        await store.saveUser(t);
        await hunt.sendTo(t, '⏹ Владелец остановил охоту.');
        return res.status(200).json({ ok: true });
      }
      case 'adminBlock': {
        if (!admin) return res.status(403).json({ ok: false, error: 'Только для владельца' });
        const r2 = svc.userRow(g, body.uid);
        if (!r2 || r2.uid === g.adminUid) return res.status(200).json({ ok: false, error: 'Так нельзя' });
        r2.blocked = !!body.on;
        await store.saveGlobal(g);
        const t = await store.loadUser(body.uid);
        if (t) {
          svc.bind(g, t);
          if (r2.blocked) for (const h of t.hunts) h.active = false;
          await store.saveUser(t);
          await hunt.sendTo(t, r2.blocked ? '🚪 Доступ к боту закрыт владельцем.' : '🔓 Доступ снова открыт — /menu');
        }
        return res.status(200).json({ ok: true });
      }
      case 'botOn': {
        if (!admin) return res.status(403).json({ ok: false, error: 'Только для владельца' });
        g.botOn = !!body.on;
        store.log(g, g.botOn ? 'Владелец включил бота' : 'Владелец выключил бота');
        await store.saveGlobal(g);
        if (!g.botOn) {
          const users = await store.loadUsers(g.users || []);
          for (const t of users) { for (const h of t.hunts) h.active = false; await store.saveUser(t); }
          await chain.drop();
        }
        return res.status(200).json({ ok: true });
      }
      case 'setPassword': {
        if (!admin) return res.status(403).json({ ok: false, error: 'Только для владельца' });
        const pw = String(body.password || '');
        if (pw.length < 6) return res.status(200).json({ ok: false, error: 'От 6 символов' });
        g.password = pw;
        store.log(g, 'Пароль обновлён владельцем');
        await store.saveGlobal(g);
        return res.status(200).json({ ok: true });
      }

      default:
        return res.status(400).json({ ok: false, error: 'unknown action' });
    }
  } catch (e) {
    store.log(u, 'Сбой панели: ' + e.message, 1);
    await store.saveUser(u).catch(() => {});
    return res.status(500).json({ ok: false, error: e.message });
  }
};
