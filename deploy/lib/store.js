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
let mem = { g: null, u: {}, hb: {} };

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

// ---------- глобальное ----------
async function loadGlobal() {
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
  if (!live) { mem.g = g; return; }
  await cmd(['SET', G, JSON.stringify(g)]);
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

async function loadUser(uid) {
  if (!uid) return null;
  if (!live) { mem.u[uid] = mem.u[uid] ? fixUser(mem.u[uid]) : defUser(uid); return mem.u[uid]; }
  const raw = await cmd(['GET', UK(uid)]);
  if (!raw) return null;
  try { return fixUser(JSON.parse(raw)); } catch { return defUser(uid); }
}

async function loadOrCreate(uid, chat) {
  const got = await loadUser(uid);
  if (got) return got;
  const u = defUser(uid, chat);
  await saveUser(u);
  return u;
}

async function saveUser(u) {
  const now = Date.now();
  for (const h of u.hunts) {
    for (const k of Object.keys(h.seen)) if (h.seen[k] < now - 2 * 86400e3) delete h.seen[k];
    h.offers = (h.offers || []).filter(o => o.start > now + 5 * 60e3).slice(0, 12);
    h.bookings = (h.bookings || []).filter(b => b.start > now - 7 * 86400e3).slice(-60);
  }
  u.log = (u.log || []).slice(0, 120);
  if (!live) { mem.u[u.uid] = u; return; }
  await cmd(['SET', UK(u.uid), JSON.stringify(u)]);
}

async function loadUsers(list) {
  const ids = (list || []).map(x => x.uid || x).filter(Boolean);
  if (!ids.length) return [];
  if (!live) return ids.map(id => mem.u[id]).filter(Boolean).map(fixUser);
  const r = await cmd(['MGET', ...ids.map(UK)]);
  const out = [];
  (r || []).forEach((raw, i) => {
    if (!raw) return;
    try { out.push(fixUser(JSON.parse(raw))); } catch { out.push(defUser(ids[i])); }
  });
  return out;
}

async function dropUser(uid) {
  delete mem.u[uid];
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
  await cmd(['SET', HB(k), JSON.stringify({ at: Date.now(), run }), 'EX', String(ttlSec || 120)]);
}
async function beats() {
  if (!live) return { a: mem.hb.a || null, b: mem.hb.b || null };
  const r = await cmd(['MGET', HB('a'), HB('b')]);
  const parse = x => { try { return x ? JSON.parse(x) : null; } catch { return null; } };
  return { a: parse(r && r[0]), b: parse(r && r[1]) };
}
async function clearBeats() {
  mem.hb = {};
  if (!live) return;
  await cmd(['DEL', HB('a'), HB('b')]);
}

module.exports = {
  live, IVS, DEF_IV, MAX_HUNTS, MAX_CONTACTS, newId, newHunt, isoToday,
  loadGlobal, saveGlobal, loadUser, loadOrCreate, loadUsers, saveUser, dropUser,
  log, setBeat, beats, clearBeats
};
