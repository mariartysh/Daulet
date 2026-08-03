// Хранилище состояния: Upstash Redis (REST). Без него — память процесса (локальная отладка).
const URL_ = process.env.UPSTASH_REDIS_REST_URL, TOK = process.env.UPSTASH_REDIS_REST_TOKEN;
let mem = null;
const KEY = 'autobook:state';

async function cmd(arr) {
  const r = await fetch(URL_, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(arr)
  });
  const j = await r.json();
  if (j.error) throw new Error('Upstash: ' + j.error);
  return j.result;
}

function defaults() {
  return {
    password: process.env.APP_PASSWORD || 'admin',
    botOn: true,             // глобальный выключатель (только владелец)
    chats: [],               // чаты [{id, name, u, at, last, acts}]
    pending: null,           // {chat, field} — ждём текстовый ввод (имя/телефон/почта)
    profile: { name: '', phone: '', email: '' },
    task: {
      active: false,
      mode: 'confirm',       // confirm = сначала спросить в TG | auto = бронировать сразу
      needed: 1,
      type: 'any',           // any | indoor (№1–8) | outdoor (№1–5)
      courts: [],            // номера в рамках типа ([] = любой)
      dayOffsets: [0],       // 0 сегодня · 1 завтра · 2 послезавтра
      timeFrom: '20:00', timeTo: '22:00',
      dur: 60,               // минуты: 60 | 120 | 180
      interval: 15,          // частота обновления расписания, сек: 1|5|10|15|30|60
      split: true            // набирать часы по отдельности (разные корты, время и тип)
    },
    bookings: [],            // {id, recordId, hash, staffId, court, indoor, name, start, dur, price, service, cancelled}
    offers: [],              // найденные слоты, ждут «Забрать»/«Пропустить»
    seen: {},                // slotKey -> ts (анти-дубль)
    reminded: {},            // bookingId -> 1
    stats: { checks: 0, found: 0, booked: 0, errors: 0, startedAt: 0 },
    staffCache: null,
    svcCache: null,
    apiBase: null,           // рабочая база API (подбирается автоматически)
    rot: 0,
    log: []
  };
}

async function load() {
  if (!URL_ || !TOK) { mem = mem || defaults(); return mem; }
  const raw = await cmd(['GET', KEY]);
  let s = defaults();
  if (raw) { try { s = Object.assign(s, JSON.parse(raw)); } catch {} }
  // миграция со старых версий
  if (s.ownerChat && !(s.chats || []).length) s.chats = [{ id: s.ownerChat, name: 'владелец' }];
  if (!s.task.dayOffsets) s.task.dayOffsets = [0];
  if (![60, 120, 180].includes(s.task.dur)) s.task.dur = 60;
  if (![1, 5, 10, 15, 30, 60].includes(s.task.interval)) s.task.interval = 15;
  if (s.task.split === undefined) s.task.split = true;
  if (!Array.isArray(s.offers)) s.offers = [];
  if (s.botOn === undefined) s.botOn = true;
  return s;
}

async function save(s) {
  const now = Date.now();
  for (const k of Object.keys(s.seen)) if (s.seen[k] < now - 3 * 86400e3) delete s.seen[k];
  s.log = s.log.slice(0, 150);
  s.offers = (s.offers || []).filter(o => o.start > now + 10 * 60e3).slice(0, 12);
  if (!URL_ || !TOK) { mem = s; return; }
  await cmd(['SET', KEY, JSON.stringify(s)]);
}

function log(s, m, warn) {
  s.log.unshift({ t: Date.now(), m: String(m).slice(0, 400), w: warn ? 1 : 0 });
}

module.exports = { load, save, log, defaults };
