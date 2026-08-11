// Ядро охоты (Daulet Tennis / Altegio).
//  • корты = «сотрудники»: «Корт 1…8» — крытые, «Корт №1…№5» — открытые;
//    тип определяется услугой («Аренда крытого/открытого корта»);
//  • единица брони — ОДИН час. Нужно два часа → ставим «2 корта»: бот возьмёт
//    два часа подряд, если они свободны, иначе два разных слота;
//  • массовая бронь: если на одно и то же время берём больше одного корта,
//    второй и следующие оформляются на других людей из списка контактов;
//  • у каждого пользователя свои охоты (до 3 одновременно), свои контакты и брони.
const alt = require('./altegio');
const tg = require('./tg');
const L = require('./logic');
const { log } = require('./store');

const CACHE_TTL = 3 * 3600e3;
const CACHE_VER = 11;
const COMBO_CAP = Number(process.env.COMBO_CAP || 24);
const HUNT_TTL = Number(process.env.HUNT_TTL_H || 12) * 3600e3;

// ---------- обнаружение кортов ----------
async function ensureTargets(u) {
  if (u.targets && u.targets.v === CACHE_VER && Date.now() - u.targets.ts < CACHE_TTL && u.apiBase) return u.targets.list;
  u.svcCache = null;

  let staffRaw = null, lastErr = '';
  const bases = u.apiBase ? [u.apiBase, ...alt.BASES.filter(b => b !== u.apiBase)] : alt.BASES;
  for (const b of bases) {
    const j = await alt.getStaff(b).catch(e => ({ success: false, raw: e.message }));
    if (j.success && Array.isArray(j.data) && j.data.length) {
      if (u.apiBase !== b) { u.apiBase = b; log(u, `Подключился к сайту кортов (${b})`); }
      staffRaw = j.data; break;
    }
    lastErr = `HTTP ${j._status} ${JSON.stringify(j.meta || j.raw || '').slice(0, 110)}`;
    if (j._ban) lastErr += ' — ключ отклонён или сработал лимит';
  }
  if (!staffRaw) throw new Error(`сайт кортов не отвечает (${lastErr}). Похоже, устарел ключ ALTEGIO_AUTH — снимите заново из DevTools`);

  const list = [];
  for (const x of staffRaw) {
    const name = String(x.name || '');
    if (/стенк|стена|wall|пляж|песк|beach/i.test(name)) continue;
    const id = Number(x.id);
    const services = await servicesFor(u, id);
    if (!services.length) continue;
    const hasIn = services.some(v => /крыт/i.test(v.title));
    const hasOut = services.some(v => /откр|улич/i.test(v.title));
    const indoor = hasIn && !hasOut ? true : hasOut && !hasIn ? false : !/№/.test(name);
    list.push({ staffId: id, court: L.parseCourt(name).court, indoor, name, services });
  }
  if (!list.length) throw new Error('сайт ответил, но кортов с услугами нет — проверьте COMPANY_ID и ключ');
  u.targets = { ts: Date.now(), v: CACHE_VER, list };
  const inC = list.filter(x => x.indoor === true).length, outC = list.filter(x => x.indoor === false).length;
  log(u, `Кортов на сайте: ${list.length} (крытых ${inC}, открытых ${outC})`);
  return list;
}

async function servicesFor(u, staffId) {
  u.svcCache = u.svcCache && Date.now() - u.svcCache.ts < CACHE_TTL ? u.svcCache : { ts: Date.now(), byStaff: {} };
  const key = String(staffId || 0);
  if (u.svcCache.byStaff[key]) return u.svcCache.byStaff[key];
  const j = await alt.getServices(staffId || 0, u.apiBase);
  const raw = (j.data && (j.data.services || j.data)) || [];
  const list = (Array.isArray(raw) ? raw : []).map(x => ({
    id: Number(x.id), title: x.title || '',
    len: Number(x.session_length || x.seance_length || x.duration || 0) / 60 || null,
    price: x.price_min || x.price_max || null
  }));
  u.svcCache.byStaff[key] = list;
  return list;
}

const pickService = (services, indoor) => {
  if (!services || !services.length) return null;
  const byType = indoor === true ? services.filter(x => /крыт/i.test(x.title))
    : indoor === false ? services.filter(x => /откр|улич/i.test(x.title)) : services;
  const pool = byType.length ? byType : services;
  return pool.find(x => x.len === 60) || pool[0];
};

// ---------- учёт цели (единица = один час) ----------
const activeBookings = h => (h.bookings || []).filter(b => !b.cancelled && b.start > Date.now() - 3600e3);
const allActiveBookings = u => u.hunts.flatMap(h => activeBookings(h).map(b => ({ b, h })));

function dayPlan(h, nowMs) {
  const now = nowMs || Date.now();
  const days = L.taskDates(h, now).filter(d => !d.carry)
    .map(d => ({ iso: d.iso, need: Math.max(1, h.needed), got: 0 }));
  for (const b of activeBookings(h)) {
    const d = days.find(x => x.iso === L.planDay(h, b.start));
    if (d) d.got++;
  }
  return days;
}
const goalSlots = h => dayPlan(h).reduce((n, d) => n + d.need, 0);
const bookedSlots = h => dayPlan(h).reduce((n, d) => n + Math.min(d.need, d.got), 0);
const leftSlots = h => dayPlan(h).reduce((n, d) => n + Math.max(0, d.need - d.got), 0);
const leftForDay = (h, iso) => {
  const d = dayPlan(h).find(x => x.iso === iso);
  return d ? Math.max(0, d.need - d.got) : 0;
};

// Фактическая пауза между проверками. Автозамедление при сбоях и бане.
function pace(u, h) {
  const base = Math.max(2, Math.min(60, Number((h && h.interval) || 3))) * 1000;
  if (alt.banned()) return Math.max(20000, alt.banLeft());
  const f = (u.bo && u.bo.fails) || 0;
  return f >= 6 ? 60000 : f >= 3 ? 30000 : base;
}

async function noteResult(u, h, r) {
  u.bo = u.bo || { fails: 0, ban: 0 };
  if (r && r.apiOk) {
    if (u.bo.fails >= 3) log(u, 'Сайт снова отвечает — вернулся к обычной частоте');
    u.bo.fails = 0;
    return;
  }
  if (!r || (!r.apiFail && !r.error)) return;
  u.bo.fails++;
  if (r.ban) {
    u.bo.ban = Date.now();
    log(u, `Сайт ответил ${r.ban} — сработал лимит или ключ не принят, притормозил`, 1);
    await notifyError(u, r.ban === 429
      ? 'Сайт включил ограничение по частоте (429). Автоматически сбавил темп и продолжаю — как отпустит, вернусь к выбранной частоте.'
      : `Сайт отклонил ключ (${r.ban}). Похоже, ALTEGIO_AUTH устарел — обновите его, иначе брони не пройдут.`, true);
    return;
  }
  if (u.bo.fails === 3) {
    log(u, 'Сайт кортов не отвечает — притормозил до 30 с', 1);
    await notifyError(u, 'Сайт кортов не отвечает. Продолжаю пробовать, пока реже (раз в 30 с).');
  }
  if (u.bo.fails === 6) log(u, 'Сайт всё ещё молчит — проверяю раз в 60 с', 1);
}

const huntAge = h => h.startedAt ? Date.now() - h.startedAt : 0;
const expired = h => !!(h.active && h.startedAt && huntAge(h) >= HUNT_TTL);

// Остановка только: цель набрана · все дни прошли · 12 часов · вручную
async function autoStop(u, h) {
  if (!h.active) return true;
  const dropped = L.rollDays(h, Date.now());
  if (dropped) log(u, `${label(h)}: день закончился — «завтра» стало «сегодня», план сдвинулся`);
  if (!h.days.length) {
    h.active = false;
    log(u, `${label(h)}: выбранные дни прошли — охота остановлена`, 1);
    await sendTo(u, `📅 <b>${label(h)}: дни прошли</b>\nВыберите новые дни и запустите снова.`);
    return true;
  }
  if (leftSlots(h) <= 0) { await finishHunt(u, h); return true; }
  if (expired(h)) {
    h.active = false;
    log(u, `${label(h)}: 12 часов поиска — остановлена`, 1);
    await sendTo(u, `⌛ <b>${label(h)}: 12 часов поиска</b>\nПод ваш план ничего не освободилось. Запустите снова или ослабьте фильтр: добавьте дни, расширьте окно, разрешите любой тип корта.`);
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

// Человеческое имя охоты
function label(h) {
  if (h.title) return h.title;
  const d = (h.days || []).map(x => L.isoWord(x)).join(', ');
  return `Охота ${d || '—'} ${parseInt(h.timeFrom)}–${parseInt(h.timeTo)}`;
}

// ---------- отправка ----------
async function sendTo(u, text, extra) {
  if (!u.chat) { log(u, 'Telegram не подключён — сообщение отправлять некому', 1); return { ok: 0 }; }
  let j;
  try { j = await tg.send(u.chat, text, extra || {}); }
  catch (e) { j = { ok: false, description: e.message }; }
  if (!j || !j.ok) { log(u, `Сообщение в Telegram не ушло: ${(j && j.description) || '?'}`, 1); return { ok: 0 }; }
  return { ok: 1 };
}
// Копия админу — только про ключевые события (поймал/сбой ключа)
async function alertAdmin(u, text) {
  const a = Number(u.adminChat || 0);
  if (!a || a === Number(u.chat)) return;
  try { await tg.send(a, text); } catch (e) {}
}
const who = u => `${u.name || 'без имени'}${u.u ? ' @' + u.u : ''}`;

// ---------- один проход охоты ----------
async function sweep(u, h) {
  if (!h.active) return { skipped: 'off' };
  if (alt.banned()) return { skipped: 'ban', apiFail: 1, ban: 429 };
  h.stats.checks++;
  const now = Date.now();
  if (leftSlots(h) <= 0) return finishHunt(u, h);

  let targets;
  try { targets = await ensureTargets(u); }
  catch (e) { h.stats.errors++; log(u, 'Сбой: ' + e.message, 1); await notifyError(u, e.message); return { error: e.message }; }

  const courts = targets.filter(m => L.courtOk(h, m));
  if (!courts.length) { log(u, `${label(h)}: под фильтр не подходит ни один корт (всего ${targets.length}) — ослабьте фильтр`, 1); return { error: 'no courts' }; }
  const dates = L.taskDates(h, now);

  // Опрашиваем ТОЛЬКО корты и дни из фильтра — меньше запросов, выше темп.
  const combos = [];
  for (const d of dates) for (const c of courts) combos.push({ d, c });
  const start = h.rot % combos.length;
  const batchList = [];
  for (let i = 0; i < Math.min(COMBO_CAP, combos.length); i++) batchList.push(combos[(start + i) % combos.length]);
  h.rot = (start + batchList.length) % combos.length;

  const leftBy = {};
  for (const d of dayPlan(h, now)) leftBy[d.iso] = Math.max(0, d.need - d.got);

  // все расписания — одной параллельной пачкой
  const res = await alt.batch(batchList.map(({ d, c }) => () => {
    const svc = pickService(c.services, c.indoor);
    return alt.getTimes(c.staffId, d.iso, svc && svc.id, u.apiBase).then(j => ({ j, d, c, svc }));
  }));

  const tzo = `+${String(Number(process.env.TZ_OFFSET) || 5).padStart(2, '0')}:00`;
  const foundNew = [];
  let apiOk = 0, apiFail = 0, ban = 0;
  for (const out of res) {
    if (!out || !out.j) { apiFail++; continue; }
    const { j, d, c, svc } = out;
    if (j._ban) ban = j._ban;
    if (!j.success || !Array.isArray(j.data)) { apiFail++; continue; }
    apiOk++;

    const raw = new Map();
    for (const slot of j.data) {
      const t = L.normTime(slot.time);
      const ms = slot.datetime ? Date.parse(slot.datetime) : (t ? Date.parse(`${d.iso}T${t}:00${tzo}`) : NaN);
      if (ms) raw.set(ms, slot.datetime || null);
    }
    for (const startMs of [...raw.keys()].sort((a, b) => a - b)) {
      if (!L.slotMatches(h, d, startMs, now)) continue;
      const pd = L.planDay(h, startMs);
      if (!(leftBy[pd] > 0)) continue;
      const key = L.slotKey(c.staffId, startMs);
      if (h.seen[key]) continue;
      if ((h.bookings || []).some(b => !b.cancelled && b.staffId === c.staffId && b.start === startMs)) continue;
      h.seen[key] = Date.now();
      h.stats.found++;
      foundNew.push({ target: c, svc, startMs, raw: raw.get(startMs) || null });
    }
  }
  if (!apiOk && apiFail) {
    h.stats.errors++;
    log(u, `Расписание не отдалось ни по одному корту (${apiFail} попыток)${ban ? ` — сайт ответил ${ban}` : ' — вероятно, устарел ключ'}`, 1);
  }

  // ближе к началу — раньше; так первым делом забираем то, что скоро уведут
  foundNew.sort((a, b) => a.startMs - b.startMs);
  let asked = 0;
  for (const f of foundNew) {
    const pd = L.planDay(h, f.startMs);
    if (!(leftBy[pd] > 0)) continue;
    if (h.mode === 'auto') {
      const r = await doBook(u, h, f.target.staffId, f.svc && f.svc.id, f.startMs, f.raw);
      if (r && r.ok) leftBy[pd]--;
    } else if (asked < 4) { await offerSlot(u, h, f); asked++; }
  }
  if (!foundNew.length) log(u, `${label(h)} · проверка №${h.stats.checks}: свободного нет, слежу дальше`);
  if (leftSlots(h) <= 0) await finishHunt(u, h);
  return { found: foundNew.length, courts: courts.length, apiOk, apiFail, ban };
}

// ---------- предложение (режим «спросить меня») ----------
async function offerSlot(u, h, f) {
  const c = f.target;
  const o = {
    id: Math.random().toString(36).slice(2, 9),
    hunt: h.id,
    staffId: c.staffId, serviceId: f.svc ? f.svc.id : null, raw: f.raw || null,
    court: c.court, indoor: c.indoor, name: c.name,
    start: f.startMs, dur: 60,
    price: f.svc && f.svc.price ? f.svc.price : null
  };
  h.offers = [o, ...(h.offers || [])].slice(0, 12);
  const title = courtTitle(c, c.name);
  await sendTo(u,
    `🔔 <b>Освободился корт</b>\n${title} · ${L.whenText(o.start, 60)}${L.midnightNote(o.start)}\n` +
    (o.price ? `${o.price} ₸ · оплата на месте\n` : '') +
    `Забираем, пока не увели? 👇`,
    { reply_markup: { inline_keyboard: [[
      { text: `🎾 Забрать ${L.hm(o.start)}`, callback_data: `b|${o.id}` },
      { text: '✖️ Пропустить', callback_data: `sk|${o.id}` }
    ]] } });
  log(u, `Нашёл: ${title}, ${L.whenText(o.start, 60)} — жду решения`);
}

const findOffer = (u, id) => {
  for (const h of u.hunts) {
    const o = (h.offers || []).find(x => x.id === id);
    if (o) return { o, h };
  }
  return null;
};
function dropOffer(u, id) {
  for (const h of u.hunts) h.offers = (h.offers || []).filter(o => o.id !== id);
}

// ---------- контакты для массовой брони ----------
// Первый контакт — основной. Второй и следующий корт НА ТО ЖЕ ВРЕМЯ оформляем
// на следующего человека: администрация отменяет несколько кортов на одно имя.
function contactFor(u, h, startMs) {
  const list = (u.contacts || []).filter(c => c.name && c.phone);
  if (!list.length) return null;
  const sameTime = activeBookings(h).filter(b => b.start === startMs).length;
  const used = new Set(activeBookings(h).filter(b => b.start === startMs).map(b => String(b.phone || '')));
  const free = list.filter(c => !used.has(c.phone));
  return (free[0] || list[Math.min(sameTime, list.length - 1)] || list[0]);
}

// ---------- бронирование (одна запись = один час) ----------
async function doBook(u, h, staffId, serviceId, startMs, rawDatetime) {
  const targets = (u.targets && u.targets.list) || [];
  const target = targets.find(x => x.staffId === Number(staffId)) || { staffId, name: '', court: null, indoor: null, services: [] };
  const svc = (target.services || []).find(x => x.id === Number(serviceId)) || pickService(target.services, target.indoor);
  const title = courtTitle(target, target.name);
  const c = contactFor(u, h, startMs);
  if (!c) return { ok: false, why: 'Нет контакта: добавьте имя и телефон' };

  const iso = rawDatetime || L.isoLocal(startMs);
  const j = await alt.book({
    phone: c.phone, fullname: c.name, email: c.email,
    staffId: Number(staffId), serviceId: svc ? svc.id : null, datetime: iso,
    comment: 'Бронь через Court Hunter'
  }, u.apiBase);

  if (!j.success) {
    const code = (j.meta && j.meta.code) || (Array.isArray(j.errors) && j.errors[0] && j.errors[0].code);
    const msg = String((j.meta && j.meta.message) || (j.data && j.data.message) || j.raw || '');
    const busy = j._status === 422 && (code === 433 || code === 437)
      || /not available at the selected time|уже занят|недоступ/i.test(msg);
    if (!busy) h.stats.errors++;
    else h.seen[L.slotKey(staffId, startMs)] = Date.now();
    const why = busy ? 'этот час уже заняли' : (msg || JSON.stringify(j.meta || j.data || '')).slice(0, 160);
    log(u, `Бронь не прошла (${title}, ${L.whenText(startMs, 60)}): ${why}`, busy ? 0 : 1);
    if (!busy) await notifyError(u, `Бронь не прошла: ${title}, ${L.whenText(startMs, 60)}\n${why}`, !!j._ban);
    return { ok: false, why: busy ? 'Не успели — этот час уже заняли' : why };
  }

  const rec = (Array.isArray(j.data) && j.data[0]) || j.data || {};
  const recordId = rec.record_id || rec.id || null;
  const hash = rec.record_hash || rec.hash || null;
  if (!recordId) {
    h.stats.errors++;
    log(u, `Сайт не вернул номер записи (${title}, ${L.whenText(startMs, 60)}) — брони нет`, 1);
    return { ok: false, why: 'Сайт не подтвердил запись — попробуйте ещё раз' };
  }

  const b = {
    id: Math.random().toString(36).slice(2, 9),
    hunt: h.id, recordId, hash,
    staffId: Number(staffId), court: target.court, indoor: target.indoor, name: target.name,
    start: startMs, dur: 60,
    onName: c.name, phone: c.phone,
    price: svc && svc.price ? svc.price : null, service: svc && svc.title,
    cancelled: false, createdAt: Date.now()
  };
  h.bookings.push(b);
  h.stats.booked++;
  log(u, `Поймал! ${title}, ${L.whenText(startMs, 60)} на ${c.name} ✅`);

  const done = leftSlots(h) <= 0;
  if (done) h.active = false;
  const d = L.deadlines(startMs);
  const sameTime = activeBookings(h).filter(x => x.start === startMs);
  const msg = `🎾 <b>Поймал корт!</b>\n` +
    `${title} · ${L.whenText(startMs, 60)}${L.midnightNote(startMs)}\n` +
    (b.price ? `${b.price} ₸ · оплата на месте\n` : `Оплата на месте\n`) +
    `Записал на: ${c.name} (${c.phone})\n` +
    (sameTime.length > 1 ? `На это же время уже ${sameTime.length} корта — оформляю на разных людей, чтобы не отменили.\n` : '') +
    `\nПередумаете — отменить онлайн можно до ${L.hm(d.online)}, дальше только звонок на ресепшн (до ${L.hm(d.phone)}).\n` +
    `📍 Daulet Tennis, ул. Кордай, 6` +
    (done ? `\n\n🏁 «${label(h)}» — цель набрана, охоту выключил.` : `\n\nОсталось поймать: ${leftSlots(h)}`);
  const sent = await sendTo(u, msg,
    { reply_markup: { inline_keyboard: [[{ text: '↩️ Отменить бронь', callback_data: `c|${b.id}` }]] } });
  b.notified = sent.ok > 0;
  if (!b.notified) b.notify = msg;
  await alertAdmin(u, `🎯 <b>${who(u)}</b> поймал корт\n${title} · ${L.whenText(startMs, 60)} · на ${c.name}`);
  return { ok: true, booking: b };
}

async function takeOffer(u, id) {
  const f = findOffer(u, id);
  if (!f) return { ok: false, why: 'Это предложение уже неактуально' };
  const { o, h } = f;
  if (Date.now() > o.start - 10 * 60e3) { dropOffer(u, id); return { ok: false, why: 'Слот уже в прошлом' }; }
  if (leftForDay(h, L.planDay(h, o.start)) <= 0) { dropOffer(u, id); return { ok: false, why: 'На этот день нужное уже поймано' }; }
  const r = await doBook(u, h, o.staffId, o.serviceId, o.start, o.raw);
  if (r.ok || /заняли|увели/i.test(r.why || '')) dropOffer(u, id);
  return r;
}

// ---------- отмена ----------
async function doCancel(u, bookingId) {
  let b = null, h = null;
  for (const x of u.hunts) {
    const f = (x.bookings || []).find(y => y.id === bookingId && !y.cancelled);
    if (f) { b = f; h = x; break; }
  }
  if (!b) return { ok: false, why: 'Эта бронь уже отменена или не найдена' };
  const d = L.deadlines(b.start);
  if (Date.now() > d.online) {
    return { ok: false, why: Date.now() > d.phone
      ? 'Поздно: до игры меньше 3 часов, отмена закрыта'
      : `Онлайн-отмена закрыта. До ${L.hm(d.phone)} ещё можно отменить звонком на ресепшн.` };
  }
  if (!b.recordId || !b.hash) { b.cancelled = true; return { ok: true, b, h, partial: true }; }
  const j = await alt.cancel(b.recordId, b.hash, u.apiBase);
  if (!j.success && j._status !== 204 && j._status !== 200) {
    log(u, 'Сайт не принял отмену — отмените вручную', 1);
    return { ok: false, why: 'Сайт не принял отмену. Попробуйте на сайте или позвоните на корты.' };
  }
  b.cancelled = true;
  log(u, `Отменил бронь: ${courtTitle(b, b.name)}, ${L.whenText(b.start, 60)}`);
  return { ok: true, b, h };
}

// ---------- напоминания ----------
async function reminders(u) {
  const now = Date.now();
  for (const { b, h } of allActiveBookings(u)) {
    if (b.notified === false && b.notify) {
      const r = await sendTo(u, b.notify,
        { reply_markup: { inline_keyboard: [[{ text: '↩️ Отменить бронь', callback_data: `c|${b.id}` }]] } });
      if (r.ok > 0) { b.notified = true; delete b.notify; log(u, 'Сообщение о брони дошло со второй попытки'); }
    }
    const d = L.deadlines(b.start);
    if (!h.reminded[b.id] && now >= d.online - 65 * 60e3 && now < d.online) {
      h.reminded[b.id] = 1;
      await sendTo(u,
        `⏰ <b>Час до дедлайна отмены</b>\n` +
        `${courtTitle(b, b.name)} · ${L.whenText(b.start, 60)}${L.midnightNote(b.start)}\n` +
        `Онлайн-отмена закроется в ${L.hm(d.online)}. Дальше только ресепшн (до ${L.hm(d.phone)}).`,
        { reply_markup: { inline_keyboard: [[{ text: '↩️ Отменить бронь', callback_data: `c|${b.id}` }]] } });
    }
  }
}

async function notifyError(u, msg, toAdmin) {
  const now = Date.now();
  if (u.lastErrPing && now - u.lastErrPing < 30 * 60e3) return;
  u.lastErrPing = now;
  await sendTo(u, `😖 <b>Заминка</b>\n${String(msg).slice(0, 500)}`);
  if (toAdmin) await alertAdmin(u, `⚠️ <b>${who(u)}</b>: ${String(msg).slice(0, 300)}`);
}

async function finishHunt(u, h) {
  if (h.active) {
    h.active = false;
    log(u, `${label(h)}: всё поймано — охота выключена 🏁`);
    await sendTo(u, `🏁 <b>${label(h)}</b> — цель набрана, охоту выключил.`);
  }
  return { done: true };
}

// ---------- тексты ----------
function huntLine(u, h) {
  const days = (h.days || []).map(x => L.isoWord(x)).join(', ') || '—';
  const type = h.type === 'indoor' ? 'крытые' : h.type === 'outdoor' ? 'открытые' : 'любой тип';
  const nums = h.type !== 'any' && h.courts && h.courts.length ? ' №' + h.courts.join(', ') : '';
  return `${h.active ? '🟢' : '⚪'} <b>${label(h)}</b>\n` +
    `   ${bookedSlots(h)}/${goalSlots(h)} · ${days} · ${L.hourLabel(parseInt(h.timeFrom))}–${L.hourLabel(parseInt(h.timeTo))}\n` +
    `   ${type}${nums} · ${h.mode === 'auto' ? 'беру сразу' : 'спрашиваю'} · каждые ${Math.round(pace(u, h) / 1000)} с`;
}

function statusText(u, g) {
  const on = u.hunts.filter(h => h.active);
  let out = `${on.length ? `🟢 Охот идёт: ${on.length}` : '⚪ Все охоты на паузе'}\n\n`;
  out += u.hunts.map(h => huntLine(u, h)).join('\n\n');
  const acts = allActiveBookings(u).sort((a, b) => a.b.start - b.b.start);
  if (acts.length) {
    out += '\n\n<b>Брони:</b>';
    for (const { b } of acts) {
      const d = L.deadlines(b.start);
      out += `\n• ${courtTitle(b, b.name)} — ${L.whenText(b.start, 60)}${L.midnightNote(b.start)}\n  на ${b.onName || '—'} · отмена: онлайн до ${L.hm(d.online)}, звонком до ${L.hm(d.phone)}`;
    }
  }
  const cnt = (u.contacts || []).filter(c => c.name && c.phone).length;
  out += `\n\n👥 Контактов для брони: ${cnt}${cnt < 2 ? ' — для массовой брони добавьте ещё' : ''}`;
  if (u.targets && u.targets.list) out += `\n🏟 Кортов вижу: ${u.targets.list.length}`;
  if (alt.banned()) out += `\n🛑 Сайт ограничил частоту — жду ${Math.ceil(alt.banLeft() / 1000)} с`;
  if (g && g.botOn === false) out = '🔴 <b>Бот выключен владельцем</b>\n\n' + out;
  return out;
}

// Предложения вне текущего фильтра — убрать
function pruneOffers(u, h) {
  const now = Date.now();
  const dates = L.taskDates(h, now);
  const before = (h.offers || []).length;
  h.offers = (h.offers || []).filter(o => {
    if (o.start < now + 6 * 60e3) return false;
    if (!L.courtOk(h, o)) return false;
    const entry = dates.find(d => d.iso === L.localISODate(o.start)) || dates.find(d => d.carry && d.iso === L.localISODate(o.start));
    return entry ? L.slotMatches(h, entry, o.start, now) : false;
  });
  return before - h.offers.length;
}

// Фантомы: «брони», которые сайт не подтверждал
function dropPhantoms(u) {
  let n = 0;
  for (const h of u.hunts) {
    for (const b of h.bookings || []) if (!b.cancelled && !b.recordId) { b.cancelled = true; n++; }
  }
  if (n) log(u, 'Убрал несуществующих броней: ' + n, 1);
  return n;
}

module.exports = {
  HUNT_TTL, CACHE_VER,
  ensureTargets, pickService, activeBookings, allActiveBookings,
  dayPlan, goalSlots, bookedSlots, leftSlots, leftForDay,
  pace, noteResult, expired, autoStop, courtTitle, label, huntLine, statusText,
  sendTo, alertAdmin, who, sweep, offerSlot, findOffer, dropOffer, takeOffer,
  contactFor, doBook, doCancel, reminders, notifyError, finishHunt, pruneOffers, dropPhantoms
};
