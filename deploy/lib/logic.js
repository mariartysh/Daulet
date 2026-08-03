// Время (Казахстан, UTC+5), матчинг фильтра, дедлайны отмены.
const OFF = (Number(process.env.TZ_OFFSET) || 5) * 3600e3;
const WD = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const p = n => String(n).padStart(2, '0');

const local = ms => new Date(ms + OFF);          // читать через getUTC*
const localISODate = ms => local(ms).toISOString().slice(0, 10);
const hm = ms => { const d = local(ms); return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`; };
const dm = ms => { const d = local(ms); return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}`; };
const wd = ms => WD[local(ms).getUTCDay()];
const fmt = ms => `${dm(ms)} (${wd(ms)}) ${hm(ms)}`;

// «сегодня» / «завтра» / «послезавтра» / «пт 08.08»
function dayWord(ms, nowMs) {
  const now = nowMs || Date.now();
  const diff = Math.round((Date.parse(localISODate(ms)) - Date.parse(localISODate(now))) / 86400e3);
  return diff === 0 ? 'сегодня' : diff === 1 ? 'завтра' : diff === 2 ? 'послезавтра' : `${wd(ms)} ${dm(ms)}`;
}
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
// «Сегодня 20:00–22:00»
const whenText = (startMs, durMin) => `${cap(dayWord(startMs))} ${hm(startMs)}–${hm(startMs + (durMin || 60) * 60000)}`;

// «00:00 завтра» на сайте = сегодня в полночь — подписываем явно
function midnightNote(ms) {
  const t = hm(ms);
  if (t !== '00:00' && t !== '01:00') return '';
  return `\n🌙 Это ночь ${dayWord(ms - 86400e3)}→${dayWord(ms)}: играете ${dayWord(ms - 86400e3)} после полуночи (сайт пишет «${dayWord(ms)} ${t}»)`;
}

const normTime = s => {
  const m = String(s || '').match(/(\d{1,2}):(\d{2})/);
  return m ? `${String(m[1]).padStart(2, '0')}:${m[2]}` : null;
};
const parseHM = s => { const [h, m] = String(s).split(':').map(Number); return h * 60 + (m || 0); };
const MAX_H = 25;                                  // до 01:00 ночи — дальше корты закрыты
const hourVal = h => `${String(h).padStart(2, '0')}:00`;   // 24:00 / 25:00 — «ночные» значения
const hourLabel = h => h === 24 ? '00:00 · полночь' : h === 25 ? '01:00 · ночью' : hourVal(h);

// Начало локального дня (мс UTC) со сдвигом off дней от сегодня
function dayStart(nowMs, off) {
  const d = local(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - OFF + off * 86400e3;
}

// Даты задания: сайт открывает бронь на сегодня/завтра/послезавтра (dayOffsets 0/1/2).
// Если timeTo = 24:00, для дня D дополнительно смотрим слот 00:00 дня D+1 (это «вечер D»).
function taskDates(task, nowMs) {
  const offs = (task.dayOffsets && task.dayOffsets.length ? task.dayOffsets : [0, 1, 2])
    .filter(o => o >= 0 && o <= 2).sort();
  const out = offs.map(o => ({ iso: localISODate(dayStart(nowMs, o)), carry: 0 }));
  if (parseHM(task.timeTo || '22:00') > 1440) {          // окно уходит за полночь
    for (const o of offs) {
      const next = localISODate(dayStart(nowMs, o + 1));
      if (!out.some(x => x.iso === next && !x.carry)) out.push({ iso: next, carry: 1 });
    }
  }
  return out;
}

function slotMatches(task, dateEntry, startMs, nowMs) {
  if (startMs < nowMs + 10 * 60e3) return false;        // не бронируем впритык
  const mins = parseHM(hm(startMs)) + (dateEntry.carry ? 1440 : 0);
  const fromM = parseHM(task.timeFrom || '20:00');
  const toM = parseHM(task.timeTo || '22:00');
  return mins >= fromM && mins <= toM;                  // окно = когда можно НАЧАТЬ
}

// Дедлайны отмены: онлайн −5ч, ресепшн −3ч
const deadlines = startMs => ({ online: startMs - 5 * 3600e3, phone: startMs - 3 * 3600e3 });

const slotKey = (staffId, startMs) => `${staffId}:${Math.floor(startMs / 60000)}`;

// Корт из названия (сотрудник ИЛИ услуга). В Даулете: крытые №1–8, открытые №1–5 — нумерация раздельная.
// Понимаем варианты: «Корт 3», «Корт №3», «Крытый корт 3», «Открытый корт №2», «Court 5».
function parseCourt(name) {
  const s = String(name || '');
  const n = (s.match(/(?:корт|court)\s*[№#nN]?\s*(\d{1,2})/i) || [])[1] || (s.match(/[№#]\s*(\d{1,2})/) || [])[1];
  const indoor = /крыт|indoor|манеж|зал/i.test(s) ? true
    : /откр|улич|outdoor|грунт|хард|air/i.test(s) ? false : null;
  return { court: n ? Number(n) : null, indoor };
}

function courtOk(task, meta) {
  if (task.type === 'indoor' && meta.indoor === false) return false;
  if (task.type === 'outdoor' && meta.indoor === true) return false;
  if (task.type && task.type !== 'any' && task.courts && task.courts.length
      && meta.court != null && !task.courts.includes(meta.court)) return false;
  return true;
}

// Окно времени должно вмещать длительность, иначе искать нечего.
// Мягко расширяем конец, при необходимости сдвигаем начало.
function fitWindow(t) {
  const f = Math.max(6, Math.min(24, parseInt(t.timeFrom || '20:00')));
  const to = Math.max(f, Math.min(MAX_H, parseInt(t.timeTo || '22:00')));
  t.timeFrom = hourVal(f);
  t.timeTo = hourVal(to);
  return t;
}

// ISO в часовом поясе салона: 2026-08-05T00:00:00+05:00
function isoLocal(ms) {
  const off = Number(process.env.TZ_OFFSET) || 5;
  const d = new Date(ms + off * 3600e3);
  const p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:00+${p(off)}:00`;
}

module.exports = { fitWindow, MAX_H, hourVal, hourLabel, normTime, isoLocal, OFF, local, localISODate, hm, dm, wd, fmt, dayWord, cap, whenText, midnightNote, parseHM, dayStart, taskDates, slotMatches, deadlines, slotKey, parseCourt, courtOk };
