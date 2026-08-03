// Хранилище состояния: Upstash Redis (REST). Без него — память процесса (только для локальной отладки).
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
    ownerChat: null,
    profile: { name: '', phone: '', email: '' },
    task: {
      active: false, mode: 'auto', needed: 3,
      type: 'any',           // any | indoor | outdoor (крытые 1–8, уличные 1–5)
      courts: [],            // номера в рамках типа ([] = любой корт)
      dayOffsets: [0, 1, 2], // сегодня / завтра / послезавтра
      timeFrom: '18:00', timeTo: '22:00',
      dur: 60                // минуты: 60 | 120 | 180
    },
    bookings: [],            // {id, recordId, hash, staffId, court, indoor, start(ms), dur, price, service, cancelled, done}
    seen: {},                // slotKey -> ts (анти-дубль уведомлений)
    reminded: {},            // bookingId -> 1
    stats: { checks: 0, found: 0, booked: 0, errors: 0, startedAt: 0 },
    staffCache: null,        // {ts, list:[{id,name,court,indoor}]}
    apiBase: null,           // рабочая база API (подбирается автоматически)
    svcCache: null,          // {ts, byStaff:{staffId:[{id,title,len,price}]}}
    rot: 0,
    log: []
  };
}

async function load() {
  if (!URL_ || !TOK) { mem = mem || defaults(); return mem; }
  const raw = await cmd(['GET', KEY]);
  if (!raw) return defaults();
  try { return Object.assign(defaults(), JSON.parse(raw)); } catch { return defaults(); }
}

async function save(s) {
  // подрезаем разросшееся
  const now = Date.now();
  for (const k of Object.keys(s.seen)) if (s.seen[k] < now - 3 * 86400e3) delete s.seen[k];
  s.log = s.log.slice(0, 150);
  if (!URL_ || !TOK) { mem = s; return; }
  await cmd(['SET', KEY, JSON.stringify(s)]);
}

function log(s, m, warn) {
  s.log.unshift({ t: Date.now(), m: String(m).slice(0, 400), w: warn ? 1 : 0 });
}

module.exports = { load, save, log, defaults };
