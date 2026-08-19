// Хранилище: Upstash Redis (REST). Без него — память процесса (локальная отладка).
//
// Схема v3 — многопользовательская:
//   ch:g          глобально: пароль, общий выключатель, список пользователей
//   ch:u:<uid>    состояние одного пользователя: контакты, охоты, брони, журнал
//   ch:hb:a|b     сердцебиение фоновых веток
// Старое единое состояние (autobook:state) переносится в первого пользователя автоматически.
const URL_ = process.env.UPSTASH_REDIS_REST_URL, TOK = process.env.UPSTASH_REDIS_REST_TOKEN;
const G = 'ch:g';
const UK = uid => `ch:u:${uid}`;
const HB = k => `ch:hb:${k}`;
const OLD = 'autobook:state';
const live = !!(URL_ && TOK);
let mem = { g: null, u: {}, hb: {}, act: '' };

// ---------- экономия команд ----------
// Один вызов функции живёт до минуты и раньше дёргал базу на каждом шаге цикла.
// Теперь свежие данные держим в памяти вызова, пишем только изменившееся,
// а «есть ли вообще активные охоты» узнаём одним коротким ключом ch:act.
const ACT = 'ch:act';
let cG = null, cGAt = 0, wG = '';            // кэш глобального и последняя запись
let cU = {}, cUAt = 0, wU = {}, dU = {};     // кэш пользователей, записанное, несохранённые
let lastBeat = {}, lastAct = '';
let cnt = 0, folded = 0;                     // сколько команд отправил этот вызов и сколько из них уже учтено
const BUDGET = Number(process.env.CMD_BUDGET || 400000);
const fresh = (at, maxAge) => !!(maxAge && at && Date.now() - at < maxAge);

async function cmd(arr) {
  cnt++;
  const r = await fetch(URL_, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(arr)
  });
  const j = await r.json();
  if (j.error) throw new Error('Upstash: ' + j.error);
  return j.result;
}

const MAX_HUNTS = Number(process.env.MAX_HUNTS || 3);
const MAX_CONTACTS = Number(process.env.MAX_CONTACTS || 5);
const IVS = [2, 3, 5, 7, 10];                 // допустимые частоты проверки, сек
const DEF_IV = Number(process.env.DEF_INTERVAL || 3);

const newId = () => Math.random().toString(36).slice(2, 9);
const isoToday = off => {
  const o = (Number(process.env.TZ_OFFSET) || 5) * 3600e3;
  return new Date(Date.now() + o + (off || 0) * 86400e3).toISOString().slice(0, 10);
};

function newHunt(patch) {
  return Object.assign({
    id: newId(),
    title: '',
    active: false,
    mode: 'auto',                // auto = бронировать сразу | confirm = спросить в TG
    needed: 1,                   // сколько кортов (часов) на каждый выбранный день
    type: 'any',                 // any | indoor | outdoor
    courts: [],                  // номера в рамках типа ([] = любой)
    days: [isoToday(0)],         // АБСОЛЮТНЫЕ даты — «завтра» само становится «сегодня» после полуночи
    timeFrom: '18:00', timeTo: '23:00',
    interval: DEF_IV,
    startedAt: 0,
    stats: { checks: 0, found: 0, booked: 0, errors: 0 },
    bookings: [], offers: [], seen: {}, reminded: {}, rot: 0
  }, patch || {});
}

function defGlobal() {
  return {
    v: 3,
    password: process.env.APP_PASSWORD || 'admin',
    botOn: true,
    adminUid: 0,
    users: [],           // [{uid, chat, name, u, at, last, acts, blocked, plan}]
    log: []
  };
}

function defUser(uid, chat) {
  return {
    uid: Number(uid) || 0,
    chat: Number(chat) || Number(uid) || 0,
    name: '', u: '',
    contacts: [],        // [{name, phone, email}] — первый основной
    hunts: [newHunt()],
    apiBase: null,
    targets: null, svcCache: null,
    bo: { fails: 0, ban: 0 },
    lastErrPing: 0,
    pending: null,        // {field, huntId} — ждём текстовый ввод
    ui: {},              // что открыто в боте: {view, huntId, ci}
    log: []
  };
}

// ---------- счётчик команд (чтобы не упереться в лимит молча) ----------
// Свой счёт ведём в памяти и прикладываем к глобальному состоянию в момент, когда его и так записываем —
// отдельных обращений к базе счётчик не стоит. Цифра оценочная, но близкая.
const month = () => new Date().toISOString().slice(0, 7);
function fold(g) {
  if (!g.cmd || g.cmd.m !== month()) { g.cmd = { m: month(), n: 0 }; folded = cnt; return g; }
  g.cmd.n += Math.max(0, cnt - folded);
  folded = cnt;
  return g;
}
const used = g => (g && g.cmd && g.cmd.m === month() ? g.cmd.n : 0) + Math.max(0, cnt - folded);
const budget = () => BUDGET;
const overBudget = g => BUDGET > 0 && used(g) > BUDGET;

// ---------- глобальное ----------
// maxAge — сколько миллисекунд можно отдавать копию из памяти вызова (0 = всегда читать базу)
async function loadGlobal(maxAge) {
  if (cG && fresh(cGAt, maxAge)) return cG;
  const g = await readGlobal();
  cG = g; cGAt = Date.now();
  return g;
}

async function readGlobal() {
  if (!live) { mem.g = mem.g || defGlobal(); return mem.g; }
  const raw = await cmd(['GET', G]);
  if (raw) { try { return Object.assign(defGlobal(), JSON.parse(raw)); } catch {} }
  const g = defGlobal();
  const old = await cmd(['GET', OLD]).catch(() => null);
  if (old) {
    try {
      const o = JSON.parse(old);
      g.password = o.password || g.password;
      g.botOn = o.botOn !== false;
      g.users = (o.chats || []).map(c => ({
        uid: Number(c.id || c), chat: Number(c.id || c), name: c.name || '', u: c.u || '',
        at: c.at || Date.now(), last: c.last || 0, acts: c.acts || 0
      }));
      const admin = (process.env.ADMIN_USERNAME || '').toLowerCase().replace('@', '');
      const a = g.users.find(x => (x.u || '').toLowerCase() === admin) || g.users[0];
      if (a) g.adminUid = a.uid;
      g.log.unshift({ t: Date.now(), m: 'Перенёс старые данные в новую схему: у каждого свой профиль и свои охоты' });
      await cmd(['SET', G, JSON.stringify(g)]);
      for (const x of g.users) {                                   // контакты и брони — первому (владельцу)
        const u = defUser(x.uid, x.chat);
        u.name = x.name; u.u = x.u;
        if (x.uid === g.adminUid) {
          if (o.profile && (o.profile.name || o.profile.phone)) u.contacts = [{ name: o.profile.name || '', phone: o.profile.phone || '', email: o.profile.email || '' }];
          const t = o.task || {};
          u.hunts = [newHunt({
            active: false, mode: t.mode === 'confirm' ? 'confirm' : 'auto',
            needed: Math.max(1, Math.min(10, Number(t.needed) || 1)),
            type: ['any', 'indoor', 'outdoor'].includes(t.type) ? t.type : 'any',
            courts: Array.isArray(t.courts) ? t.courts : [],
            timeFrom: '18:00', timeTo: '23:00'
          })];
          u.hunts[0].bookings = (o.bookings || []).filter(b => !b.cancelled);
        }
        await cmd(['SET', UK(x.uid), JSON.stringify(u)]);
      }
      return g;
    } catch {}
  }
  await cmd(['SET', G, JSON.stringify(g)]);
  return g;
}

async function saveGlobal(g) {
  g.log = (g.log || []).slice(0, 80);
  fold(g);
  cG = g; cGAt = Date.now();
  if (!live) { mem.g = g; return; }
  const json = JSON.stringify(g);
  if (json === wG) return;                   // ничего не изменилось — не тратим команду
  await cmd(['SET', G, json]);
  wG = json;
}

// ---------- пользователи ----------
function fixUser(u) {
  const d = defUser(u.uid, u.chat);
  const out = Object.assign(d, u);
  out.contacts = (Array.isArray(out.contacts) ? out.contacts : []).slice(0, MAX_CONTACTS)
    .map(c => ({ name: String(c.name || '').slice(0, 60), phone: String(c.phone || '').slice(0, 20), email: String(c.email || '').slice(0, 80) }));
  out.hunts = (Array.isArray(out.hunts) && out.hunts.length ? out.hunts : [newHunt()]).slice(0, MAX_HUNTS).map(h => {
    const n = newHunt(h);
    delete n.dur; delete n.split; delete n.dayOffsets;           // ушли из модели
    if (!Array.isArray(n.days) || !n.days.length) n.days = [isoToday(0)];
    n.days = n.days.filter(x => /^\d{4}-\d{2}-\d{2}$/.test(x)).slice(0, 3).sort();
    if (!n.days.length) n.days = [isoToday(0)];
    if (!IVS.includes(Number(n.interval))) n.interval = DEF_IV;
    n.interval = Number(n.interval);
    n.needed = Math.max(1, Math.min(10, Number(n.needed) || 1));
    if (!['any', 'indoor', 'outdoor'].includes(n.type)) n.type = 'any';
    if (n.type === 'any') n.courts = [];
    if (!['auto', 'confirm'].includes(n.mode)) n.mode = 'auto';
    n.stats = Object.assign({ checks: 0, found: 0, booked: 0, errors: 0 }, n.stats || {});
    n.bookings = Array.isArray(n.bookings) ? n.bookings : [];
    n.offers = Array.isArray(n.offers) ? n.offers : [];
    n.seen = n.seen || {}; n.reminded = n.reminded || {};
    return n;
  });
  out.bo = Object.assign({ fails: 0, ban: 0 }, out.bo || {});
  return out;
}

async function loadUser(uid, maxAge) {
  if (!uid) return null;
  if (!live) { mem.u[uid] = mem.u[uid] ? fixUser(mem.u[uid]) : defUser(uid); return mem.u[uid]; }
  if (cU[uid] && (dU[uid] || fresh(cUAt, maxAge))) return cU[uid];
  const raw = await cmd(['GET', UK(uid)]);
  if (!raw) return null;
  let u; try { u = fixUser(JSON.parse(raw)); } catch { u = defUser(uid); }
  cU[uid] = u; wU[uid] = JSON.stringify(u); cUAt = Date.now();
  return u;
}

async function loadOrCreate(uid, chat) {
  const got = await loadUser(uid);
  if (got) return got;
  const u = defUser(uid, chat);
  await saveUser(u);
  return u;
}

// Пометить, что копия в памяти изменилась и ждёт записи
function markDirty(uid) { if (!dU[uid]) dU[uid] = Date.now(); }
const dirtyFor = uid => dU[uid] ? Date.now() - dU[uid] : 0;

async function saveUser(u) {
  const now = Date.now();
  for (const h of u.hunts) {
    for (const k of Object.keys(h.seen)) if (h.seen[k] < now - 2 * 86400e3) delete h.seen[k];
    h.offers = (h.offers || []).filter(o => o.start > now + 5 * 60e3).slice(0, 12);
    h.bookings = (h.bookings || []).filter(b => b.start > now - 7 * 86400e3).slice(-60);
  }
  u.log = (u.log || []).slice(0, 120);
  cU[u.uid] = u;
  if (!live) { mem.u[u.uid] = u; return; }
  const json = JSON.stringify(u);
  if (json === wU[u.uid]) { dU[u.uid] = 0; return; }   // нечего писать
  await cmd(['SET', UK(u.uid), json]);
  wU[u.uid] = json; dU[u.uid] = 0;
}

async function loadUsers(list, maxAge) {
  const ids = (list || []).map(x => x.uid || x).filter(Boolean);
  if (!ids.length) return [];
  if (!live) return ids.map(id => mem.u[id]).filter(Boolean).map(fixUser);
  const need = ids.filter(id => !(cU[id] && (dU[id] || fresh(cUAt, maxAge))));
  if (need.length) {
    const r = await cmd(['MGET', ...need.map(UK)]);
    (r || []).forEach((raw, i) => {
      const id = need[i];
      if (!raw) return;
      let u; try { u = fixUser(JSON.parse(raw)); } catch { u = defUser(id); }
      cU[id] = u; wU[id] = JSON.stringify(u);
    });
    cUAt = Date.now();
  }
  return ids.map(id => cU[id]).filter(Boolean);
}

async function dropUser(uid) {
  delete mem.u[uid]; delete cU[uid]; delete wU[uid]; delete dU[uid];
  if (live) await cmd(['DEL', UK(uid)]);
}

function log(target, m, warn) {
  if (!target) return;
  target.log = target.log || [];
  target.log.unshift({ t: Date.now(), m: String(m).slice(0, 400), w: warn ? 1 : 0 });
}

// ---------- сердцебиение фоновых веток ----------
async function setBeat(k, run, ttlSec) {
  if (!live) { mem.hb[k] = { at: Date.now(), run }; return; }
  const key = k + ':' + run;
  if (lastBeat[key] && Date.now() - lastBeat[key] < 12000) return;   // ветка считается живой 45 с — чаще отмечаться незачем
  lastBeat[key] = Date.now();
  await cmd(['SET', HB(k), JSON.stringify({ at: Date.now(), run }), 'EX', String(ttlSec || 120)]);
}

// Короткий ключ активности: {h: активных охот, b: живых броней}.
// Пока он равен нулям, минутный пингер не читает ни глобальное состояние, ни пользователей.
async function setAct(v) {
  const s = JSON.stringify({ h: (v && v.h) | 0, b: (v && v.b) | 0 });
  if (s === lastAct) return;
  lastAct = s;
  if (!live) { mem.act = s; return; }
  await cmd(['SET', ACT, s]);
}
async function getAct() {
  try {
    const r = live ? await cmd(['GET', ACT]) : mem.act;
    return r ? JSON.parse(r) : null;
  } catch { return null; }
}
async function beats() {
  if (!live) return { a: mem.hb.a || null, b: mem.hb.b || null };
  const r = await cmd(['MGET', HB('a'), HB('b')]);
  const parse = x => { try { return x ? JSON.parse(x) : null; } catch { return null; } };
  return { a: parse(r && r[0]), b: parse(r && r[1]) };
}
async function clearBeats() {
  mem.hb = {}; lastBeat = {};
  if (!live) return;
  await cmd(['DEL', HB('a'), HB('b')]);
}

module.exports = {
  live, IVS, DEF_IV, MAX_HUNTS, MAX_CONTACTS, newId, newHunt, isoToday,
  loadGlobal, saveGlobal, loadUser, loadOrCreate, loadUsers, saveUser, dropUser,
  markDirty, dirtyFor, setAct, getAct, used, budget, overBudget, fold,
  log, setBeat, beats, clearBeats
};
