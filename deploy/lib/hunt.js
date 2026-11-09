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
const M = require('./morning');
const { log } = require('./store');

const CACHE_TTL = 3 * 3600e3;
const CACHE_VER = 11;
const COMBO_CAP = Number(process.env.COMBO_CAP || 24);
const HUNT_TTL = Number(process.env.HUNT_TTL_H || 12) * 3600e3;

// ---------- обнаружение кортов ----------
// Список кортов и услуг стоит ~14 запросов. Раньше при сбое (429, сайт молчит, пустой ответ) он
// перезапрашивался на КАЖДОЙ проверке — это подкармливало 429 и сыпало «Заминками».
// Теперь после неудачи следующая попытка — через нарастающую паузу (15 → 30 → 60 → … → 300 с).
const TG_BACKOFF = Number(process.env.TARGETS_BACKOFF_S || 15) * 1000;
const TG_BACKOFF_MAX = Number(process.env.TARGETS_BACKOFF_MAX_S || 300) * 1000;
function targetsFail(u, kind, msg, fast) {
  const n = ((u.tgFail && u.tgFail.n) || 0) + 1;
  const base = fast ? 2000 : TG_BACKOFF, cap = fast ? 6000 : TG_BACKOFF_MAX;
  u.tgFail = { n, kind, msg, until: Date.now() + Math.min(cap, base * Math.pow(2, Math.min(n - 1, 6))) };
  const e = new Error(msg); e.kind = kind; return e;
}
// opts.backoff — звать из фонового прохода: пока пауза не вышла, запросов не делаем.
// opts.fast — утренний забег: паузы короткие.
async function ensureTargets(u, opts) {
  const o = opts || {};
  if (u.targets && u.targets.v === CACHE_VER && Date.now() - u.targets.ts < CACHE_TTL && u.apiBase) { u.tgFail = null; return u.targets.list; }
  if (o.backoff && u.tgFail && Date.now() < u.tgFail.until) {
    const e = new Error(u.tgFail.msg); e.kind = u.tgFail.kind; e.soft = true; throw e;
  }
  u.svcCache = null;

  let staffRaw = null, lastErr = '', ban = 0, answered = false;
  const bases = u.apiBase ? [u.apiBase, ...alt.BASES.filter(b => b !== u.apiBase)] : alt.BASES;
  for (const b of bases) {
    const j = await alt.getStaff(b).catch(e => ({ success: false, raw: e.message }));
    if (j.success && Array.isArray(j.data) && j.data.length) {
      if (u.apiBase !== b) { u.apiBase = b; log(u, `Подключился к сайту кортов (${b})`); }
      staffRaw = j.data; break;
    }
    lastErr = `HTTP ${j._status} ${JSON.stringify(j.meta || j.raw || '').slice(0, 110)}`;
    if (j._ban) { ban = j._ban; lastErr += ' — ключ отклонён или сработал лимит'; }
    if (j._status === 200 && j.success) answered = true;
    if (j._ban === 429) break;                       // сайт просит не частить — другие адреса не долбим
  }
  if (!staffRaw) {
    if (ban === 429) throw targetsFail(u, 'rate', 'Сайт кортов включил ограничение по частоте (429). Бот сам сбавил темп и вернётся к выбранной частоте, как только отпустит.', o.fast);
    if (ban) throw targetsFail(u, 'key', `Сайт отклонил ключ (${ban}). Похоже, ALTEGIO_AUTH устарел — снимите заново из DevTools и обновите, иначе брони не пройдут.`, o.fast);
    if (answered) throw targetsFail(u, 'courts', 'Сайт ответил, но список кортов пуст. Такое бывает ночью и в техперерыв; проверю позже. Если держится весь день — проверьте COMPANY_ID и ключ.', o.fast);
    throw targetsFail(u, 'site', `Сайт кортов не отвечает (${lastErr}). Продолжаю пробовать, но реже.`, o.fast);
  }

  const list = [];
  let svcErr = null;
  for (const x of staffRaw) {
    const name = String(x.name || '');
    if (/стенк|стена|wall|пляж|песк|beach/i.test(name)) continue;
    const id = Number(x.id);
    let services;
    try { services = await servicesFor(u, id); }
    catch (e) { svcErr = e; break; }                   // 429 или обрыв — дальше не идём, не добиваем сайт
    if (!services.length) continue;
    const hasIn = services.some(v => /крыт/i.test(v.title));
    const hasOut = services.some(v => /откр|улич/i.test(v.title));
    const indoor = hasIn && !hasOut ? true : hasOut && !hasIn ? false : !/№/.test(name);
    list.push({ staffId: id, court: L.parseCourt(name).court, indoor, name, services });
  }
  if (svcErr) {                                       // неполный список не запоминаем: лучше подождать и собрать целиком
    const k = svcErr.ban === 429 ? 'rate' : svcErr.ban ? 'key' : 'site';
    throw targetsFail(u, k, k === 'rate'
      ? 'Сайт кортов включил ограничение по частоте (429). Бот сам сбавил темп и вернётся к выбранной частоте, как только отпустит.'
      : k === 'key' ? `Сайт отклонил ключ (${svcErr.ban}). Похоже, ALTEGIO_AUTH устарел — снимите заново из DevTools и обновите, иначе брони не пройдут.`
        : 'Сайт кортов не отдал список услуг. Продолжаю пробовать, но реже.', o.fast);
  }
  if (!list.length) throw targetsFail(u, 'courts', 'Сайт ответил, но кортов с услугами не отдал. Такое бывает ночью и в техперерыв; проверю позже. Если держится весь день — проверьте COMPANY_ID и ключ.', o.fast);
  u.tgFail = null;
  u.targets = { ts: Date.now(), v: CACHE_VER, list };
  const inC = list.filter(x => x.indoor === true).length, outC = list.filter(x => x.indoor === false).length;
  log(u, `Кортов на сайте: ${list.length} (крытых ${inC}, открытых ${outC})`);
  return list;
}

async function servicesFor(u, staffId) {
  u.svcCache = u.svcCache && Date.now() - u.svcCache.ts < CACHE_TTL ? u.svcCache : { ts: Date.now(), byStaff: {} };
  const key = String(staffId || 0);
  if (u.svcCache.byStaff[key]) return u.svcCache.byStaff[key];
  const j = await alt.getServices(staffId || 0, u.apiBase).catch(e => ({ success: false, _status: 0, raw: e.message }));
  // Ответ 429/401/403 или обрыв — это НЕ «услуг нет»: раньше пустота запоминалась, и бот считал, что кортов нет.
  if (j._ban || j._status === 0) { const e = new Error('услуги не получены'); e.ban = j._ban || 0; throw e; }
  const raw = (j.data && (j.data.services || j.data)) || [];
  const list = (Array.isArray(raw) ? raw : []).map(x => ({
    id: Number(x.id), title: x.title || '',
    len: Number(x.session_length || x.seance_length || x.duration || 0) / 60 || null,
    price: x.price_min || x.price_max || null
  }));
  if (j.success) u.svcCache.byStaff[key] = list;      // пустой ответ с ошибкой не кэшируем
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
  // Утренний забег (окно около 07:00) идёт на своей частоте, а не на выбранной в охоте.
  const quick = M.fast(h);
  const base = quick ? M.PACE_MS : Math.max(1, Math.min(60, Number((h && h.interval) || 3))) * 1000;
  if (alt.banned()) return Math.max(20000, alt.banLeft());
  if (u.tgFail && u.tgFail.until > Date.now()) return Math.max(base, u.tgFail.until - Date.now());   // пауза после сбоя списка кортов
  const f = (u.bo && u.bo.fails) || 0;
  // Окно короткое: при сбоях сайта ждём не 30–60 с, а всего 5 с.
  const raw = quick ? (f >= 3 ? Math.max(base, 5000) : base) : (f >= 6 ? 60000 : f >= 3 ? 30000 : base);
  return Math.round(raw * alt.slowFactor());   // сайт нервничает — сами сбавляем, не дожидаясь бана
}

const MSG = {
  rate: 'Сайт включил ограничение по частоте (429). Бот сам сбавил темп и вернётся к выбранной частоте, как только отпустит.',
  key: c => `Сайт отклонил ключ (${c}). Похоже, ALTEGIO_AUTH устарел — обновите его, иначе брони не пройдут.`,
  site: 'Сайт кортов не отвечает. Продолжаю пробовать, но реже.'
};

async function noteResult(u, h, r) {
  u.bo = u.bo || { fails: 0, ban: 0 };
  if (r && r.apiOk) {
    if (u.bo.fails >= 3) log(u, 'Сайт снова отвечает — вернулся к обычной частоте');
    u.bo.fails = 0;
    errClear(u);                                  // сайт ответил — всё, что тянулось, прошло само
    return;
  }
  if (r && r.soft) return;                        // идёт пауза после сбоя, запросов не было
  if (!r || (!r.apiFail && !r.error)) return;
  u.bo.fails++;
  if (r.ban) {
    const now = Date.now();
    u.bo.ban = now;
    // Журнал и без того пухнет: пишем про бан не чаще раза в 5 минут
    if (now - (u.bo.logAt || 0) > 300e3) { u.bo.logAt = now; log(u, `Сайт ответил ${r.ban} — сработал лимит или ключ не принят, притормозил`, 1); }
    await notifyError(u, r.ban === 429 ? MSG.rate : MSG.key(r.ban), r.ban !== 429, r.ban === 429 ? 'rate' : 'key');
    return;
  }
  if (r.error) return;                            // про сбой списка кортов уже сказал sweep
  if (u.bo.fails === 3) log(u, 'Сайт кортов не отвечает — притормозил до 30 с', 1);
  if (u.bo.fails >= 3) await notifyError(u, MSG.site, false, 'site');
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
    h.active = false; h.actBy = 'bg';
    log(u, `${label(h)}: выбранные дни прошли — охота остановлена`, 1);
    await sendTo(u, `📅 <b>${label(h)}: дни прошли</b>\nВыберите новые дни и запустите снова.`);
    return true;
  }
  if (leftSlots(h) <= 0) { await finishHunt(u, h); return true; }
  if (M.windowOver(h)) {
    // Утренний забег закончился: охота спит до завтра, а «daily» остаётся включённым.
    h.active = false; h.actBy = 'morning';
    const d = dayPlan(h)[0], got = d ? Math.min(d.need, d.got) : 0;
    log(u, `${label(h)}: утренний забег закончен${d ? ` — поймано ${got} из ${d.need}` : ''}`);
    await sendTo(u, `☀️ <b>${label(h)}</b>\nУтренний забег закончен: ${got ? `поймал ${got} из ${d.need}` : `на ${L.isoWord(h.days[0])} ничего не освободилось`}. Завтра в ${M.startText()} попробую снова.`);
    return true;
  }
  if (expired(h)) {
    h.active = false; h.actBy = 'bg';
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
  try { targets = await ensureTargets(u, { backoff: true, fast: M.fast(h) }); }
  catch (e) {
    if (e.soft) {                                  // пауза после недавнего сбоя: запросов нет, журнал не засоряем
      await notifyError(u, e.message, false, e.kind);
      return { error: e.message, soft: true, kind: e.kind };
    }
    h.stats.errors++; log(u, 'Сбой: ' + e.message, 1);
    await notifyError(u, e.message, e.kind === 'key', e.kind || 'other');
    return { error: e.message, kind: e.kind };
  }
  if (u.errSince) delete u.errSince.courts;        // список кортов получен — «кортов нет» закончилось

  const courts = targets.filter(m => L.courtOk(h, m));
  if (!courts.length) {
    // Это НЕ сбой сайта: фильтр охоты не совпал с тем, что есть на сайте.
    // Не трогаем счётчик сбоев (иначе бот врал «сайт не отвечает») и не спамим лог.
    const inC = targets.filter(x => x.indoor === true).length, outC = targets.filter(x => x.indoor === false).length;
    const t = h.type === 'indoor' ? 'крытые' : h.type === 'outdoor' ? 'открытые' : 'любой тип';
    const nums = h.courts && h.courts.length ? ' №' + h.courts.join(', ') : '';
    const why = `фильтр «${t}${nums}» не совпал ни с одним кортом. На сайте вижу: крытых ${inC}, открытых ${outC}.`;
    // Это не сбой, а настройка: пока фильтр не поменяют, ситуация не изменится сама.
    // Поэтому предупреждаем РОВНО ОДИН РАЗ и дальше следим молча.
    // Флаг снимается, когда корты всё-таки появятся, когда поменяют план охоты
    // или когда охоту запустят заново.
    if (!h.noFitSent) {
      h.noFitSent = Date.now();
      log(u, `${label(h)}: ${why}`, 1);
      await sendTo(u, `🔎 <b>${label(h)}</b>\nПод ваш фильтр сейчас нет ни одного корта: ${why}\n\nПродолжаю следить молча — повторять это сообщение не буду. Поменяете тип или номера кортов — скажу заново.`);
    }
    if (u.bo && u.bo.fails) u.bo.fails = 0;   // запросов не было — старые «сбои» не в счёт
    return { skipped: 'filter', why };
  }
  h.noFitSent = 0;
  const dates = L.taskDates(h, now);

  // Опрашиваем ТОЛЬКО корты и дни из фильтра — меньше запросов, выше темп.
  const combos = [];
  for (const d of dates) for (const c of courts) combos.push({ d, c });
  const start = h.rot % combos.length;
  const batchList = [];
  const cap = M.fast(h) ? Math.max(COMBO_CAP, M.CAP) : COMBO_CAP;   // в утреннем окне весь день × все корты — за один круг
  for (let i = 0; i < Math.min(cap, combos.length); i++) batchList.push(combos[(start + i) % combos.length]);
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
    if (Date.now() - (h.failLogAt || 0) > 300e3) {      // не чаще раза в 5 минут — иначе журнал и база забиваются одним и тем же
      h.failLogAt = Date.now();
      log(u, `Расписание не отдалось ни по одному корту (${apiFail} попыток)${ban ? ` — сайт ответил ${ban}` : ' — вероятно, устарел ключ'}`, 1);
    }
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
  // Раньше строка писалась на КАЖДОЙ проверке: при частоте 2 с журнал полностью
  // обновлялся за четыре минуты, а профиль из-за этого переписывался в базу вхолостую.
  if (!foundNew.length && Date.now() - (h.quietAt || 0) > 60e3) {
    h.quietAt = Date.now();
    log(u, `${label(h)} · проверка №${h.stats.checks}: свободного нет, слежу дальше`);
  }
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
// Контакты этой охоты: h.cIdx — номера в адресной книге, пусто = вся книга.
function huntContacts(u, h) {
  const all = (u.contacts || []);
  const pick = (h && Array.isArray(h.cIdx) && h.cIdx.length)
    ? h.cIdx.map(i => all[i]).filter(Boolean)
    : all;
  return pick.filter(c => c && c.name && c.phone);
}

// Каждую новую бронь оформляем на «следующего» человека из книги: по кругу, а не всё на первого.
// Порядок выбора: 1) не тот, кто уже записан на это же время; 2) у кого меньше всего действующих броней;
// 3) кого дольше всего не использовали; 4) по порядку в книге.
function contactFor(u, h, startMs) {
  const list = huntContacts(u, h);
  if (!list.length) return null;
  const act = allActiveBookings(u).map(x => x.b);
  const sameTime = new Set(act.filter(b => b.start === startMs).map(b => String(b.phone || '')));
  const cnt = {}, last = {};
  for (const b of act) cnt[b.phone] = (cnt[b.phone] || 0) + 1;
  for (const x of u.hunts || []) for (const b of x.bookings || []) last[b.phone] = Math.max(last[b.phone] || 0, b.createdAt || 0);
  const rank = c => [sameTime.has(c.phone) ? 1 : 0, cnt[c.phone] || 0, last[c.phone] || 0, list.indexOf(c)];
  return list.slice().sort((p, q) => {
    const a = rank(p), b = rank(q);
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
    return 0;
  })[0];
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
    if (!busy) await notifyError(u, `Бронь не прошла: ${title}, ${L.whenText(startMs, 60)}\n${why}`, !!j._ban, 'book');
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
  if (done) { h.active = false; h.actBy = 'bg'; }
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
  try { await checkOne(u, b, true); } catch (e) {}          // сразу убеждаемся, что запись реально стоит на сайте
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

// ---------- проверка: стоит ли бронь на сайте ----------
// Запись Altegio читается по номеру и хэшу (как и отмена) — вход по телефону не нужен, поэтому
// статус и отмена работают для любой брони, на какое бы имя и номер она ни была оформлена.
// Если администрация отменила запись, бот скажет об этом сразу, а не в день игры.
const REC_EVERY = Number(process.env.REC_CHECK_MIN || 10) * 60e3;
const recOf = j => (j && j.data && !Array.isArray(j.data) ? j.data : (Array.isArray(j && j.data) ? j.data[0] : null)) || null;

async function venueCancelled(u, b) {
  b.cancelled = true; b.byVenue = true; b.status = 'cancelled'; b.cancelledAt = Date.now();
  log(u, `Бронь отменили на сайте: ${courtTitle(b, b.name)}, ${L.whenText(b.start, 60)} (на ${b.onName || '—'})`, 1);
  await sendTo(u, `⚠️ <b>Бронь отменили на сайте</b>\n${courtTitle(b, b.name)} · ${L.whenText(b.start, 60)}\nБыла записана на: ${b.onName || '—'}.\nЕсли корт нужен — включите охоту заново: поймаю этот час снова, если он свободен.`);
  await alertAdmin(u, `⚠️ <b>${who(u)}</b>: бронь отменили на сайте — ${courtTitle(b, b.name)} · ${L.whenText(b.start, 60)}`);
}

// Один запрос по одной брони. Возвращает true, если выяснилось, что её отменили.
async function checkOne(u, b, force) {
  if (!b.recordId || !b.hash || alt.banned()) return false;
  const now = Date.now();
  if (!force && u.recApi === 'no') return false;
  b.chkAt = now;
  const j = await alt.getRecord(b.recordId, b.hash, u.apiBase).catch(e => ({ success: false, _status: 0, raw: e.message }));
  if (j._ban) return false;
  const rec = recOf(j);
  if (j.success && rec && typeof rec === 'object' && (rec.id || rec.record_id || rec.datetime || rec.deleted !== undefined)) {
    u.recApi = 'ok'; u.recFail = 0;
    if (rec.deleted === true || rec.deleted === 1 || rec.deleted === '1') { await venueCancelled(u, b); return true; }
    b.status = 'ok'; b.okAt = now;
    return false;
  }
  if ((j._status === 404 || j._status === 410) && u.recApi === 'ok') { await venueCancelled(u, b); return true; }
  if (j._status === 0 || j._status >= 500) return false;      // сайт временно не отвечает — не вывод
  // Адрес не отдаёт запись (или формат неожиданный). После трёх неудач подряд перестаём спрашивать.
  if (!b.status) b.status = 'unknown';
  u.recFail = (u.recFail || 0) + 1;
  if (u.recFail >= 3 && u.recApi !== 'ok') {
    u.recApi = 'no';
    log(u, 'Сайт не показывает статус записей — проверку отключил. Отмена по номеру записи работает как раньше.', 1);
  }
  return false;
}

async function checkBookings(u, opts) {
  const o = opts || {};
  const now = Date.now();
  let cancelled = 0;
  for (const { b } of allActiveBookings(u)) {
    if (!b.recordId || !b.hash) continue;
    if (b.start < now - 30 * 60e3) continue;                                   // игра уже началась
    if (!o.force && now - (b.chkAt || 0) < REC_EVERY) continue;
    if (alt.banned()) break;
    if (await checkOne(u, b, o.force)) cancelled++;
  }
  return cancelled;
}

// ---------- напоминания ----------
async function reminders(u) {
  const now = Date.now();
  let changed = false;
  try { if (await checkBookings(u)) changed = true; } catch (e) {}
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
  return changed;
}

// «Заминка» — только если беда не проходит сама. Раньше сообщение уходило на первом же сбое и
// повторялось каждые 30 минут, в том числе по ночам. Теперь:
//   · after — сколько беда должна тянуться НЕПРЕРЫВНО (любой успешный ответ сайта сбрасывает отсчёт);
//   · every — не чаще раза в столько;
//   · ночью (по умолчанию 23:00–08:00) молчим, кроме неудачной брони;
//   · неудачная бронь — единственное, что приходит сразу: из-за неё можно остаться без корта.
const NOTIFY = {
  rate: { after: 30 * 60e3, every: 6 * 3600e3 },
  site: { after: 15 * 60e3, every: 6 * 3600e3 },
  key: { after: 10 * 60e3, every: 6 * 3600e3 },
  courts: { after: 30 * 60e3, every: 12 * 3600e3 },
  other: { after: 15 * 60e3, every: 6 * 3600e3 },
  book: { after: 0, every: 10 * 60e3, night: true }
};
function notifyQuiet(now) {
  const q = String(process.env.NOTIFY_QUIET || '23-8').trim();
  if (/^(off|no|0|нет)$/i.test(q)) return false;
  const m = q.match(/^(\d{1,2})\s*[-–:]\s*(\d{1,2})$/);
  if (!m) return false;
  const from = Number(m[1]), to = Number(m[2]);
  const hr = new Date(now + (Number(process.env.TZ_OFFSET) || 5) * 3600e3).getUTCHours();
  return from > to ? (hr >= from || hr < to) : (hr >= from && hr < to);
}
const errClear = u => { if (u.errSince) u.errSince = {}; };
async function notifyError(u, msg, toAdmin, kind) {
  const now = Date.now();
  const k = NOTIFY[kind] ? kind : 'other', rule = NOTIFY[k];
  u.errSince = u.errSince || {}; u.errSent = u.errSent || {};
  if (!u.errSince[k]) u.errSince[k] = now;
  if (now - u.errSince[k] < rule.after) return;             // может пройти само — не тревожим
  if (!rule.night && notifyQuiet(now)) return;              // ночью не будим
  if (u.errSent[k] && now - u.errSent[k] < rule.every) return;
  u.errSent[k] = now;
  const mins = Math.round((now - u.errSince[k]) / 60e3);
  await sendTo(u, `😖 <b>Заминка</b>\n${String(msg).slice(0, 500)}${mins >= 5 ? `\nТянется уже около ${mins} мин.` : ''}`);
  if (toAdmin) await alertAdmin(u, `⚠️ <b>${who(u)}</b>: ${String(msg).slice(0, 300)}`);
}

async function finishHunt(u, h) {
  if (h.active) {
    h.active = false; h.actBy = 'bg';
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
  HUNT_TTL, CACHE_VER, huntContacts,
  ensureTargets, pickService, activeBookings, allActiveBookings,
  dayPlan, goalSlots, bookedSlots, leftSlots, leftForDay,
  pace, noteResult, expired, autoStop, courtTitle, label, huntLine, statusText,
  sendTo, alertAdmin, who, sweep, offerSlot, findOffer, dropOffer, takeOffer,
  contactFor, doBook, doCancel, reminders, checkBookings, notifyError, finishHunt, pruneOffers, dropPhantoms
};
