// Время (Казахстан, UTC+5), матчинг фильтра, дедлайны отмены.
// Дни охоты хранятся АБСОЛЮТНЫМИ датами: после полуночи «завтра» само становится «сегодня»,
// а прошедший день выпадает из плана — бот не сбивается.
const OFF = (Number(process.env.TZ_OFFSET) || 5) * 3600e3;
const WD = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const p = n => String(n).padStart(2, '0');

const local = ms => new Date(ms + OFF);          // читать через getUTC*
const localISODate = ms => local(ms).toISOString().slice(0, 10);
const hm = ms => { const d = local(ms); return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`; };
const dm = ms => { const d = local(ms); return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}`; };
const wd = ms => WD[local(ms).getUTCDay()];
const fmt = ms => `${dm(ms)} (${wd(ms)}) ${hm(ms)}`;

const MAX_H = 25;                                          // до 01:00 ночи — дальше корты закрыты
const MIN_H = 6;
const MIN_WINDOW = 3;                                      // окно старта не короче 3 часов
const hourVal = h => `${p(h)}:00`;
const hourLabel = h => h === 24 ? '00:00 · полночь' : h === 25 ? '01:00 · ночью' : hourVal(h);
const parseHM = s => { const [h, m] = String(s).split(':').map(Number); return h * 60 + (m || 0); };

// Начало локальных суток даты ISO (мс UTC)
const dayStartISO = iso => Date.parse(iso + 'T00:00:00Z') - OFF;
function dayStart(nowMs, off) {
  const d = local(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - OFF + (off || 0) * 86400e3;
}
const todayISO = nowMs => localISODate(nowMs || Date.now());
const isoPlus = (iso, n) => localISODate(dayStartISO(iso) + n * 86400e3);
// смещение даты от сегодня: 0 сегодня, 1 завтра…
const isoOffset = (iso, nowMs) => Math.round((dayStartISO(iso) - dayStart(nowMs || Date.now(), 0)) / 86400e3);

function dayWord(ms, nowMs) {
  const diff = Math.round((dayStartISO(localISODate(ms)) - dayStart(nowMs || Date.now(), 0)) / 86400e3);
  return diff === 0 ? 'сегодня' : diff === 1 ? 'завтра' : diff === 2 ? 'послезавтра' : `${wd(ms)} ${dm(ms)}`;
}
function isoWord(iso, nowMs) {
  const off = isoOffset(iso, nowMs);
  const ms = dayStartISO(iso) + 12 * 3600e3;
  return off === 0 ? 'сегодня' : off === 1 ? 'завтра' : off === 2 ? 'послезавтра' : `${wd(ms)} ${dm(ms)}`;
}
const cap = s => String(s).charAt(0).toUpperCase() + String(s).slice(1);
const whenText = (startMs, durMin) => `${cap(dayWord(startMs))} ${hm(startMs)}–${hm(startMs + (durMin || 60) * 60000)}`;

// «00:00 завтра» на сайте = сегодня в полночь — подписываем явно
function midnightNote(ms) {
  const t = hm(ms);
  if (t !== '00:00' && t !== '01:00') return '';
  return `\n🌙 Это ночь ${dayWord(ms - 86400e3)}→${dayWord(ms)}: играете ${dayWord(ms - 86400e3)} после полуночи (сайт пишет «${dayWord(ms)} ${t}»)`;
}

const normTime = s => {
  const m = String(s || '').match(/(\d{1,2}):(\d{2})/);
  return m ? `${p(Number(m[1]))}:${m[2]}` : null;
};

// Окно старта: не короче MIN_WINDOW часов, в границах 06:00–01:00.
function fitWindow(h) {
  let f = Math.max(MIN_H, Math.min(24, parseInt(h.timeFrom || '18:00') || 18));
  let to = Math.max(f + 1, Math.min(MAX_H, parseInt(h.timeTo || '23:00') || 23));
  if (to - f < MIN_WINDOW) {
    to = Math.min(MAX_H, f + MIN_WINDOW);
    if (to - f < MIN_WINDOW) f = Math.max(MIN_H, to - MIN_WINDOW);
  }
  h.timeFrom = hourVal(f);
  h.timeTo = hourVal(to);
  return h;
}

// Момент, когда окно этого дня окончательно закрылось
const dayEndsAt = (h, iso) => dayStartISO(iso) + parseHM(h.timeTo || '23:00') * 60e3;

// Убрать прошедшие дни. Возвращает число выпавших.
function rollDays(h, nowMs) {
  const now = nowMs || Date.now();
  const before = (h.days || []).length;
  h.days = (h.days || []).filter(iso => dayEndsAt(h, iso) > now + 5 * 60e3).sort();
  return before - h.days.length;
}

// Даты, которые нужно опрашивать. carry — соседний день ради ночных слотов 00:00/01:00.
function taskDates(h, nowMs) {
  const now = nowMs || Date.now();
  const days = (h.days || []).filter(iso => dayEndsAt(h, iso) > now).sort();
  const out = days.map(iso => ({ iso, carry: 0 }));
  if (parseHM(h.timeTo || '23:00') > 1440) {
    for (const iso of days) {
      const next = isoPlus(iso, 1);
      if (!out.some(x => x.iso === next && !x.carry)) out.push({ iso: next, carry: 1 });
    }
  }
  return out;
}

// Слот подходит под окно старта?
function slotMatches(h, dateEntry, startMs, nowMs) {
  if (startMs < (nowMs || Date.now()) + 6 * 60e3) return false;   // впритык не берём
  const mins = parseHM(hm(startMs)) + (dateEntry.carry ? 1440 : 0);
  return mins >= parseHM(h.timeFrom || '18:00') && mins <= parseHM(h.timeTo || '23:00');
}

// К какому дню плана относится слот: ночные 00:00/01:00 — это вечер предыдущего дня
function planDay(h, startMs) {
  const mins = parseHM(hm(startMs));
  const fromM = parseHM(h.timeFrom || '18:00'), toM = parseHM(h.timeTo || '23:00');
  if (mins < fromM && mins + 1440 <= toM) return localISODate(startMs - 86400e3);
  return localISODate(startMs);
}

// Дедлайны отмены: онлайн −5ч, ресепшн −3ч
const deadlines = startMs => ({ online: startMs - 5 * 3600e3, phone: startMs - 3 * 3600e3 });

const slotKey = (staffId, startMs) => `${staffId}:${Math.floor(startMs / 60000)}`;

// Корт из названия. В Даулете: крытые №1–8, открытые №1–5 — нумерация раздельная.
function parseCourt(name) {
  const s = String(name || '');
  const n = (s.match(/(?:корт|court)\s*[№#nN]?\s*(\d{1,2})/i) || [])[1] || (s.match(/[№#]\s*(\d{1,2})/) || [])[1];
  const indoor = /крыт|indoor|манеж|зал/i.test(s) ? true
    : /откр|улич|outdoor|грунт|хард|air/i.test(s) ? false : null;
  return { court: n ? Number(n) : null, indoor };
}

function courtOk(h, meta) {
  if (h.type === 'indoor' && meta.indoor === false) return false;
  if (h.type === 'outdoor' && meta.indoor === true) return false;
  if (h.type && h.type !== 'any' && h.courts && h.courts.length
      && meta.court != null && !h.courts.includes(meta.court)) return false;
  return true;
}

// ISO в часовом поясе салона: 2026-08-05T20:00:00+05:00
function isoLocal(ms) {
  const off = Number(process.env.TZ_OFFSET) || 5;
  const d = new Date(ms + off * 3600e3);
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:00+${p(off)}:00`;
}

module.exports = {
  OFF, MAX_H, MIN_H, MIN_WINDOW, hourVal, hourLabel, parseHM, normTime, isoLocal,
  local, localISODate, dayStartISO, dayStart, todayISO, isoPlus, isoOffset,
  hm, dm, wd, fmt, dayWord, isoWord, cap, whenText, midnightNote,
  fitWindow, dayEndsAt, rollDays, taskDates, slotMatches, planDay,
  deadlines, slotKey, parseCourt, courtOk
};
