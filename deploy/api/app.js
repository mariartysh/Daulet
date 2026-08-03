// API панели: логин по паролю, состояние, сохранение задания, старт/стоп,
// проверка подключения к Altegio, ручной проход охоты.
const crypto = require('crypto');
const store = require('../lib/store');
const hunt = require('../lib/hunt');
const alt = require('../lib/altegio');
const L = require('../lib/logic');

const token = pw => crypto.createHash('sha256').update(pw + '|' + (process.env.TICK_KEY || 'salt')).digest('hex');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ ok: false });
  const body = req.body || {};
  const s = await store.load();
  const authed = req.headers['x-auth'] && req.headers['x-auth'] === token(s.password);

  if (body.action === 'login') {
    if (body.password === s.password) return res.status(200).json({ ok: true, token: token(s.password) });
    return res.status(401).json({ ok: false, error: 'Неверный пароль' });
  }
  if (!authed) return res.status(401).json({ ok: false, error: 'auth' });

  try {
    switch (body.action) {
      case 'state': {
        const act = hunt.activeBookings(s).sort((a, b) => a.start - b.start);
        return res.status(200).json({
          ok: true,
          task: s.task, profile: s.profile, stats: s.stats,
          owner: !!s.ownerChat,
          courts: s.staffCache ? s.staffCache.list : [],
          bookings: act.map(b => {
            const d = L.deadlines(b.start);
            return { id: b.id, title: hunt.courtTitle(b, b.name), when: L.fmt(b.start), start: b.start,
              dur: b.dur, price: b.price, service: b.service,
              online: d.online, phone: d.phone, midnight: L.midnightNote(b.start) };
          }),
          log: s.log.slice(0, 60)
        });
      }
      case 'save': {
        if (body.task) s.task = { ...s.task, ...body.task, active: s.task.active };
        if (body.profile) s.profile = { ...s.profile, ...body.profile };
        store.log(s, 'Задание обновлено из панели');
        await store.save(s);
        return res.status(200).json({ ok: true });
      }
      case 'start': {
        if (!s.profile.phone || !s.profile.name) return res.status(200).json({ ok: false, error: 'Заполните имя и телефон' });
        if (hunt.activeBookings(s).length >= s.task.needed) return res.status(200).json({ ok: false, error: 'Цель уже достигнута' });
        s.task.active = true;
        s.stats.startedAt = Date.now();
        store.log(s, `Охота запущена: цель ${s.task.needed}, режим ${s.task.mode === 'auto' ? 'автобронь' : 'по кнопке'}`);
        await hunt.ownerSend(s, '🟢 Охота запущена из панели.\n' + hunt.statusText(s));
        await store.save(s);
        return res.status(200).json({ ok: true });
      }
      case 'stop': {
        s.task.active = false;
        store.log(s, 'Охота остановлена из панели');
        await store.save(s);
        return res.status(200).json({ ok: true });
      }
      case 'cancelBooking': {
        const r = await hunt.doCancel(s, body.id);
        if (r.ok) await hunt.ownerSend(s, `↩️ Бронь отменена из панели: ${hunt.courtTitle(r.b, r.b.name)} · ${L.fmt(r.b.start)}`);
        await store.save(s);
        return res.status(200).json(r.ok ? { ok: true } : { ok: false, error: r.why });
      }
      case 'probe': {
        const out = { tg: !!process.env.TELEGRAM_TOKEN, tgLinked: !!s.ownerChat, kv: !!process.env.UPSTASH_REDIS_REST_URL };
        try {
          const list = await hunt.ensureStaff(s);
          out.altegio = true;
          out.base = s.apiBase;
          out.courts = list.map(x => x.name);
        } catch (e) { out.altegio = false; out.error = e.message; }
        await store.save(s);
        return res.status(200).json({ ok: true, probe: out });
      }
      case 'check': {
        if (!s.task.active) return res.status(200).json({ ok: false, error: 'Задание выключено' });
        const r = await hunt.sweep(s);
        await store.save(s);
        return res.status(200).json({ ok: true, result: r });
      }
      default:
        return res.status(400).json({ ok: false, error: 'unknown action' });
    }
  } catch (e) {
    store.log(s, 'Ошибка панели: ' + e.message, 1);
    await store.save(s);
    return res.status(500).json({ ok: false, error: e.message });
  }
};
