// Диагностика: /api/diag?key=TICK_KEY — показывает, что реально отдаёт сайт кортов.
// Открывайте в браузере, когда кажется, что «бот ничего не находит».
const store = require('../lib/store');
const alt = require('../lib/altegio');
const hunt = require('../lib/hunt');
const L = require('../lib/logic');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const q = req.query || {};
  if (!q.key || q.key !== process.env.TICK_KEY) return res.status(401).json({ ok: false, error: 'bad key' });

  const s = await store.load();
  const out = {
    время: L.fmt(Date.now()),
    ключ_задан: !!process.env.ALTEGIO_AUTH,
    company_id: alt.CID,
    базы_api: alt.BASES,
    задание: s.task,
    подключено_чатов: (s.chats || []).length,
    шаги: []
  };

  // 1. Какая база отвечает и что в book_staff
  for (const b of alt.BASES) {
    const j = await alt.getStaff(b).catch(e => ({ success: false, raw: e.message }));
    out.шаги.push({
      запрос: `book_staff @ ${b}`, статус: j._status, success: !!j.success,
      сотрудников: Array.isArray(j.data) ? j.data.length : 0,
      имена: Array.isArray(j.data) ? j.data.slice(0, 15).map(x => `${x.name} (id ${x.id}${x.bookable === false ? ', bookable:false' : ''})`) : undefined,
      ответ: j.success ? undefined : String(JSON.stringify(j.meta || j.raw || '')).slice(0, 200)
    });
    if (j.success && Array.isArray(j.data) && j.data.length) { s.apiBase = b; break; }
  }

  // 2. Услуги (иногда корты живут именно здесь)
  const svc = await alt.getServices(0, s.apiBase);
  const svcList = (svc.data && (svc.data.services || svc.data)) || [];
  out.шаги.push({
    запрос: 'book_services (все)', статус: svc._status, success: !!svc.success,
    услуг: Array.isArray(svcList) ? svcList.length : 0,
    названия: Array.isArray(svcList) ? svcList.slice(0, 20).map(x => `${x.title} · ${Math.round((x.session_length || x.seance_length || 0) / 60) || '?'} мин · ${x.price_min || x.price_max || '?'} ₸ (id ${x.id})`) : undefined
  });

  // 3. Как бот видит корты после разбора названий
  try {
    const targets = await hunt.ensureTargets(s);
    out.корты_как_видит_бот = targets.map(t =>
      `${hunt.courtTitle(t, t.name)} ← "${t.name}" · ${t.indoor === true ? 'крытый' : t.indoor === false ? 'открытый' : 'тип неизвестен'} · staff ${t.staffId} · ${(t.services || []).map(v => v.title + ' / ' + (v.price || '?') + '₸').join(', ')}`);
    out.всего_кортов = targets.length;
    out.подходит_под_фильтр = targets.filter(t => L.courtOk(s.task, t)).length;

    // 4. Живое расписание по первым трём кортам на сегодня
    const dates = L.taskDates(s.task, Date.now());
    out.дни_задания = dates.map(d => d.iso + (d.midnightOnly ? ' (только 00:00)' : ''));
    out.расписание = [];
    for (const t of targets.slice(0, 3)) {
      const sv = hunt.pickService(t.services, s.task.dur);
      const d = dates[0] ? dates[0].iso : L.localISODate(Date.now());
      const j = await alt.getTimes(t.staffId, d, sv && sv.id, s.apiBase);
      const times = Array.isArray(j.data) ? j.data.map(x => L.normTime(x.time) || x.datetime) : [];
      out.расписание.push({
        корт: hunt.courtTitle(t, t.name), дата: d,
        услуга: sv ? `${sv.title} (id ${sv.id})` : 'нет',
        статус: j._status, success: !!j.success,
        свободных_слотов: times.length, слоты: times.slice(0, 24),
        подходят_под_окно: times.filter(x => {
          const ms = Date.parse(`${d}T${x}:00+0${Number(process.env.TZ_OFFSET) || 5}:00`);
          return ms && L.slotMatches(s.task, dates.find(e => e.iso === d) || { carry: 0 }, ms, Date.now());
        }),
        ответ: j.success ? undefined : String(JSON.stringify(j.meta || j.raw || '')).slice(0, 200)
      });
    }
  } catch (e) {
    out.ошибка_разбора = e.message;
  }

  out.подсказка = 'Смотрите «подходят_под_окно»: если слоты есть, а тут пусто — расширьте окно старта или добавьте дни. Для 2–3 часов нужны подряд идущие свободные часы.';
  await store.save(s);
  return res.status(200).json(out);
};
