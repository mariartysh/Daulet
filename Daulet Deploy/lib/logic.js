// Время (Казахстан, UTC+5, без переводов), матчинг фильтра, дедлайны отмены.
const OFF = (Number(process.env.TZ_OFFSET) || 5) * 3600e3;
const WD = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const p = n => String(n).padStart(2, '0');

const local = ms => new Date(ms + OFF);          // читать через getUTC*
const localISODate = ms => local(ms).toISOString().slice(0, 10);
const hm = ms => { const d = local(ms); return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`; };
const dm = ms => { const d = local(ms); return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}`; };
const wd = ms => WD[local(ms).getUTCDay()];
const fmt = ms => `${dm(ms)} (${wd(ms)}) ${hm(ms)}`;

// «00:00 завтра» = сегодня в полночь — подписываем такие слоты явно
function midnightNote(ms) {
  if (hm(ms) !== '00:00') return '';
  const prev = ms - 86400e3;
  return `\n⚠️ 00:00 ${dm(ms)} — это ночь ${wd(prev)}→${wd(ms)}, фактически ${dm(prev)} в полночь`;
}

const parseHM = s => { const [h, m] = String(s).split(':').map(Number); return h * 60 + (m || 0); };

// Начало локального дня (мс UTC) со сдвигом off дней от сегодня
function dayStart(nowMs, off) {
  const d = local(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - OFF + off * 86400e3;
}

// Даты задания: сайт открывает бронь на сегодня/завтра/послезавтра (dayOffsets 0/1/2).
// Полночный нюанс: если timeTo = 24:00, для дня D дополнительно разрешаем слот
// ровно 00:00 дня D+1 (это «вечер D» — сегодня в полночь).
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

// Подходит ли конкретный слот (startMs) под задание для даты dateEntry
function slotMatches(task, dateEntry, startMs, nowMs) {
  if (startMs < nowMs + 10 * 60e3) return false; // не бронируем впритык
  const mins = parseHM(hm(startMs));
  if (dateEntry.midnightOnly) return mins === 0;
  const fromM = parseHM(task.timeFrom || '00:00');
  const toM = parseHM(task.timeTo || '24:00');
  if (mins === 0 && toM >= 1440) return true;    // полночь края диапазона
  return mins >= fromM && mins + (task.dur || 60) <= toM;
}

// Дедлайны отмены: онлайн −5ч, ресепшн −3ч
const deadlines = startMs => ({ online: startMs - 5 * 3600e3, phone: startMs - 3 * 3600e3 });

function deadlineText(startMs) {
  const d = deadlines(startMs);
  return `Отмена: онлайн до ${fmt(d.online)} · ресепшн до ${fmt(d.phone)}`;
}

const slotKey = (staffId, startMs) => `${staffId}:${Math.floor(startMs / 60000)}`;

// Определение корта из имени сотрудника Altegio («Корт 3 (Крытый)»).
// В Даулете нумерация раздельная: крытые 1–8, уличные 1–5.
function parseCourt(name) {
  const n = (String(name).match(/корт\D*(\d+)/i) || [])[1];
  const indoor = /крыт/i.test(name) ? true : /откр|улич|грунт/i.test(name) ? false : null;
  return { court: n ? Number(n) : null, indoor };
}

// Фильтр корта: тип (any/indoor/outdoor) + номера в рамках выбранного типа.
// Номера имеют смысл только при выбранном типе — нумерация у типов своя.
function courtOk(task, meta) {
  if (task.type === 'indoor' && meta.indoor === false) return false;
  if (task.type === 'outdoor' && meta.indoor === true) return false;
  if (task.type && task.type !== 'any' && task.courts && task.courts.length
      && meta.court != null && !task.courts.includes(meta.court)) return false;
  return true;
}

module.exports = { OFF, local, localISODate, hm, dm, wd, fmt, midnightNote, parseHM, dayStart, taskDates, slotMatches, deadlines, deadlineText, slotKey, parseCourt, courtOk };
