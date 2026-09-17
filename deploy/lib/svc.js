// Общий слой действий. И Telegram-бот, и мини-приложение вызывают ТОЛЬКО эти функции,
// поэтому кнопки в боте и на экране делают ровно одно и то же: остановил в боте —
// в панели тоже остановлено, и наоборот.
const crypto = require('crypto');
const store = require('./store');
const hunt = require('./hunt');
const chain = require('./chain');
const L = require('./logic');

const ADMIN_U = (process.env.ADMIN_USERNAME || 'gaucho_bro').toLowerCase().replace('@', '');
const ADMIN_UID = Number(process.env.ADMIN_UID || 0);

// Владелец узнаётся по нику или по числовому id — ДО всякого пароля.
// Это страховка от «пароль в базе не тот, что я помню, и сменить некому».
const isOwnerFrom = from => {
  const uid = Number((from && from.id) || 0);
  const un = String((from && from.username) || '').toLowerCase().replace('@', '');
  return (!!ADMIN_UID && uid === ADMIN_UID) || (!!un && un === ADMIN_U);
};

// Пароль сравниваем без крайних пробелов (их легко прихватить при копировании).
// Кроме пароля из базы всегда принимается APP_PASSWORD из переменных Vercel —
// мастер-ключ: поменяли переменную, сделали Redeploy — вход снова работает.
function checkPassword(g, pw) {
  const p = String(pw == null ? '' : pw).trim();
  if (!p) return false;
  const stored = String((g && g.password) || '').trim();
  const master = String(process.env.APP_PASSWORD || '').trim();
  return (!!stored && p === stored) || (!!master && p === master);
}

// ---------- тарифы (задел под подписку) ----------
// Пока все лимиты одинаковые: ничего не ограничено. Чтобы включить платный режим,
// урежьте free (например hunts: 1, minInterval: 10) и ставьте пользователю
// row.plan = { tier: 'pro', until: <timestamp> } после оплаты.
const PLANS = {
  free: { hunts: store.MAX_HUNTS, minInterval: 2, contacts: store.MAX_CONTACTS },
  pro: { hunts: store.MAX_HUNTS, minInterval: 2, contacts: store.MAX_CONTACTS }
};
const planOf = row => {
  const p = row && row.plan;
  if (!p || !p.tier) return 'free';
  if (p.until && p.until < Date.now()) return 'free';      // подписка кончилась
  return PLANS[p.tier] ? p.tier : 'free';
};
const limits = row => PLANS[planOf(row)];

// ---------- контекст ----------
async function ctx(uid) {
  const g = await store.loadGlobal();
  const u = uid ? await store.loadUser(uid) : null;
  if (u) bind(g, u);
  return { g, u };
}
function bind(g, u) {
  const a = (g.users || []).find(x => x.uid === g.adminUid);
  u.adminChat = a ? a.chat : 0;
  u.isAdmin = isAdmin(g, u.uid, u.u);
  return u;
}
// Владелец — это либо записанный в базе adminUid, либо совпадение с ADMIN_UID/ADMIN_USERNAME.
// Права владельца не зависят от содержимого базы: сменить пароль он может всегда.
const isAdmin = (g, uid, uname) => {
  const id = Number(uid || 0);
  if (!id) return false;
  if (Number(g && g.adminUid) === id) return true;
  return isOwnerFrom({ id, username: uname });
};
const userRow = (g, uid) => (g.users || []).find(x => Number(x.uid) === Number(uid));

// Регистрация пользователя после верного пароля
async function linkUser(g, from, chat) {
  const uid = Number(from.id || chat);
  let row = userRow(g, uid);
  if (!row) {
    row = { uid, chat: Number(chat), name: from.first_name || '', u: (from.username || ''), at: Date.now(), last: Date.now(), acts: 0 };
    g.users.push(row);
  }
  row.chat = Number(chat);
  row.name = from.first_name || row.name;
  row.u = from.username || row.u;
  row.blocked = false;
  const byName = isOwnerFrom(from);
  if (!g.adminUid || byName) g.adminUid = byName ? uid : (g.adminUid || uid);
  const u = await store.loadOrCreate(uid, chat);
  u.chat = Number(chat); u.name = row.name; u.u = row.u;
  bind(g, u);
  await store.saveGlobal(g);
  await store.saveUser(u);
  return { u, row };
}

function touch(g, uid) {
  const r = userRow(g, uid);
  if (!r) return;
  if (Date.now() - (r.last || 0) < 300000) return;   // не пишем базу на каждый опрос панели
  r.last = Date.now(); r.acts = (r.acts || 0) + 1;
}

// ---------- телефон ----------
// Телефон КЗ: оставляем 10 цифр абонента, +7 добавляем сами.
// «8 705…», «+7 705…», «705…» — всё сводится к одному виду.
function normPhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.length > 10 && (d[0] === '7' || d[0] === '8')) d = d.slice(1);
  d = d.slice(0, 10);
  return d.length === 10 ? '+7' + d : '';
}

// ---------- охоты ----------
const findHunt = (u, id) => u.hunts.find(h => h.id === id) || u.hunts[0];

function addHunt(u) {
  if (u.hunts.length >= store.MAX_HUNTS) return { ok: false, why: `Больше ${store.MAX_HUNTS} охот одновременно нельзя` };
  const src = u.hunts[u.hunts.length - 1] || {};
  const h = store.newHunt({
    days: [...(src.days || [store.isoToday(0)])],
    timeFrom: src.timeFrom, timeTo: src.timeTo, interval: src.interval, mode: src.mode, type: src.type
  });
  u.hunts.push(h);
  store.log(u, `Добавил охоту (всего ${u.hunts.length})`);
  return { ok: true, h };
}

function removeHunt(u, id) {
  if (u.hunts.length <= 1) return { ok: false, why: 'Последнюю охоту удалить нельзя — просто остановите её' };
  const h = u.hunts.find(x => x.id === id);
  if (!h) return { ok: false, why: 'Охота не найдена' };
  if (hunt.activeBookings(h).length) return { ok: false, why: 'В этой охоте есть брони — сначала отмените их' };
  u.hunts = u.hunts.filter(x => x.id !== id);
  store.log(u, 'Удалил охоту');
  return { ok: true };
}

// Правка плана. Меняем только переданные поля, всё нормализуем в одном месте.
function patchHunt(u, h, patch) {
  const p = patch || {};
  const before = JSON.stringify({ ...h, active: 0, stats: 0, bookings: 0, offers: 0, seen: 0, reminded: 0 });
  if (p.title !== undefined) h.title = String(p.title).slice(0, 40);
  if (p.mode !== undefined && ['auto', 'confirm'].includes(p.mode)) h.mode = p.mode;
  if (p.needed !== undefined) h.needed = Math.max(1, Math.min(10, Number(p.needed) || 1));
  if (p.type !== undefined && ['any', 'indoor', 'outdoor'].includes(p.type)) { h.type = p.type; if (h.type === 'any') h.courts = []; }
  if (p.courts !== undefined) h.courts = (Array.isArray(p.courts) ? p.courts : []).map(Number).filter(n => n >= 1 && n <= 8).sort();
  if (p.cIdx !== undefined) h.cIdx = (Array.isArray(p.cIdx) ? p.cIdx : []).map(Number)
    .filter(n => Number.isInteger(n) && n >= 0 && n < (u.contacts || []).length).sort();
  if (p.days !== undefined) {
    const ok = (Array.isArray(p.days) ? p.days : []).filter(x => /^\d{4}-\d{2}-\d{2}$/.test(x));
    const today = store.isoToday(0);
    h.days = ok.filter(x => x >= today).slice(0, 3).sort();
    if (!h.days.length) h.days = [today];
  }
  if (p.timeFrom !== undefined) h.timeFrom = String(p.timeFrom);
  if (p.timeTo !== undefined) h.timeTo = String(p.timeTo);
  if (p.interval !== undefined && store.IVS.includes(Number(p.interval))) h.interval = Number(p.interval);
  L.fitWindow(h);
  const changed = before !== JSON.stringify({ ...h, active: 0, stats: 0, bookings: 0, offers: 0, seen: 0, reminded: 0 });
  if (changed) { hunt.pruneOffers(u, h); h.seen = {}; h.noFitSent = 0; }   // фильтр поменялся — анти-дубль и «нет кортов» обнуляем
  return changed;
}

// Всё, что раньше приходилось делать вручную кнопкой «Очистить данные».
function sanitize(u, h) {
  hunt.dropPhantoms(u);
  L.rollDays(h, Date.now());
  if (!h.days.length) h.days = [store.isoToday(0)];
  h.offers = [];
  h.seen = {};
  h.reminded = {};
  h.noFitSent = 0;
  u.bo = { fails: 0, ban: 0 };
  u.targets = null; u.svcCache = null;               // список кортов перечитываем заново
  for (const b of h.bookings || []) if (b.start < Date.now() - 3600e3) b.cancelled = true;
}

async function startHunt(u, g, h, req, src) {
  if (g.botOn === false) return { ok: false, why: 'Бот выключен владельцем' };
  const row = userRow(g, u.uid);
  if (row && row.blocked) return { ok: false, why: 'Доступ закрыт владельцем' };
  const lim = limits(row);
  const running = u.hunts.filter(x => x.active && x.id !== h.id).length;
  if (running >= lim.hunts) return { ok: false, why: `Одновременно можно вести ${lim.hunts} ${lim.hunts === 1 ? 'охоту' : 'охоты'} — остановите одну` };
  if (Number(h.interval) < lim.minInterval) h.interval = lim.minInterval;
  const ready = hunt.huntContacts(u, h);
  if (!ready.length) return { ok: false, why: (u.contacts || []).some(c => c.name && c.phone)
    ? 'В этой охоте не выбран контакт — отметьте, на кого бронировать'
    : 'Сначала контакт: на кого бронировать? Имя и телефон' };
  if (h.needed > 1 && ready.length < 2) {
    // не блокируем, но предупреждаем: несколько кортов на одно имя администрация отменяет
    store.log(u, 'Внимание: несколько кортов на одно имя могут отменить — добавьте второй контакт', 1);
  }
  L.rollDays(h, Date.now());
  if (!h.days.length) return { ok: false, why: 'Выбранные дни уже прошли — отметьте новый день' };
  if (hunt.leftSlots(h) <= 0) return { ok: false, why: 'Цель уже набрана — добавьте день или увеличьте число кортов' };
  sanitize(u, h);
  h.active = true;
  h.actBy = 'user';
  h.startedAt = Date.now();
  store.log(u, `${hunt.label(h)}: охота запущена (${src || 'панель'}) — проверка каждые ${h.interval} с, нужно ${h.needed} на день`);
  await hunt.sweep(u, h).catch(e => store.log(u, 'Первый проход не удался: ' + e.message, 1));
  u.kickAt = Date.now();
  await store.saveUser(u);
  await store.setAct({ h: 1, b: 1 });          // чтобы пингер сразу знал: есть что вести
  await chain.drop();
  const okA = await chain.spawn(req, 'a', { confirm: true });
  if (chain.STRANDS.includes('b')) await chain.spawn(req, 'b', { confirm: false, delay: 20 });
  if (!okA) {
    const f = await store.loadUser(u.uid);
    const why = !process.env.TICK_KEY ? 'не задан TICK_KEY'
      : !(process.env.APP_URL || '').trim() ? 'не задан APP_URL — самовызов идти некуда'
      : 'сервер не ответил на самовызов';
    if (f) { store.log(f, `Фоновая ветка не поднялась (${why}) — жду пингер, откройте /api/health?key=TICK_KEY`, 1); await store.saveUser(f); }
  }
  return { ok: true, bg: okA };
}

async function stopHunt(u, g, h, req, src) {
  const was = h.active;
  h.active = false;
  h.actBy = 'user';
  h.offers = [];
  if (was) store.log(u, `${hunt.label(h)}: охота остановлена (${src || 'панель'})`);
  await store.saveUser(u);
  const anyLeft = u.hunts.some(x => x.active);
  if (!anyLeft) {
    const others = await anyoneHunting(g, u.uid);
    if (!others) { await store.setAct({ h: 0, b: hunt.allActiveBookings(u).length }); await chain.drop(); }
  }
  return { ok: true, was };
}

// Есть ли у кого-то ещё активная охота (чтобы не гасить общие ветки)
async function anyoneHunting(g, exceptUid) {
  const list = (g.users || []).filter(x => !x.blocked && Number(x.uid) !== Number(exceptUid));
  if (!list.length) return false;
  const us = await store.loadUsers(list);
  return us.some(x => (x.hunts || []).some(h => h.active));
}

// Поднять мёртвые ветки (не чаще раза в 20 сек)
async function kick(req, u) {
  if (!process.env.TICK_KEY) return [];
  if (!u.hunts.some(h => h.active)) return [];
  if (Date.now() - (u.kickAt || 0) < 20e3) return [];
  u.kickAt = Date.now();
  return chain.revive(req, { confirm: false });
}

// ---------- контакты ----------
function setContact(u, i, patch) {
  u.contacts = u.contacts || [];
  const idx = Number(i);
  if (idx >= store.MAX_CONTACTS) return { ok: false, why: `Максимум ${store.MAX_CONTACTS} контактов` };
  while (u.contacts.length <= idx) u.contacts.push({ name: '', phone: '', email: '' });
  const c = u.contacts[idx];
  if (patch.name !== undefined) c.name = String(patch.name).slice(0, 60);
  if (patch.phone !== undefined) c.phone = normPhone(patch.phone) || String(patch.phone || '').slice(0, 20);
  if (patch.email !== undefined) c.email = String(patch.email).slice(0, 80);
  return { ok: true };
}
function delContact(u, i) {
  u.contacts = (u.contacts || []).filter((_, k) => k !== Number(i));
  return { ok: true };
}
function setContacts(u, list) {
  u.contacts = [];
  (Array.isArray(list) ? list : []).slice(0, store.MAX_CONTACTS).forEach((c, i) => setContact(u, i, c || {}));
  u.contacts = u.contacts.filter((c, i) => i === 0 || c.name || c.phone);
  const n = u.contacts.length;
  for (const h of u.hunts || []) h.cIdx = (h.cIdx || []).filter(i => i < n);
  return { ok: true };
}

// ---------- токен панели ----------
const secret = () => process.env.TICK_KEY || process.env.APP_PASSWORD || 'salt';
const sign = uid => crypto.createHmac('sha256', secret()).update('panel:' + uid).digest('hex').slice(0, 32);
const mkToken = uid => `${uid}.${sign(uid)}`;
function readToken(t) {
  const [uid, sig] = String(t || '').split('.');
  if (!uid || !sig) return 0;
  return sig === sign(uid) ? Number(uid) : 0;
}

// Проверка подписи Telegram WebApp initData — так панель узнаёт пользователя без пароля
function checkInitData(initData) {
  try {
    const token = process.env.TELEGRAM_TOKEN;
    if (!token || !initData) return 0;
    const p = new URLSearchParams(initData);
    const hash = p.get('hash');
    if (!hash) return 0;
    p.delete('hash');
    const data = [...p.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => `${k}=${v}`).join('\n');
    const key = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
    const calc = crypto.createHmac('sha256', key).update(data).digest('hex');
    if (calc !== hash) return 0;
    const authDate = Number(p.get('auth_date') || 0) * 1000;
    if (authDate && Date.now() - authDate > 30 * 86400e3) return 0;
    const user = JSON.parse(p.get('user') || '{}');
    return Number(user.id) || 0;
  } catch (e) { return 0; }
}

module.exports = {
  ADMIN_U, ADMIN_UID, isOwnerFrom, checkPassword,
  PLANS, planOf, limits, ctx, bind, isAdmin, userRow, linkUser, touch, normPhone,
  findHunt, addHunt, removeHunt, patchHunt, sanitize, startHunt, stopHunt,
  anyoneHunting, kick, setContact, delContact, setContacts,
  mkToken, readToken, checkInitData
};
