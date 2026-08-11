// Диагностика: /api/diag?key=TICK_KEY — что реально отдаёт сайт кортов и что видит бот.
const store = require('../lib/store');
const svc = require('../lib/svc');
const alt = require('../lib/altegio');
const hunt = require('../lib/hunt');
const chain = require('../lib/chain');
const L = require('../lib/logic');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const q = req.query || {};
  if (!q.key || q.key !== process.env.TICK_KEY) return res.status(401).json({ ok: false, error: 'bad key' });

  const g = await store.loadGlobal();
  const users = await store.loadUsers(g.users || []);
  const bts = await chain.beats().catch(() => ({}));
  const age = k => (bts[k] && bts[k].at) ? Math.round((Date.now() - bts[k].at) / 1000) + ' с назад' : 'молчит';

  const out = {
    время: L.fmt(Date.now()),
    ключ_задан: !!process.env.ALTEGIO_AUTH,
    company_id: alt.CID,
    базы_api: alt.BASES,
    бот_включён: g.botOn !== false,
    владелец_uid: g.adminUid,
    лимит_сайта: alt.banned() ? `активен, ещё ${Math.ceil(alt.banLeft() / 1000)} с` : 'нет',
    фоновый_поиск: {
      живые_ветки: chain.aliveList(bts),
      ветка_A: age('a'), ветка_B: age('b'),
      app_url: (process.env.APP_URL || '').trim() || 'НЕ ЗАДАН — самовызовы не работают',
      пингер: 'ожидается вызов /api/tick?key=… раз в минуту'
    },
    пользователи: users.map(u => ({
      uid: u.uid, кто: `${u.name || ''}${u.u ? ' @' + u.u : ''}`,
      контактов: (u.contacts || []).filter(c => c.name && c.phone).length,
      последняя_проверка: u.lastTick ? L.fmt(u.lastTick) : 'не было',
      сбоев_подряд: (u.bo && u.bo.fails) || 0,
      охоты: u.hunts.map(h => ({
        id: h.id, активна: !!h.active, дни: h.days, окно: `${h.timeFrom}–${h.timeTo}`,
        нужно_на_день: h.needed, тип: h.type, номера: h.courts, режим: h.mode, частота_сек: h.interval,
        поймано: `${hunt.bookedSlots(h)}/${hunt.goalSlots(h)}`,
        проверок: h.stats.checks, находок: h.stats.found, сбоев: h.stats.errors
      }))
    })),
    шаги: []
  };

  const u = users.find(x => x.uid === g.adminUid) || users[0];
  if (!u) { out.подсказка = 'Ни один пользователь не подключён — пришлите боту пароль.'; return res.status(200).json(out); }
  svc.bind(g, u);
  const h = u.hunts.find(x => x.active) || u.hunts[0];

  for (const b of alt.BASES) {
    const j = await alt.getStaff(b).catch(e => ({ success: false, raw: e.message }));
    out.шаги.push({
      запрос: `book_staff @ ${b}`, статус: j._status, success: !!j.success,
      сотрудников: Array.isArray(j.data) ? j.data.length : 0,
      имена: Array.isArray(j.data) ? j.data.slice(0, 15).map(x => `${x.name} (id ${x.id})`) : undefined,
      ответ: j.success ? undefined : String(JSON.stringify(j.meta || j.raw || '')).slice(0, 200)
    });
    if (j.success && Array.isArray(j.data) && j.data.length) { u.apiBase = b; break; }
  }

  const svcAll = await alt.getServices(0, u.apiBase);
  const svcList = (svcAll.data && (svcAll.data.services || svcAll.data)) || [];
  out.шаги.push({
    запрос: 'book_services (все)', статус: svcAll._status, success: !!svcAll.success,
    услуг: Array.isArray(svcList) ? svcList.length : 0,
    названия: Array.isArray(svcList) ? svcList.slice(0, 20).map(x => `${x.title} · ${Math.round((x.session_length || x.seance_length || 0) / 60) || '?'} мин · ${x.price_min || x.price_max || '?'} ₸ (id ${x.id})`) : undefined
  });

  try {
    const targets = await hunt.ensureTargets(u);
    out.корты_как_видит_бот = targets.map(t =>
      `${hunt.courtTitle(t, t.name)} ← "${t.name}" · ${t.indoor === true ? 'крытый' : t.indoor === false ? 'открытый' : 'тип неизвестен'} · staff ${t.staffId}`);
    out.всего_кортов = targets.length;
    out.подходит_под_фильтр = targets.filter(t => L.courtOk(h, t)).length;

    const dates = L.taskDates(h, Date.now());
    out.дни_охоты = dates.map(d => d.iso + (d.carry ? ' (ночные слоты)' : ''));
    out.расписание = [];
    for (const t of targets.filter(x => L.courtOk(h, x)).slice(0, 3)) {
      const sv = hunt.pickService(t.services, t.indoor);
      const d = dates[0] ? dates[0].iso : L.localISODate(Date.now());
      const j = await alt.getTimes(t.staffId, d, sv && sv.id, u.apiBase);
      const times = Array.isArray(j.data) ? j.data.map(x => L.normTime(x.time) || x.datetime) : [];
      out.расписание.push({
        корт: hunt.courtTitle(t, t.name), дата: d,
        услуга: sv ? `${sv.title} (id ${sv.id})` : 'нет',
        статус: j._status, success: !!j.success,
        свободных_слотов: times.length, слоты: times.slice(0, 24),
        подходят_под_окно: times.filter(x => {
          const ms = Date.parse(`${d}T${x}:00+${String(Number(process.env.TZ_OFFSET) || 5).padStart(2, '0')}:00`);
          return ms && L.slotMatches(h, dates.find(e => e.iso === d) || { carry: 0 }, ms, Date.now());
        }),
        ответ: j.success ? undefined : String(JSON.stringify(j.meta || j.raw || '')).slice(0, 200)
      });
    }
  } catch (e) { out.ошибка_разбора = e.message; }

  out.подсказка = 'Смотрите «подходят_под_окно». Пусто при непустых «слоты» — окно старта не совпадает: расширьте его или добавьте день.';
  await store.saveUser(u);
  return res.status(200).json(out);
};
