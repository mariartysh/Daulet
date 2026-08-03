// Ядро охоты: обход расписания, бронирование, отмена, напоминания.
const alt = require('./altegio');
const tg = require('./tg');
const L = require('./logic');
const { log } = require('./store');

const STAFF_TTL = 6 * 3600e3, SVC_TTL = 6 * 3600e3;
const COMBO_CAP = Number(process.env.COMBO_CAP || 8);

async function ensureStaff(s) {
  if (s.staffCache && Date.now() - s.staffCache.ts < STAFF_TTL && s.apiBase) return s.staffCache.list;
  let j = null, lastErr = '';
  const bases = s.apiBase ? [s.apiBase, ...alt.BASES.filter(b => b !== s.apiBase)] : alt.BASES;
  for (const b of bases) {
    j = await alt.getStaff(b).catch(e => ({ success: false, raw: e.message }));
    if (j.success && Array.isArray(j.data)) {
      if (s.apiBase !== b) { s.apiBase = b; log(s, `Подключился к сайту кортов (${b})`); }
      break;
    }
    lastErr = `HTTP ${j._status} ${JSON.stringify(j.meta || j.raw || '').slice(0, 100)}`;
    j = null;
  }
  if (!j) throw new Error(`сайт кортов не отвечает (${lastErr}). Скорее всего устарел ключ ALTEGIO_AUTH — снимите его заново из DevTools`);
  const list = j.data.filter(x => x.bookable !== false).map(x => ({ id: Number(x.id), name: x.name, ...L.parseCourt(x.name) }));
  s.staffCache = { ts: Date.now(), list };
  return list;
}

async function ensureServices(s, staffId) {
  s.svcCache = s.svcCache && Date.now() - s.svcCache.ts < SVC_TTL ? s.svcCache : { ts: Date.now(), byStaff: {} };
  if (s.svcCache.byStaff[staffId]) return s.svcCache.byStaff[staffId];
  const j = await alt.getServices(staffId, s.apiBase);
  const raw = (j.data && (j.data.services || j.data)) || [];
  const list = (Array.isArray(raw) ? raw : []).map(x => ({
    id: Number(x.id), title: x.title,
    len: Number(x.session_length || x.seance_length || 0) / 60 || null,
    price: x.price_min || x.price_max || null
  }));
  s.svcCache.byStaff[staffId] = list;
  return list;
}

function pickService(services, durMin) {
  const hrs = Math.round(durMin / 60);
  return services.find(x => x.len === durMin)
    || services.find(x => new RegExp(`${hrs}\\s*час`, 'i').test(x.title))
    || services[0] || null;
}

function activeBookings(s) {
  return s.bookings.filter(b => !b.cancelled && b.start > Date.now() - 3600e3);
}

function courtTitle(meta, name) {
  if (meta.court != null) {
    const t = meta.indoor === false ? 'Уличный корт' : meta.indoor ? 'Крытый корт' : 'Корт';
    return `${t} №${meta.court}`;
  }
  return name;
}

async function sendAll(s, text, extra) {
  for (const c of (s.chats || [])) await tg.send(c.id || c, text, extra || {});
}

// ---- один проход охоты ----
async function sweep(s) {
  const t = s.task;
  if (!t.active) return { skipped: 'off' };
  s.stats.checks++;
  const now = Date.now();
  const remaining = () => t.needed - activeBookings(s).length;
  if (remaining() <= 0) return finishTask(s);

  let staff;
  try { staff = await ensureStaff(s); }
  catch (e) { s.stats.errors++; log(s, 'Сбой: ' + e.message, 1); await notifyError(s, e.message); return { error: e.message }; }

  const courts = staff.filter(m => L.courtOk(t, m));
  if (!courts.length) { log(s, 'Под фильтр не подходит ни один корт — проверьте настройки', 1); return { error: 'no courts' }; }
  const dates = L.taskDates(t, now);

  const combos = [];
  for (const d of dates) for (const c of courts) combos.push({ d, c });
  const start = s.rot % combos.length;
  const batch = [];
  for (let i = 0; i < Math.min(COMBO_CAP, combos.length); i++) batch.push(combos[(start + i) % combos.length]);
  s.rot = (start + batch.length) % combos.length;

  const foundNew = [];
  for (const { d, c } of batch) {
    const services = await ensureServices(s, c.id).catch(() => []);
    const svc = pickService(services, t.dur);
    const j = await alt.getTimes(c.id, d.iso, svc && svc.id, s.apiBase);
    if (!j.success || !Array.isArray(j.data)) { s.stats.errors++; continue; }
    for (const slot of j.data) {
      const startMs = slot.datetime ? Date.parse(slot.datetime) : Date.parse(`${d.iso}T${slot.time}:00+05:00`);
      if (!startMs || !L.slotMatches(t, d, startMs, now)) continue;
      const key = L.slotKey(c.id, startMs);
      if (s.seen[key]) continue;
      if (s.bookings.some(b => !b.cancelled && b.staffId === c.id && b.start === startMs)) continue;
      s.seen[key] = Date.now();
      s.stats.found++;
      foundNew.push({ staff: c, svc, startMs, key });
    }
  }

  let asked = 0;
  for (const f of foundNew) {
    if (remaining() <= 0) break;
    if (t.mode === 'auto') await doBook(s, f.staff.id, f.svc && f.svc.id, f.startMs);
    else if (asked < 3) { await notifySlot(s, f); asked++; }
  }
  if (!foundNew.length) log(s, `Проверка №${s.stats.checks}: свободного нет, слежу дальше`);
  else if (t.mode === 'confirm') log(s, `Нашёл свободное: ${foundNew.length} слот(а) — отправил в Telegram, жду решения`);
  if (remaining() <= 0) await finishTask(s);
  await reminders(s);
  return { found: foundNew.length };
}

// ---- бронирование ----
async function doBook(s, staffId, serviceId, startMs) {
  const t = s.task;
  const staff = (s.staffCache ? s.staffCache.list : []).find(x => x.id === Number(staffId)) || { id: staffId, name: `Корт (id ${staffId})`, court: null, indoor: null };
  const services = await ensureServices(s, staffId).catch(() => []);
  const svc = services.find(x => x.id === Number(serviceId)) || pickService(services, t.dur);
  const iso = new Date(startMs).toISOString().replace(/\.\d+Z/, '+00:00');
  const j = await alt.book({
    phone: s.profile.phone, fullname: s.profile.name, email: s.profile.email,
    staffId: Number(staffId), serviceId: svc ? svc.id : null, datetime: iso,
    comment: 'Бронь через Court Hunter'
  }, s.apiBase);
  const title = courtTitle(staff, staff.name);
  if (!j.success) {
    const code = (j.meta && j.meta.code) || (Array.isArray(j.errors) && j.errors[0] && j.errors[0].code);
    if (j._status === 422 && (code === 433 || code === 437)) {
      log(s, `Не успел — ${title} ${L.whenText(startMs, t.dur)} уже увели. Ищу дальше`);
      return { ok: false, why: 'taken' };
    }
    s.stats.errors++;
    const why = JSON.stringify(j.meta || j.data || j.raw || '').slice(0, 160);
    log(s, `Бронь не прошла (${title}, ${L.whenText(startMs, t.dur)}): ${why}`, 1);
    await notifyError(s, `Бронь не прошла: ${title}, ${L.whenText(startMs, t.dur)}\n${why}`);
    return { ok: false, why };
  }
  const rec = (Array.isArray(j.data) && j.data[0]) || j.data || {};
  const b = {
    id: Math.random().toString(36).slice(2, 9),
    recordId: rec.record_id || rec.id || null,
    hash: rec.record_hash || rec.hash || null,
    staffId: Number(staffId), court: staff.court, indoor: staff.indoor, name: staff.name,
    start: startMs, dur: t.dur, price: svc && svc.price, service: svc && svc.title,
    cancelled: false, createdAt: Date.now()
  };
  s.bookings.push(b);
  s.stats.booked++;
  log(s, `Поймал! ${title}, ${L.whenText(startMs, t.dur)} ✅`);
  const done = t.needed - activeBookings(s).length <= 0;
  if (done) t.active = false;
  const d = L.deadlines(startMs);
  await sendAll(s,
    `🎾 <b>Поймал корт!</b>\n` +
    `${title} · ${L.whenText(startMs, t.dur)}${L.midnightNote(startMs)}\n` +
    (b.price ? `${b.price} ₸ · оплата на месте\n` : `Оплата на месте\n`) +
    `Записал на: ${s.profile.name || '—'}\n\n` +
    `Передумаете — отменить онлайн можно до ${L.hm(d.online)}, дальше только звонок на ресепшн (до ${L.hm(d.phone)}).\n` +
    `📍 Daulet Tennis, ул. Кордай, 6` +
    (done ? `\n\n🏁 Всё, цель набрана — охоту выключил. Понадобится ещё — /menu` : ''),
    { reply_markup: { inline_keyboard: [[{ text: '↩️ Отменить бронь', callback_data: `c|${b.id}` }]] } });
  return { ok: true, booking: b };
}

// ---- отмена ----
async function doCancel(s, bookingId) {
  const b = s.bookings.find(x => x.id === bookingId && !x.cancelled);
  if (!b) return { ok: false, why: 'Эта бронь уже отменена или не найдена' };
  const d = L.deadlines(b.start);
  if (Date.now() > d.online) {
    return { ok: false, why: Date.now() > d.phone
      ? 'Поздно: до игры меньше 3 часов, отмена уже закрыта'
      : `Онлайн-отмена уже закрыта. До ${L.hm(d.phone)} ещё можно отменить звонком на ресепшн.` };
  }
  if (b.recordId && b.hash) {
    const j = await alt.cancel(b.recordId, b.hash, s.apiBase);
    if (!j.success && j._status !== 204 && j._status !== 200) {
      log(s, `Сайт не принял отмену (HTTP ${j._status}) — отмените вручную`, 1);
      return { ok: false, why: `Сайт не принял отмену (HTTP ${j._status}). Попробуйте на сайте или позвоните на корты.` };
    }
  }
  b.cancelled = true;
  log(s, `Отменил бронь: ${courtTitle(b, b.name)}, ${L.whenText(b.start, b.dur)}`);
  return { ok: true, b };
}

// ---- напоминания о закрытии онлайн-отмены ----
async function reminders(s) {
  const now = Date.now();
  for (const b of activeBookings(s)) {
    const d = L.deadlines(b.start);
    if (!s.reminded[b.id] && now >= d.online - 65 * 60e3 && now < d.online) {
      s.reminded[b.id] = 1;
      await sendAll(s,
        `⏰ <b>Час до дедлайна отмены</b>\n` +
        `${courtTitle(b, b.name)} · ${L.whenText(b.start, b.dur)}${L.midnightNote(b.start)}\n` +
        `Онлайн-отмена закроется в ${L.hm(d.online)}. Если планы поменялись — жмите сейчас, после останется только ресепшн (до ${L.hm(d.phone)}).`,
        { reply_markup: { inline_keyboard: [[{ text: '↩️ Отменить бронь', callback_data: `c|${b.id}` }]] } });
    }
  }
}

async function notifySlot(s, f) {
  const title = courtTitle(f.staff, f.staff.name);
  const ts = Math.floor(f.startMs / 1000);
  await sendAll(s,
    `🔔 <b>Освободился корт</b>\n` +
    `${title} · ${L.whenText(f.startMs, s.task.dur)}${L.midnightNote(f.startMs)}\n` +
    `Забираем, пока не увели? 👇`,
    { reply_markup: { inline_keyboard: [[{ text: `🎾 Забрать ${L.hm(f.startMs)}`, callback_data: `b|${f.staff.id}|${f.svc ? f.svc.id : 0}|${ts}` }]] } });
}

async function notifyError(s, msg) {
  await sendAll(s, `😖 <b>Заминка</b>\n${String(msg).slice(0, 500)}`);
}

async function finishTask(s) {
  if (s.task.active) {
    s.task.active = false;
    log(s, 'Все корты пойманы — охота выключена 🏁');
  }
  return { done: true };
}

function statusText(s) {
  const t = s.task;
  const act = activeBookings(s).sort((a, b) => a.start - b.start);
  const days = (t.dayOffsets && t.dayOffsets.length ? t.dayOffsets : [0, 1, 2]).map(o => ['сегодня', 'завтра', 'послезавтра'][o]).join(', ');
  const type = t.type === 'indoor' ? 'крытые' : t.type === 'outdoor' ? 'уличные' : 'любой тип';
  const nums = t.type !== 'any' && t.courts && t.courts.length ? ' №' + t.courts.join(', ') : '';
  let out = `${t.active ? '🟢 Охочусь' : '⚪ На паузе'} · поймано ${act.length} из ${t.needed}\n`;
  out += `🗓 ${days} · ${t.timeFrom}–${t.timeTo} · ${Math.round(t.dur / 60)} ч\n`;
  out += `🎾 ${type}${nums} · ${t.mode === 'auto' ? 'бронирую сразу' : 'сначала спрашиваю'}\n`;
  out += `🔁 Проверок ${s.stats.checks} · находок ${s.stats.found}`;
  if (act.length) {
    out += '\n\n<b>Брони:</b>';
    for (const b of act) {
      const d = L.deadlines(b.start);
      out += `\n• ${courtTitle(b, b.name)} — ${L.whenText(b.start, b.dur)}${L.midnightNote(b.start)}\n  отмена: онлайн до ${L.hm(d.online)}, звонком до ${L.hm(d.phone)}`;
    }
  }
  return out;
}

module.exports = { sweep, doBook, doCancel, reminders, statusText, activeBookings, ensureStaff, courtTitle, sendAll };
