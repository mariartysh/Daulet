// Клиент публичного API онлайн-записи Altegio (Online Booking).
// ALTEGIO_AUTH — полное значение заголовка Authorization из DevTools,
// например "Bearer gtcwf654agufy25gsadh".
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
const getTimes = (staffId, date, serviceId, base) =>
  api(`/book_times/${CID}/${staffId}/${date}${serviceId ? `?service_ids[]=${serviceId}` : ''}`, {}, base);
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

module.exports = { api, batch, getStaff, getServices, getTimes, getDates, book, cancel, CID, BASES, SITE_HOST, banned, banFor, banLeft };
