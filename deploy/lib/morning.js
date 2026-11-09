'use strict';
// Утренний режим: корты на послезавтра выходят каждое утро в 07:00.
//
// Охота с флагом daily (в панели: «☀️ Каждое утро в 7:00») сама просыпается в MORNING_START
// (06:59), берёт день «сегодня + 2», ищет на повышенной частоте до MORNING_END (07:06)
// и засыпает до завтра. Остальное время она спит: ни запросов к сайту, ни команд базы.
//
// Всё настраивается переменными окружения, код трогать не нужно:
//   MORNING=0                 выключить режим целиком
//   MORNING_START=06:59       когда просыпаться (по часовому поясу TZ_OFFSET)
//   MORNING_END=07:06         когда засыпать
//   MORNING_DAYS_AHEAD=2      на сколько дней вперёд выходят корты (2 = послезавтра)
//   MORNING_PACE_MS=1500      пауза между проверками в окне (не меньше 900)
//   MORNING_COMBO_CAP=16      сколько пар «день × корт» проверять за один круг
const L = require('./logic');

const OFF = (Number(process.env.TZ_OFFSET) || 5) * 3600e3;
const p2 = n => String(n).padStart(2, '0');
const toMs = (s, defMin) => {
  const m = String(s || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  return (m ? Number(m[1]) * 60 + Number(m[2]) : defMin) * 60e3;
};
const fromMs = ms => `${p2(Math.floor(ms / 3600e3))}:${p2(Math.floor(ms / 60e3) % 60)}`;

const ENABLED = !/^(0|false|off|no|нет)$/i.test(String(process.env.MORNING || '1'));
const START = toMs(process.env.MORNING_START, 6 * 60 + 59);
const END = toMs(process.env.MORNING_END, 7 * 60 + 6);
const AHEAD = Math.max(1, Math.min(6, Math.round(Number(process.env.MORNING_DAYS_AHEAD)) || 2));
const PACE_MS = Math.max(900, Number(process.env.MORNING_PACE_MS) || 1500);
const CAP = Math.max(1, Math.round(Number(process.env.MORNING_COMBO_CAP)) || 16);
const TARGETS_MAX_AGE = 30 * 60e3;   // список кортов к окну должен быть свежим: перечитываем заранее

const dayMs = now => (((now + OFF) % 86400e3) + 86400e3) % 86400e3;
const inWindow = now => {
  if (!ENABLED || !(START < END)) return false;
  const t = dayMs(now == null ? Date.now() : now);
  return t >= START && t < END;
};
const targetDay = now => L.isoPlus(L.todayISO(now == null ? Date.now() : now), AHEAD);
const startText = () => fromMs(START);
const windowText = () => `${fromMs(START)}–${fromMs(END)}`;

// Для панели: что включено и когда.
const info = () => ({
  on: ENABLED, start: startText(), end: fromMs(END), window: windowText(),
  now: inWindow(), paceMs: PACE_MS, target: targetDay()
});

// Утренняя охота в окне идёт быстро
const fast = (h, now) => !!(h && h.daily) && inWindow(now);
// Окно закрылось, а утренняя охота ещё включена — пора спать
const windowOver = (h, now) => !!(h && h.daily && h.active) && !inWindow(now);

// Разбудить утренние охоты на сегодня. Безопасно звать сколько угодно раз:
// каждая охота просыпается один раз в сутки (метка dailyRun).
// Возвращает, сколько охот включено.
async function arm() {
  const now = Date.now();
  if (!inWindow(now)) return 0;
  const store = require('./store');
  const hunt = require('./hunt');
  const g = await store.loadGlobal(30000);
  if (g.botOn === false) return 0;
  const users = await store.loadUsers((g.users || []).filter(x => !x.blocked), 0);
  const day = L.todayISO(now), target = targetDay(now);
  let armed = 0, activeH = 0, activeB = 0;

  for (const u of users) {
    const due = (u.hunts || []).filter(h => h.daily && !h.active && h.dailyRun !== day);
    if (due.length) {
      let touched = false, warmed = false;
      for (const h of due) {
        h.dailyRun = day;                         // сегодня эту охоту уже будили
        h.days = [target];
        touched = true;
        if (!hunt.huntContacts(u, h).length) {
          store.log(u, `${hunt.label(h)}: утренний режим не запущен — не выбран контакт для брони`, 1);
          continue;
        }
        if (hunt.leftSlots(h) <= 0) {
          store.log(u, `${hunt.label(h)}: на ${L.isoWord(target)} цель уже набрана — утренний режим пропускаю`);
          continue;
        }
        if (!warmed) {
          warmed = true;
          u.bo = { fails: 0, ban: 0 }; u.tgFail = null;            // прошлые сбои не должны тормозить забег
          if (!u.targets || now - u.targets.ts > TARGETS_MAX_AGE) u.targets = null;
          // Список кортов читаем ДО 07:00, а не в разгар забега: иначе первая проверка
          // уйдёт на 14 лишних запросов.
          await hunt.ensureTargets(u).catch(() => {});
        }
        h.offers = []; h.seen = {}; h.noFitSent = 0; h.rot = 0;
        h.active = true; h.actBy = 'morning'; h.startedAt = now;
        armed++;
        store.log(u, `${hunt.label(h)}: утренний забег ${windowText()} — ищу ${L.isoWord(target)} (${target}), проверка каждые ${(PACE_MS / 1000).toFixed(1)} с`);
      }
      if (touched) await store.saveUser(u, { merge: true });
    }
    activeH += (u.hunts || []).filter(h => h.active).length;
    activeB += hunt.allActiveBookings(u).length;
  }
  if (armed) await store.setAct({ h: activeH, b: activeB });
  return armed;
}

module.exports = {
  ENABLED, START, END, AHEAD, PACE_MS, CAP,
  inWindow, targetDay, startText, windowText, info, fast, windowOver, arm
};
