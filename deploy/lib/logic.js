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
  if (hm(ms) !== '00:00') return '';
  return `\n🌙 Это ${dayWord(ms - 86400e3)} в полночь (сайт показывает такой слот как «${dayWord(ms)} 00:00»)`;
}

const parseHM = s => { const [h, m] = String(s).split(':').map(Number); return h * 60 + (m || 0); };

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
  const out = offs.map(o => ({ iso: localISODate(dayStart(nowMs, o)), midnightOnly: false }));
  if (parseHM(task.timeTo || '24:00') >= 1440) {
    for (const o of offs) {
      const next = localISODate(dayStart(nowMs, o + 1));
      if (!out.some(x => x.iso === next)) out.push({ iso: next, midnightOnly: true });
    }
  }
  return out;
}

function slotMatches(task, dateEntry, startMs, nowMs) {
  if (startMs < nowMs + 10 * 60e3) return false; // не бронируем впритык
  const mins = parseHM(hm(startMs));
  if (dateEntry.midnightOnly) return mins === 0;
  const fromM = parseHM(task.timeFrom || '00:00');
  const toM = parseHM(task.timeTo || '24:00');
  if (mins === 0 && toM >= 1440) return true;
  return mins >= fromM && mins + (task.dur || 60) <= toM;
}

// Дедлайны отмены: онлайн −5ч, ресепшн −3ч
const deadlines = startMs => ({ online: startMs - 5 * 3600e3, phone: startMs - 3 * 3600e3 });

const slotKey = (staffId, startMs) => `${staffId}:${Math.floor(startMs / 60000)}`;

// Корт из имени сотрудника Altegio. В Даулете: крытые №1–8, уличные №1–5 (нумерация раздельная).
function parseCourt(name) {
  const n = (String(name).match(/корт\D*(\d+)/i) || [])[1];
  const indoor = /крыт/i.test(name) ? true : /откр|улич|грунт/i.test(name) ? false : null;
  return { court: n ? Number(n) : null, indoor };
}

function courtOk(task, meta) {
  if (task.type === 'indoor' && meta.indoor === false) return false;
  if (task.type === 'outdoor' && meta.indoor === true) return false;
  if (task.type && task.type !== 'any' && task.courts && task.courts.length
      && meta.court != null && !task.courts.includes(meta.court)) return false;
  return true;
}

module.exports = { OFF, local, localISODate, hm, dm, wd, fmt, dayWord, cap, whenText, midnightNote, parseHM, dayStart, taskDates, slotMatches, deadlines, slotKey, parseCourt, courtOk };
