// Ядро охоты под реальную схему Daulet Tennis (Altegio):
//  • корты = «сотрудники»: «Корт 1…8» — крытые, «Корт №1…№5» — открытые;
//    тип определяется НЕ названием, а услугой («Аренда крытого/открытого корта»);
//  • услуги только часовые → 2 и 3 часа = несколько подряд идущих часов, несколько записей;
//  • время в API приходит как "0:00" — нормализуем;
//  • «стенки» и корты без услуг не бронируются.
const alt = require('./altegio');
const tg = require('./tg');
const L = require('./logic');
const { log } = require('./store');

const CACHE_TTL = 3 * 3600e3;
const CACHE_VER = 9;   // ↑ при изменении логики разбора кортов — сбрасывает старый кэш
const COMBO_CAP = Number(process.env.COMBO_CAP || 10);
const HUNT_TTL = Number(process.env.HUNT_TTL_H || 12) * 3600e3;   // 12 часов поиска — и стоп

// ---------- обнаружение кортов ----------
async function ensureTargets(s) {
  if (s.targets && s.targets.v === CACHE_VER && Date.now() - s.targets.ts < CACHE_TTL && s.apiBase) return s.targets.list;
  s.svcCache = null;   // услуги перечитываем вместе с кортами

  let staffRaw = null, lastErr = '';
  const bases = s.apiBase ? [s.apiBase, ...alt.BASES.filter(b => b !== s.apiBase)] : alt.BASES;
  for (const b of bases) {
    const j = await alt.getStaff(b).catch(e => ({ success: false, raw: e.message }));
    if (j.success && Array.isArray(j.data) && j.data.length) {
      if (s.apiBase !== b) { s.apiBase = b; log(s, `Подключился к сайту кортов (${b})`); }
      staffRaw = j.data; break;
    }
    lastErr = `HTTP ${j._status} ${JSON.stringify(j.meta || j.raw || '').slice(0, 110)}`;
  }
  if (!staffRaw) throw new Error(`сайт кортов не отвечает (${lastErr}). Похоже, устарел ключ ALTEGIO_AUTH — снимите заново из DevTools`);

  const list = [];
  for (const x of staffRaw) {
    const name = String(x.name || '');
    if (/стенк|стена|wall|пляж|песк|beach/i.test(name)) continue;   // стенки и пляжный теннис — не наши корты
    const id = Number(x.id);
    const services = await servicesFor(s, id);
    if (!services.length) continue;                                 // без услуги забронировать нельзя
    const hasIn = services.some(v => /крыт/i.test(v.title));
    const hasOut = services.some(v => /откр|улич/i.test(v.title));
    // тип из услуги; если не ясно — «Корт №N» (с решёткой) у Даулета открытый, «Корт N» крытый
    const indoor = hasIn && !hasOut ? true : hasOut && !hasIn ? false : !/№/.test(name);
    list.push({ staffId: id, court: L.parseCourt(name).court, indoor, name, services });
  }
  if (!list.length) throw new Error('сайт ответил, но кортов с услугами нет — проверьте COMPANY_ID и ключ');
  s.targets = { ts: Date.now(), v: CACHE_VER, list };
  const inC = list.filter(x => x.indoor === true).length, outC = list.filter(x => x.indoor === false).length;
  log(s, `Кортов на сайте: ${list.length} (крытых ${inC}, открытых ${outC})`);
  return list;
}

async function servicesFor(s, staffId) {
  s.svcCache = s.svcCache && Date.now() - s.svcCache.ts < CACHE_TTL ? s.svcCache : { ts: Date.now(), byStaff: {} };
  const key = String(staffId || 0);
  if (s.svcCache.byStaff[key]) return s.svcCache.byStaff[key];
  const j = await alt.getServices(staffId || 0, s.apiBase);
  const raw = (j.data && (j.data.services || j.data)) || [];
  const list = (Array.isArray(raw) ? raw : []).map(x => ({
    id: Number(x.id), title: x.title || '',
    len: Number(x.session_length || x.seance_length || x.duration || 0) / 60 || null,
    price: x.price_min || x.price_max || null
  }));
  s.svcCache.byStaff[key] = list;
  return list;
}

// Часовая аренда: одна услуга на корт. Обязательно та, что совпадает с типом корта.
const pickService = (services, durMin, indoor) => {
  if (!services || !services.length) return null;
  const byType = indoor === true ? services.filter(x => /крыт/i.test(x.title))
    : indoor === false ? services.filter(x => /откр|улич/i.test(x.title)) : services;
  const pool = byType.length ? byType : services;
  return pool.find(x => x.len === 60) || pool[0];
};

const activeBookings = s => s.bookings.filter(b => !b.cancelled && b.start > Date.now() - 3600e3);
const bookHours = b => Math.max(1, Math.round((b.dur || 60) / 60));
const perDayHours = s => Math.max(1, s.task.needed) * Math.max(1, Math.round((s.task.dur || 60) / 60));

// К какому дню плана относится слот: ночные 00:00/01:00 — это вечер предыдущего дня
function planDay(t, startMs) {
  const mins = L.parseHM(L.hm(startMs));
  const fromM = L.parseHM(t.timeFrom || '20:00'), toM = L.parseHM(t.timeTo || '22:00');
  if (mins < fromM && mins + 1440 <= toM) return L.localISODate(startMs - 86400e3);
  return L.localISODate(startMs);
}

// Цель считается ПО КАЖДОМУ выбранному дню: выбрали 3 дня × «нужно 1» = минимум 3 брони,
// поймали на сегодня — ищу дальше на завтра и послезавтра.
function dayPlan(s, nowMs) {
  const t = s.task, now = nowMs || Date.now();
  const need = perDayHours(s);
  const days = L.taskDates(t, now).filter(d => !d.carry).map(d => ({ iso: d.iso, need, got: 0 }));
  for (const b of activeBookings(s)) {
    const d = days.find(x => x.iso === planDay(t, b.start));
    if (d) d.got += bookHours(b);
  }
  return days;
}
const goalHours = s => dayPlan(s).reduce((n, d) => n + d.need, 0);
const bookedHours = s => dayPlan(s).reduce((n, d) => n + Math.min(d.need, d.got), 0);
const leftHours = s => dayPlan(s).reduce((n, d) => n + Math.max(0, d.need - d.got), 0);
const leftForDay = (s, iso) => {
  const d = dayPlan(s).find(x => x.iso === iso);
  return d ? Math.max(0, d.need - d.got) : 0;
};

// Фактическая пауза между проверками: выбранная частота + автоторможение, если сайт сбоит
function pace(s) {
  const base = Math.max(5, Math.min(60, Number((s.task && s.task.interval) || 10))) * 1000;
  const f = (s.bo && s.bo.fails) || 0;
  return f >= 6 ? 60000 : f >= 3 ? 30000 : base;
}

async function noteResult(s, r) {
  s.bo = s.bo || { fails: 0 };
  if (r && r.apiOk) {
    if (s.bo.fails >= 3) log(s, 'Сайт снова отвечает — вернулся к обычной частоте');
    s.bo.fails = 0;
    return;
  }
  if (!r || (!r.apiFail && !r.error)) return;
  s.bo.fails++;
  if (s.bo.fails === 3) {
    log(s, 'Сайт кортов не отвечает — притормозил до 30 с', 1);
    await notifyError(s, 'Сайт кортов не отвечает. Продолжаю пробовать, пока реже (раз в 30 с) — как ответит, вернусь к обычной частоте.');
  }
  if (s.bo.fails === 6) log(s, 'Сайт всё ещё молчит — проверяю раз в 60 с', 1);
}

const huntAge = s => s.stats.startedAt ? Date.now() - s.stats.startedAt : 0;
const expired = s => !!(s.task.active && s.stats.startedAt && huntAge(s) >= HUNT_TTL);

// Единственные причины остановки: цель набрана · 12 часов поиска · отмена вручную
async function autoStop(s) {
  if (!s.task.active) return true;
  if (leftHours(s) <= 0) { await finishTask(s); return true; }
  if (expired(s)) {
    s.task.active = false;
    log(s, 'Прошло 12 часов поиска — охота остановлена', 1);
    await sendAll(s, '⌛ <b>12 часов поиска — останавливаюсь</b>\nПод ваш план ничего не освободилось. Запустите охоту снова или ослабьте фильтр: добавьте дни, расширьте окно, разрешите любой тип корта.');
    return true;
  }
  return false;
}

function courtTitle(meta, name) {
  if (meta && meta.court != null) {
    const t = meta.indoor === false ? 'Открытый корт' : meta.indoor ? 'Крытый корт' : 'Корт';
    return `${t} №${meta.court}`;
  }
  return name || 'Корт';
}

// Сообщение во все подключённые чаты. Никогда не бросает: упавшая отправка не должна ломать охоту.
async function sendAll(s, text, extra) {
  const chats = s.chats || [];
  if (!chats.length) { log(s, 'Telegram не подключён — сообщение отправлять некому', 1); return { ok: 0, fail: 0 }; }
  let ok = 0, fail = 0;
  for (const c of chats) {
    const id = c.id || c;
    let j;
    try { j = await tg.send(id, text, extra || {}); }
    catch (e) { j = { ok: false, description: e.message }; }
    if (j && j.ok) ok++;
    else { fail++; log(s, `Сообщение в Telegram не ушло (${c.name || id}): ${(j && j.description) || '?'}`, 1); }
  }
  return { ok, fail };
}

// ---------- один проход охоты ----------
async function sweep(s) {
  const t = s.task;
  if (!t.active) return { skipped: 'off' };
  s.stats.checks++;
  const now = Date.now();
  const remaining = () => leftHours(s);
  if (remaining() <= 0) return finishTask(s);

  let targets;
  try { targets = await ensureTargets(s); }
  catch (e) { s.stats.errors++; log(s, 'Сбой: ' + e.message, 1); await notifyError(s, e.message); return { error: e.message }; }

  const courts = targets.filter(m => L.courtOk(t, m));
  if (!courts.length) { log(s, `Под фильтр не подходит ни один корт (всего ${targets.length}) — ослабьте фильтр`, 1); return { error: 'no courts' }; }
  const dates = L.taskDates(t, now);

  const combos = [];
  for (const d of dates) for (const c of courts) combos.push({ d, c });
  const start = s.rot % combos.length;
  const batch = [];
  for (let i = 0; i < Math.min(COMBO_CAP, combos.length); i++) batch.push(combos[(start + i) % combos.length]);
  s.rot = (start + batch.length) % combos.length;

  const wantHours = Math.max(1, Math.round(t.dur / 60));
  const leftBy = {};                                  // сколько часов ещё нужно по каждому дню плана
  for (const d of dayPlan(s, now)) leftBy[d.iso] = Math.max(0, d.need - d.got);
  const foundNew = [];
  let apiOk = 0, apiFail = 0;
  for (const { d, c } of batch) {
    const svc = pickService(c.services, t.dur, c.indoor);
    const j = await alt.getTimes(c.staffId, d.iso, svc && svc.id, s.apiBase);
    if (!j.success || !Array.isArray(j.data)) { apiFail++; continue; }
    apiOk++;

    // все свободные старты этого дня, в мс
    const tzo = `+0${Number(process.env.TZ_OFFSET) || 5}:00`;
    const raw = new Map();
    for (const slot of j.data) {
      const hm = L.normTime(slot.time);
      const ms = slot.datetime ? Date.parse(slot.datetime) : (hm ? Date.parse(`${d.iso}T${hm}:00${tzo}`) : NaN);
      if (ms) raw.set(ms, slot.datetime || null);
    }
    const free = [...raw.keys()].sort((a, b) => a - b);
    const freeSet = new Set(free);

    for (const startMs of free) {
      if (!L.slotMatches(t, d, startMs, now)) continue;
      const pd = planDay(t, startMs);
      if (!(leftBy[pd] > 0)) continue;                 // на этот день нужное уже поймано
      // сколько часов подряд свободно от этого старта
      let run = 1;
      while (run < wantHours && freeSet.has(startMs + run * 3600e3)) run++;
      // целый блок — идеально; иначе один час, если разрешено набирать по частям
      let takeH = run >= wantHours ? wantHours : (t.split !== false ? 1 : 0);
      takeH = Math.min(takeH, leftBy[pd]);
      if (!takeH) continue;
      const key = L.slotKey(c.staffId, startMs);
      if (s.seen[key]) continue;
      if (s.bookings.some(b => !b.cancelled && b.staffId === c.staffId && b.start === startMs)) continue;
      s.seen[key] = Date.now();
      s.stats.found++;
      foundNew.push({ target: c, svc, startMs, key, raw: raw.get(startMs) || null, hours: takeH });
    }
  }
  if (!apiOk && apiFail) { s.stats.errors++; log(s, `Расписание не отдалось ни по одному корту (${apiFail} попыток) — вероятно, устарел ключ`, 1); }

  let asked = 0;
  for (const f of foundNew) {
    const pd = planDay(t, f.startMs);
    const left = leftBy[pd] || 0;
    if (left <= 0) continue;
    const hrs = Math.min(f.hours || 1, left);
    if (t.mode === 'auto') {
      const r = await doBook(s, f.target.staffId, f.svc && f.svc.id, f.startMs, f.raw, hrs * 60);
      if (r && r.ok) leftBy[pd] = Math.max(0, left - hrs);
    }
    else if (asked < 4) { await offerSlot(s, f, hrs * 60); asked++; }
  }
  if (!foundNew.length) log(s, `Проверка №${s.stats.checks}: свободного нет, слежу дальше`);
  if (remaining() <= 0) await finishTask(s);
  await reminders(s);
  return { found: foundNew.length, courts: courts.length, apiOk, apiFail };
}

// ---------- предложение (режим «спросить меня») ----------
async function offerSlot(s, f, durMin) {
  const c = f.target;
  const dur = durMin || s.task.dur;
  const hrs = Math.max(1, Math.round(dur / 60));
  const o = {
    id: Math.random().toString(36).slice(2, 9),
    staffId: c.staffId, serviceId: f.svc ? f.svc.id : null, raw: f.raw || null,
    court: c.court, indoor: c.indoor, name: c.name,
    start: f.startMs, dur,
    price: f.svc && f.svc.price ? f.svc.price * hrs : null
  };
  s.offers = [o, ...(s.offers || [])].slice(0, 12);
  const title = courtTitle(c, c.name);
  await sendAll(s,
    `🔔 <b>Освободился корт</b>\n${title} · ${L.whenText(o.start, o.dur)}${L.midnightNote(o.start)}\n` +
    (o.price ? `${o.price} ₸ · оплата на месте\n` : '') +
    `Забираем, пока не увели? 👇`,
    { reply_markup: { inline_keyboard: [[
      { text: `🎾 Забрать ${L.hm(o.start)}`, callback_data: `b|${o.id}` },
      { text: '✖️ Пропустить', callback_data: `sk|${o.id}` }
    ]] } });
  log(s, `Нашёл: ${title}, ${L.whenText(o.start, o.dur)} — жду решения`);
}

const findOffer = (s, id) => (s.offers || []).find(o => o.id === id);
function dropOffer(s, id) { s.offers = (s.offers || []).filter(o => o.id !== id); }

// ---------- бронирование (несколько часов = несколько записей) ----------
async function doBook(s, staffId, serviceId, startMs, rawDatetime, durMin) {
  const t = s.task;
  const dur = durMin || t.dur;
  const targets = (s.targets && s.targets.list) || [];
  const target = targets.find(x => x.staffId === Number(staffId)) || { staffId, name: '', court: null, indoor: null, services: [] };
  const svc = (target.services || []).find(x => x.id === Number(serviceId))
    || pickService(target.services, t.dur, target.indoor);
  const title = courtTitle(target, target.name);
  const hours = Math.max(1, Math.round(dur / 60));
  const parts = [];

  for (let k = 0; k < hours; k++) {
    const ms = startMs + k * 3600e3;
    // Altegio ждёт время салона (+05:00), не UTC. Для первого часа берём строку прямо из расписания.
    const iso = (k === 0 && rawDatetime) ? rawDatetime : L.isoLocal(ms);
    const j = await alt.book({
      phone: s.profile.phone, fullname: s.profile.name, email: s.profile.email,
      staffId: Number(staffId), serviceId: svc ? svc.id : null, datetime: iso,
      comment: 'Бронь через Court Hunter'
    }, s.apiBase);
    if (!j.success) {
      const code = (j.meta && j.meta.code) || (Array.isArray(j.errors) && j.errors[0] && j.errors[0].code);
      const msg = String((j.meta && j.meta.message) || (j.data && j.data.message) || j.raw || '');
      const busy = j._status === 422 && (code === 433 || code === 437)
        || /not available at the selected time|уже занят|недоступ/i.test(msg);
      const taken = busy;
      if (!busy) s.stats.errors++;
      else s.seen[L.slotKey(staffId, ms)] = Date.now();
      const why = busy ? 'этот час уже заняли' : (msg || JSON.stringify(j.meta || j.data || '')).slice(0, 160);
      // если первый час уже сорвался — просто идём дальше; если сорвался второй — откатываем первый
      for (const p of parts) await alt.cancel(p.recordId, p.hash, s.apiBase).catch(() => {});
      log(s, `Бронь не прошла (${title}, ${L.whenText(startMs, dur)}): ${why}`, taken ? 0 : 1);
      if (!taken) await notifyError(s, `Бронь не прошла: ${title}, ${L.whenText(startMs, dur)}\n${why}`);
      return { ok: false, why: busy ? 'Не успели — этот час уже заняли' : why };
    }
    const rec = (Array.isArray(j.data) && j.data[0]) || j.data || {};
    const recordId = rec.record_id || rec.id || null;
    const hash = rec.record_hash || rec.hash || null;
    if (!recordId) {   // «успех» без номера записи — брони нет, фантом не создаём
      for (const p of parts) await alt.cancel(p.recordId, p.hash, s.apiBase).catch(() => {});
      s.stats.errors++;
      log(s, 'Сайт не вернул номер записи (' + title + ', ' + L.whenText(startMs, dur) + ') — брони нет', 1);
      return { ok: false, why: 'Сайт не подтвердил запись — попробуйте ещё раз' };
    }
    parts.push({ recordId, hash, start: ms });
  }

  const b = {
    id: Math.random().toString(36).slice(2, 9),
    recordId: parts[0].recordId, hash: parts[0].hash, parts,
    staffId: Number(staffId), court: target.court, indoor: target.indoor, name: target.name,
    start: startMs, dur,
    price: svc && svc.price ? svc.price * hours : null, service: svc && svc.title,
    cancelled: false, createdAt: Date.now()
  };
  s.bookings.push(b);
  s.stats.booked++;
  log(s, `Поймал! ${title}, ${L.whenText(startMs, dur)} ✅`);
  const done = leftHours(s) <= 0;
  if (done) t.active = false;
  const d = L.deadlines(startMs);
  const msg = `🎾 <b>Поймал корт!</b>\n` +
    `${title} · ${L.whenText(startMs, dur)}${L.midnightNote(startMs)}\n` +
    (b.price ? `${b.price} ₸${hours > 1 ? ` (${hours} ч)` : ''} · оплата на месте\n` : `Оплата на месте\n`) +
    `Записал на: ${s.profile.name || '—'}\n\n` +
    `Передумаете — отменить онлайн можно до ${L.hm(d.online)}, дальше только звонок на ресепшн (до ${L.hm(d.phone)}).\n` +
    `📍 Daulet Tennis, ул. Кордай, 6` +
    (done ? `\n\n🏁 Всё, цель набрана — охоту выключил.` : `\n\nОсталось поймать: ${leftHours(s)} ч${dayPlan(s).filter(x => x.got < x.need).length > 1 ? ' (по другим дням плана)' : ''}`);
  const sent = await sendAll(s, msg,
    { reply_markup: { inline_keyboard: [[{ text: '↩️ Отменить бронь', callback_data: `c|${b.id}` }]] } });
  b.notified = sent.ok > 0;
  if (!b.notified) b.notify = msg;                 // не ушло — повторю на следующем проходе
  return { ok: true, booking: b };
}

async function takeOffer(s, id) {
  const o = findOffer(s, id);
  if (!o) return { ok: false, why: 'Это предложение уже неактуально' };
  if (Date.now() > o.start - 10 * 60e3) { dropOffer(s, id); return { ok: false, why: 'Слот уже в прошлом' }; }
  if (leftForDay(s, planDay(s.task, o.start)) <= 0) { dropOffer(s, id); return { ok: false, why: 'На этот день нужное уже поймано' }; }
  const r = await doBook(s, o.staffId, o.serviceId, o.start, o.raw, o.dur);
  if (r.ok || /заняли|увели/i.test(r.why || '')) dropOffer(s, id);
  return r;
}

// ---------- отмена ----------
async function doCancel(s, bookingId) {
  const b = s.bookings.find(x => x.id === bookingId && !x.cancelled);
  if (!b) return { ok: false, why: 'Эта бронь уже отменена или не найдена' };
  const d = L.deadlines(b.start);
  if (Date.now() > d.online) {
    return { ok: false, why: Date.now() > d.phone
      ? 'Поздно: до игры меньше 3 часов, отмена закрыта'
      : `Онлайн-отмена закрыта. До ${L.hm(d.phone)} ещё можно отменить звонком на ресепшн.` };
  }
  const parts = b.parts && b.parts.length ? b.parts : [{ recordId: b.recordId, hash: b.hash }];
  let fail = 0;
  for (const p of parts) {
    if (!p.recordId || !p.hash) continue;
    const j = await alt.cancel(p.recordId, p.hash, s.apiBase);
    if (!j.success && j._status !== 204 && j._status !== 200) fail++;
  }
  if (fail === parts.length) {
    log(s, 'Сайт не принял отмену — отмените вручную', 1);
    return { ok: false, why: 'Сайт не принял отмену. Попробуйте на сайте или позвоните на корты.' };
  }
  b.cancelled = true;
  log(s, `Отменил бронь: ${courtTitle(b, b.name)}, ${L.whenText(b.start, b.dur)}${fail ? ' (часть часов пришлось бы отменить вручную)' : ''}`);
  return { ok: true, b, partial: fail > 0 };
}

// ---------- напоминания ----------
async function reminders(s) {
  const now = Date.now();
  for (const b of activeBookings(s)) {
    // если сообщение о брони не ушло (сеть/лимит Telegram) — повторяем, пока не дойдёт
    if (b.notified === false && b.notify) {
      const r = await sendAll(s, b.notify,
        { reply_markup: { inline_keyboard: [[{ text: '↩️ Отменить бронь', callback_data: `c|${b.id}` }]] } });
      if (r.ok > 0) { b.notified = true; delete b.notify; log(s, 'Сообщение о брони дошло со второй попытки'); }
    }
    const d = L.deadlines(b.start);
    if (!s.reminded[b.id] && now >= d.online - 65 * 60e3 && now < d.online) {
      s.reminded[b.id] = 1;
      await sendAll(s,
        `⏰ <b>Час до дедлайна отмены</b>\n` +
        `${courtTitle(b, b.name)} · ${L.whenText(b.start, b.dur)}${L.midnightNote(b.start)}\n` +
        `Онлайн-отмена закроется в ${L.hm(d.online)}. Дальше только ресепшн (до ${L.hm(d.phone)}).`,
        { reply_markup: { inline_keyboard: [[{ text: '↩️ Отменить бронь', callback_data: `c|${b.id}` }]] } });
    }
  }
}

async function notifyError(s, msg) {
  const now = Date.now();
  if (s.lastErrPing && now - s.lastErrPing < 30 * 60e3) return;
  s.lastErrPing = now;
  await sendAll(s, `😖 <b>Заминка</b>\n${String(msg).slice(0, 500)}`);
}

async function finishTask(s) {
  if (s.task.active) { s.task.active = false; log(s, 'Все корты пойманы — охота выключена 🏁'); }
  return { done: true };
}

function statusText(s) {
  const t = s.task;
  const act = activeBookings(s).sort((a, b) => a.start - b.start);
  const days = (t.dayOffsets && t.dayOffsets.length ? t.dayOffsets : [0, 1, 2]).map(o => ['сегодня', 'завтра', 'послезавтра'][o]).join(', ');
  const type = t.type === 'indoor' ? 'крытые' : t.type === 'outdoor' ? 'открытые' : 'любой тип';
  const nums = t.type !== 'any' && t.courts && t.courts.length ? ' №' + t.courts.join(', ') : '';
  const gh = goalHours(s), bh = bookedHours(s);
  const plan = dayPlan(s);
  let out = `${t.active ? '🟢 Охочусь' : '⚪ На паузе'} · поймано ${bh} из ${gh} ч${act.length ? ` (${act.length} брони)` : ''}\n`;
  if (plan.length > 1) out += `📆 ${plan.map(d => `${L.dayWord(Date.parse(d.iso + 'T12:00:00Z'))} ${Math.min(d.need, d.got)}/${d.need} ч`).join(' · ')}\n`;
  out += `🗓 ${days} · старты ${L.hourLabel(parseInt(t.timeFrom))}–${L.hourLabel(parseInt(t.timeTo))} · ${Math.round(t.dur / 60)} ч · нужно ${t.needed} на каждый день\n`;
  out += `🎾 ${type}${nums} · ${t.mode === 'auto' ? 'бронирую сразу' : 'сначала спрашиваю'}${t.split !== false ? ' · можно по частям' : ''}\n`;
  out += `⏱ Обновляю каждые ${Math.round(pace(s) / 1000)} с${(s.bo && s.bo.fails >= 3) ? ' (сайт барахлит — притормозил)' : ''}\n`;
  out += `🔁 Проверок ${s.stats.checks} · находок ${s.stats.found}${s.stats.errors ? ` · сбоев ${s.stats.errors}` : ''}`;
  if (s.targets && s.targets.list) out += `\n🏟 Кортов вижу: ${s.targets.list.length}`;
  if (t.active) {
    out += `\n📡 Фоновый поиск: ${s.chainAt && Date.now() - s.chainAt < 100e3 ? 'работает на сервере' : 'перезапускается'}`;
    const leftH = Math.max(0, Math.round((HUNT_TTL - huntAge(s)) / 3600e3));
    out += `\n⌛ Сам остановлюсь через ${leftH} ч, если ничего не поймаю`;
  }
  if (act.length) {
    out += '\n\n<b>Брони:</b>';
    for (const b of act) {
      const d = L.deadlines(b.start);
      out += `\n• ${courtTitle(b, b.name)} — ${L.whenText(b.start, b.dur)}${L.midnightNote(b.start)}\n  отмена: онлайн до ${L.hm(d.online)}, звонком до ${L.hm(d.phone)}`;
    }
  }
  return out;
}

// Предложения вне текущего фильтра — убрать
function pruneOffers(s) {
  const t = s.task, now = Date.now();
  const dates = L.taskDates(t, now);
  const before = (s.offers || []).length;
  s.offers = (s.offers || []).filter(o => {
    if (o.start < now + 10 * 60e3) return false;
    if (!L.courtOk(t, o)) return false;
    if (o.dur > t.dur) return false;
    const entry = dates.find(d => d.iso === L.localISODate(o.start));
    return entry ? L.slotMatches(t, entry, o.start, now) : false;
  });
  const dropped = before - s.offers.length;
  if (dropped) log(s, 'Убрал вариантов вне фильтра: ' + dropped);
  return dropped;
}

// Фантомы: «брони», которые сайт не подтверждал
function dropPhantoms(s) {
  const bad = s.bookings.filter(b => !b.cancelled && !b.recordId && !(b.parts && b.parts.some(p => p.recordId)));
  for (const b of bad) b.cancelled = true;
  if (bad.length) log(s, 'Убрал несуществующих броней: ' + bad.length, 1);
  return bad.length;
}

module.exports = { goalHours, bookedHours, leftHours, leftForDay, dayPlan, planDay, perDayHours, pace, noteResult, expired, autoStop, notifyError, HUNT_TTL, pruneOffers, dropPhantoms, sweep, doBook, doCancel, reminders, statusText, activeBookings, ensureTargets, courtTitle, sendAll, takeOffer, findOffer, dropOffer, pickService };
