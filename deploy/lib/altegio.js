// Клиент публичного API онлайн-записи Altegio (Online Booking).
// ALTEGIO_AUTH — полное значение заголовка Authorization из DevTools,
// например "Bearer xxxxxxxxxxxxxxxxxxxx".
//
// Заголовки максимально похожи на браузерные, User-Agent ротируется:
// одинаковый «отпечаток» на высокой частоте — первое, за что прилетает 429/403.
const CID = process.env.COMPANY_ID || '521176';
const SITE_HOST = process.env.SITE_HOST || 'tennisdaulet.altegio.me';
const BASES = [
  process.env.ALTEGIO_BASE,
  'https://api.alteg.io/api/v1',
  'https://alteg.io/api/v1',
  `https://${SITE_HOST}/api/v1`
].filter(Boolean);

const UAS = [
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15'
];
const ua = () => UAS[Math.floor(Math.random() * UAS.length)];

const BAN_CODES = [401, 403, 429];
let banUntil = 0;                     // общий «стоп-кран» на процесс: пришёл 429 — не долбим
const banned = () => Date.now() < banUntil;
const banFor = ms => { banUntil = Math.max(banUntil, Date.now() + ms); };
const banLeft = () => Math.max(0, banUntil - Date.now());

// ---------- регулятор темпа ----------
// Ждать 429, чтобы притормозить, — поздно: бан стоит 20+ секунд, за которые корт уводят.
// Поэтому давление копится с каждого отказа и медленно стекает на успешных ответах:
// сайт начал огрызаться — идём реже; молчит — сами разгоняемся обратно к заданной частоте.
let pressure = 0;                     // 0 = сайт спокоен, 1 = злится
const UP = Number(process.env.PRESSURE_UP || 0.34);      // насколько добавляет один отказ
const DOWN = Number(process.env.PRESSURE_DOWN || 0.004); // насколько снимает один успех
const MAXX = Number(process.env.SLOW_MAX || 5);          // во сколько раз максимум замедляемся
function noteStatus(status) {
  if (BAN_CODES.includes(status)) pressure = Math.min(1, pressure + UP);
  else if (status >= 200 && status < 400) pressure = Math.max(0, pressure - DOWN);
}
const slowFactor = () => 1 + pressure * (MAXX - 1);
const pressureNow = () => Math.round(pressure * 100);

async function api(path, opt = {}, base) {
  const r = await fetch(`${base || BASES[0]}${path}`, {
    ...opt,
    headers: {
      Authorization: process.env.ALTEGIO_AUTH || '',
      Accept: 'application/vnd.api.v2+json',
      'Content-Type': 'application/json',
      'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
      'User-Agent': ua(),
      Origin: `https://${SITE_HOST}`,
      Referer: `https://${SITE_HOST}/`,
      'Sec-Fetch-Site': 'cross-site',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Dest': 'empty',
      ...(opt.headers || {})
    }
  });
  const text = await r.text();
  let j;
  try { j = JSON.parse(text); } catch { j = { success: r.ok, raw: text.slice(0, 300) }; }
  if (typeof j !== 'object' || j === null) j = { success: false, raw: String(j) };
  j._status = r.status;
  if (j.success === undefined) j.success = r.ok;
  noteStatus(r.status);
  if (BAN_CODES.includes(r.status)) {
    j._ban = r.status;
    const ra = Number(r.headers.get('retry-after')) || 0;
    banFor(r.status === 429 ? Math.max(20e3, ra * 1000) : 15e3);
  }
  return j;
}

// Пачка запросов параллельно, порциями — так полный обход кортов занимает
// не 13 × 300 мс, а один сетевой круг. cap подобран, чтобы не ловить 429.
async function batch(tasks, cap) {
  const n = Math.max(1, Math.min(8, cap || Number(process.env.PARALLEL) || 6));
  const out = new Array(tasks.length);
  let i = 0;
  const worker = async () => {
    while (i < tasks.length) {
      const k = i++;
      try { out[k] = await tasks[k](); }
      catch (e) { out[k] = { success: false, raw: e.message, _status: 0 }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, worker));
  return out;
}

const getStaff = base => api(`/book_staff/${CID}`, {}, base);
const getServices = (staffId, base) => api(`/book_services/${CID}${staffId ? `?staff_id=${staffId}` : ''}`, {}, base);
// Расписание одного корта на одну дату. ОБЩИЙ кэш на процесс, живёт доли секунды.
// Смысл: когда корты ищут 3-4 человека сразу, они спрашивают у сайта одно и то же.
// Раньше это было 4 одинаковых запроса за секунду — сайт видел четырёхкратную нагрузку
// и раздавал 429 всем. Теперь запрос уходит один, а ответ получают все охоты.
const TIMES_TTL = Number(process.env.TIMES_TTL_MS || 1200);
const tCache = new Map();
let shared = 0, fetched = 0;
function getTimes(staffId, date, serviceId, base) {
  const path = `/book_times/${CID}/${staffId}/${date}${serviceId ? `?service_ids[]=${serviceId}` : ''}`;
  if (TIMES_TTL <= 0) return api(path, {}, base);
  const key = (base || BASES[0]) + path;
  const hit = tCache.get(key);
  if (hit && Date.now() - hit.at < TIMES_TTL) { shared++; return hit.p; }
  fetched++;
  const p = api(path, {}, base).then(
    j => { if (!j || !j.success) tCache.delete(key); return j; },
    e => { tCache.delete(key); throw e; }
  );
  tCache.set(key, { at: Date.now(), p });
  if (tCache.size > 300) for (const [k, v] of tCache) if (Date.now() - v.at > 5000) tCache.delete(k);
  return p;
}
const cacheStats = () => ({ запросов: fetched, сэкономлено: shared, ttl_мс: TIMES_TTL });
const getDates = (staffId, serviceId, base) =>
  api(`/book_dates/${CID}?staff_id=${staffId || 0}${serviceId ? `&service_ids[]=${serviceId}` : ''}`, {}, base);

const book = ({ phone, fullname, email, staffId, serviceId, datetime, comment }, base) =>
  api(`/book_record/${CID}`, {
    method: 'POST',
    body: JSON.stringify({
      phone, fullname, email: email || '',
      notify_by_sms: 0, notify_by_email: 0,
      comment: comment || '',
      appointments: [{ id: 1, services: serviceId ? [serviceId] : [], staff_id: staffId, datetime }]
    })
  }, base);

const cancel = (recordId, hash, base) => api(`/user/records/${recordId}/${hash}`, { method: 'DELETE' }, base);
// Прочитать свою запись по номеру и хэшу (тот же адрес, что и для отмены): вход по телефону не нужен.
const getRecord = (recordId, hash, base) => api(`/user/records/${recordId}/${hash}`, {}, base);

module.exports = { api, batch, getStaff, getServices, getTimes, getDates, book, cancel, getRecord, CID, BASES, SITE_HOST, banned, banFor, banLeft, slowFactor, pressureNow, cacheStats };
