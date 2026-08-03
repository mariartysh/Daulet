// Клиент публичного API онлайн-записи Altegio (Online Booking API).
// Документация: developer.alteg.io → Online Booking. База: api.alteg.io/api/v1.
// ALTEGIO_AUTH — полное значение заголовка Authorization из DevTools,
// например "Bearer gtcwf654agufy25gsadh" (см. README, шаг 3).
// Токен виджета может действовать только на домене сайта — поэтому клиент
// умеет работать с несколькими базами, рабочая подбирается автоматически.
const CID = process.env.COMPANY_ID || '521176';
const SITE_HOST = process.env.SITE_HOST || 'tennisdaulet.altegio.me';
const BASES = [
  process.env.ALTEGIO_BASE,
  'https://api.alteg.io/api/v1',
  `https://${SITE_HOST}/api/v1`
].filter(Boolean);

async function api(path, opt = {}, base) {
  const r = await fetch(`${base || BASES[0]}${path}`, {
    ...opt,
    headers: {
      Authorization: process.env.ALTEGIO_AUTH || '',
      Accept: 'application/vnd.api.v2+json',
      'Content-Type': 'application/json',
      ...(opt.headers || {})
    }
  });
  const text = await r.text();
  let j;
  try { j = JSON.parse(text); } catch { j = { success: r.ok, raw: text.slice(0, 300) }; }
  if (typeof j !== 'object' || j === null) j = { success: false, raw: String(j) };
  j._status = r.status;
  if (j.success === undefined) j.success = r.ok;
  return j;
}

const getStaff = base => api(`/book_staff/${CID}`, {}, base);
const getServices = (staffId, base) => api(`/book_services/${CID}${staffId ? `?staff_id=${staffId}` : ''}`, {}, base);
const getTimes = (staffId, date, serviceId, base) =>
  api(`/book_times/${CID}/${staffId}/${date}${serviceId ? `?service_ids[]=${serviceId}` : ''}`, {}, base);

// Создание брони. datetime — ISO с таймзоной, напр. "2026-08-07T20:00:00+05:00"
// Ответ: data[] с {id, record_id, record_hash} — по ним работает отмена.
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

// Отмена онлайн-записи: DELETE /user/records/{record_id}/{record_hash}
const cancel = (recordId, hash, base) => api(`/user/records/${recordId}/${hash}`, { method: 'DELETE' }, base);

module.exports = { api, getStaff, getServices, getTimes, book, cancel, CID, BASES };
