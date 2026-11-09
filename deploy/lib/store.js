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

// ---------- режим «один долгоживущий процесс» (Render и подобные) ----------
// Постоянный сервер — единственный, кто пишет в базу, поэтому его память и есть главная копия.
// Состояние читаем из базы один раз при старте, а пишем только изменения и не по каждому чиху:
//   · правки человека (панель, бот) — через SOON_MS (несколько секунд, склеиваются в одну запись);
//   · служебное (счётчик проверок, «уже видел») — раз в LAZY_MS или при остановке сервера;
//   · сердцебиения веток и ключ активности живут только в памяти — в базу не ходят вовсе.
// Раньше простой сервера стоил ~1400 команд в сутки, а охота — до 30 тысяч.
// server.js включает режим сам (LOCAL_STATE=1). На Vercel режим выключен: там каждый вызов — новый процесс.
const LOCAL = live && /^(1|true|on|yes|да)$/i.test(String(process.env.LOCAL_STATE || ''));
const SOON_MS = Number(process.env.SAVE_SOON_MS || 3000);
const LAZY_MS = Number(process.env.SAVE_LAZY_MS || 10 * 60e3);
// Предохранитель: сколько команд в минуту вообще можно отправить в базу. В норме их единицы;
// если какая-то ошибка запустит бесконечный цикл, он упрётся в этот потолок, а не сожжёт месячный лимит.
const FUSE_MIN = Number(process.env.CMD_FUSE_PER_MIN || 100);
let dG = false, timer = null, nextAt = 0, flushing = null, fuseWin = [], fuseWarn = 0;
const sleepMs = ms => new Promise(r => setTimeout(r, ms));

// ---------- экономия команд ----------
// Один вызов функции живёт до минуты и раньше дёргал базу на каждом шаге цикла.
// Теперь свежие данные держим в памяти вызова, пишем только изменившееся,
// а «есть ли вообще активные охоты» узнаём одним коротким ключом ch:act.
const ACT = 'ch:act';
let cG = null, cGAt = 0, wG = '';            // кэш глобального и последняя запись
let cU = {}, cUAt = 0, wU = {}, dU = {};     // кэш пользователей, записанное, несохранённые
let lastBeat = {}, lastAct = '';
let cnt = 0, folded = 0;                     // сколько команд отправил этот вызов и сколько из них уже учтено
let pend = 0;                                // посчитано, но ещё не записано в базу
// Раньше счётчик прибавлялся при КАЖДОЙ записи глобального состояния — и тем самым
// сам заставлял писать базу на каждый запрос (панель опрашивалась раз в 7 с → +4 команды).
// Теперь остаток копится в памяти и уходит в базу либо вместе с другой правкой (бесплатно),
// либо раз в CMD_FOLD команд.
const FOLD_MIN = Number(process.env.CMD_FOLD || 300);
const BUDGET = Number(process.env.CMD_BUDGET || 470000);   // бесплатный Upstash — 500 тысяч в месяц
const fresh = (at, maxAge) => !!(maxAge && at && Date.now() - at < maxAge);

async function cmd(arr) {
  if (LOCAL) {
    // Не больше FUSE_MIN команд за скользящую минуту: лишние ждут. Нормальной работе это не мешает.
    for (;;) {
      const now = Date.now();
      while (fuseWin.length && now - fuseWin[0] > 60e3) fuseWin.shift();
      if (fuseWin.length < FUSE_MIN) { fuseWin.push(now); break; }
      if (now - fuseWarn > 60e3) { fuseWarn = now; console.error(`Предохранитель базы: больше ${FUSE_MIN} команд в минуту — торможу`); }
      await sleepMs(Math.max(200, 60e3 - (now - fuseWin[0])));
    }
  }
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
const IVS = [1, 2, 3, 5, 7, 10];              // допустимые частоты проверки, сек
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
    cIdx: [],                    // на кого бронировать: номера контактов ([] = все)
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
function bump() { pend += Math.max(0, cnt - folded); folded = cnt; }
// force — прибавить остаток обязательно (зовём в момент, когда база и так пишется)
// Однократная калибровка по панели Upstash: 9.11.2026 в 14:33 там было 411 тысяч, а наш
// счёт расходился с реальным. Дальше считаем сами и точно (каждая команда проходит через cmd()).
const CAL = { v: 2, m: '2026-11', n: 412000 };
function calib(g) {
  if (!g) return g;
  const c = g.cmd;
  if (c && c.v === CAL.v) return g;
  const fresh = !c && !(g.users && g.users.length);        // совсем новая база (например, новый аккаунт Upstash): считать с нуля
  g.cmd = fresh ? { m: month(), n: 0, v: CAL.v }
    : month() === CAL.m ? { m: CAL.m, n: CAL.n, v: CAL.v } : { m: month(), n: c && c.m === month() ? c.n : 0, v: CAL.v };
  pend = 0; folded = cnt;                       // команды, посчитанные до калибровки, уже вошли в цифру с панели
  if (LOCAL) { dG = true; plan(SOON_MS); }      // запомнить новую базу счёта
  return g;
}
function fold(g, force) {
  bump();
  // Раньше у свежего объекта (ещё без поля cmd) остаток просто выбрасывался —
  // это и был один из источников недосчёта.
  if (!g.cmd) g.cmd = { m: month(), n: 0, v: CAL.v };
  if (g.cmd.m !== month()) { g.cmd = { m: month(), n: 0, v: CAL.v }; pend = 0; return g; }   // новый месяц — с нуля
  if (force || pend >= FOLD_MIN) { g.cmd.n += pend; pend = 0; }
  return g;
}
const used = g => (g && g.cmd && g.cmd.m === month() ? g.cmd.n : 0) + pend + Math.max(0, cnt - folded);
const budget = () => BUDGET;
const overBudget = g => BUDGET > 0 && used(g) > BUDGET;
// Обнулить счётчик месяца (аварийно, из /api/health?key=…&resetcmd=1)
function resetCmd(g) { g.cmd = { m: month(), n: 0, v: CAL.v }; pend = 0; folded = cnt; return g; }
// Выставить счётчик по цифре из панели Upstash (/api/health?key=…&setcmd=411000)
function setCmd(g, n) { g.cmd = { m: month(), n: Math.max(0, Math.round(Number(n) || 0)), v: CAL.v }; pend = 0; folded = cnt; return g; }

// Сбросить накопленный остаток в базу ПЕРЕД тем, как вызов функции умрёт.
// Без этого счётчик систематически врал в меньшую сторону: звено фонового поиска живёт
// 44 секунды, успевает сделать ~10 обращений и исчезает, так и не записав их.
// Именно поэтому бот показывал 400 тысяч, когда на деле было 758.
// Одиночные вызовы (пингер вхолостую — одно обращение) не сбрасываем: ради одной команды
// делать вторую бессмысленно. Этот остаток учтён запасом в CMD_BUDGET.
const FLUSH_MIN = Number(process.env.CMD_FLUSH || 3);
async function flushCmd() {
  bump();
  if (LOCAL) { if (cG && pend >= FLUSH_MIN) { dG = true; plan(LAZY_MS); } return false; }   // счётчик уйдёт с ближайшей плановой записью
  if (pend < FLUSH_MIN || !cG) return false;
  fold(cG, true);
  await saveGlobal(cG).catch(() => {});
  return true;
}

// ---------- глобальное ----------
// maxAge — сколько миллисекунд можно отдавать копию из памяти вызова (0 = всегда читать базу)
async function loadGlobal(maxAge) {
  if (cG && (LOCAL || fresh(cGAt, maxAge))) return cG;    // постоянный сервер: память — главная копия
  const g = calib(await readGlobal());
  cG = g; cGAt = Date.now();
  return g;
}

async function readGlobal() {
  if (!live) { mem.g = mem.g || defGlobal(); return mem.g; }
  const raw = await cmd(['GET', G]);
  if (raw) { try { const g0 = Object.assign(defGlobal(), JSON.parse(raw)); wG = raw; return g0; } catch {} }
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

async function saveGlobal(g, opts) {
  g.log = (g.log || []).slice(0, 80);
  fold(g);
  cG = g; cGAt = Date.now();
  if (!live) { mem.g = g; return; }
  if (LOCAL) { dG = true; plan(opts && opts.lazy ? LAZY_MS : SOON_MS); return; }
  let json = JSON.stringify(g);
  if (json === wG) return;                   // ничего не изменилось — не тратим команду
  fold(g, true);                             // раз уж пишем — заодно учтём остаток счётчика
  json = JSON.stringify(g);
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
    delete n.dur; delete n.split; delete n.dayOffsets; delete n.actBy;   // ушли из модели / служебное
    if (!Array.isArray(n.days) || !n.days.length) n.days = [isoToday(0)];
    n.days = n.days.filter(x => /^\d{4}-\d{2}-\d{2}$/.test(x)).slice(0, 3).sort();
    if (!n.days.length) n.days = [isoToday(0)];
    if (!IVS.includes(Number(n.interval))) n.interval = DEF_IV;
    n.interval = Number(n.interval);
    n.needed = Math.max(1, Math.min(10, Number(n.needed) || 1));
    if (!['any', 'indoor', 'outdoor'].includes(n.type)) n.type = 'any';
    if (n.type === 'any') n.courts = [];
    n.cIdx = (Array.isArray(n.cIdx) ? n.cIdx : []).map(Number)
      .filter(x => Number.isInteger(x) && x >= 0 && x < MAX_CONTACTS).sort();
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
  if (cU[uid] && (LOCAL || fresh(cUAt, maxAge))) return cU[uid];
  const raw = await cmd(['GET', UK(uid)]);
  if (!raw) return null;
  let u; try { u = fixUser(JSON.parse(raw)); } catch { u = defUser(uid); }
  if (cU[uid] && dU[uid]) { try { u = mergeUser(u, cU[uid]); } catch (e) {} }
  cU[uid] = u; wU[uid] = raw; cUAt = Date.now();
  return u;
}

// Панель на каждый опрос читала глобальное состояние, профиль и сердцебиения —
// три отдельных чтения. MGET забирает всё это одной командой.
async function loadBundle(uid) {
  if (!live || !uid || LOCAL) {
    // постоянный сервер: всё уже в памяти, в базу идём только при первом обращении после старта
    return { g: await loadGlobal(), u: uid ? await loadUser(uid) : null, beats: await beats() };
  }
  const r = await cmd(['MGET', G, UK(uid), HB('a'), HB('b'), ACT]);
  const parse = x => { try { return x ? JSON.parse(x) : null; } catch { return null; } };

  let g;
  if (r && r[0]) { try { g = Object.assign(defGlobal(), JSON.parse(r[0])); } catch {} }
  if (!g) g = await readGlobal();                 // пусто или битое — обычный путь с миграцией
  g = calib(g);
  cG = g; cGAt = Date.now();

  let u = null;
  if (r && r[1]) {
    try { u = fixUser(JSON.parse(r[1])); } catch { u = defUser(uid); }
    if (cU[uid] && dU[uid]) { try { u = mergeUser(u, cU[uid]); } catch (e) {} }
    cU[uid] = u; wU[uid] = r[1]; cUAt = Date.now();
  }

  return { g, u, beats: { a: parse(r && r[2]), b: parse(r && r[3]), act: parse(r && r[4]) } };
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

// Что правит человек (панель, бот), а что — фоновый поиск. Фоновый проход живёт до минуты
// и держит свою копию профиля; без слияния его запись стирала бы всё, что вы сделали
// за это время (отсюда «новая охота сама удаляется»).
const PLAN_FIELDS = ['title', 'mode', 'needed', 'type', 'courts', 'cIdx', 'days', 'timeFrom', 'timeTo', 'interval'];

function mergeBookings(mine, theirs) {
  const out = [];
  const seen = new Set();
  for (const b of [...(theirs || []), ...(mine || [])]) {
    const prev = out.find(x => x.id === b.id);
    if (!prev) { out.push(Object.assign({}, b)); seen.add(b.id); continue; }
    if (b.cancelled) prev.cancelled = true;                  // отмену из панели не теряем
  }
  return out;
}

// db — то, что сейчас в базе (правил человек); u — наша копия с результатами поиска.
function mergeUser(db, u) {
  u.contacts = db.contacts;                                  // адресная книга — только человек
  u.pending = db.pending;
  u.ui = db.ui;
  const mine = {};
  for (const h of u.hunts) mine[h.id] = h;
  u.hunts = (db.hunts || []).map(dh => {
    const h = mine[dh.id];
    if (!h) return dh;                                       // охоту добавили, пока мы искали
    for (const k of PLAN_FIELDS) h[k] = dh[k];                // план — за человеком
    if (!h.actBy) h.active = dh.active;                       // старт/стоп — тоже, если мы сами не меняли
    delete h.actBy;
    h.bookings = mergeBookings(h.bookings, dh.bookings);
    return h;
  });
  const log = [...(u.log || []), ...(db.log || [])];
  const key = x => x.t + '|' + x.m;
  const uniq = [];
  const seen = new Set();
  for (const x of log.sort((a, b) => b.t - a.t)) { if (seen.has(key(x))) continue; seen.add(key(x)); uniq.push(x); }
  u.log = uniq;
  return u;
}

async function saveUser(u, opts) {
  const now = Date.now();
  for (const h of u.hunts) {
    for (const k of Object.keys(h.seen)) if (h.seen[k] < now - 2 * 86400e3) delete h.seen[k];
    h.offers = (h.offers || []).filter(o => o.start > now + 5 * 60e3).slice(0, 12);
    h.bookings = (h.bookings || []).filter(b => b.start > now - 7 * 86400e3).slice(-60);
  }
  if (live && !LOCAL && opts && opts.merge) {
    const raw = await cmd(['GET', UK(u.uid)]).catch(() => null);
    if (raw && raw !== wU[u.uid]) {                 // кто-то писал после нас — сливаем, а не затираем
      try { mergeUser(fixUser(JSON.parse(raw)), u); } catch (e) {}
    }
  }
  u.log = (u.log || []).slice(0, 120);
  cU[u.uid] = u;
  if (!live) { mem.u[u.uid] = u; return; }
  if (LOCAL) {
    // lazy — служебная пометка поиска: пишем раз в LAZY_MS; без неё — правка человека, через SOON_MS
    if (!dU[u.uid]) dU[u.uid] = Date.now();
    plan(opts && opts.lazy ? LAZY_MS : SOON_MS);
    return;
  }
  await writeUser(u);
}

async function writeUser(u) {
  const json = JSON.stringify(u);
  if (json === wU[u.uid]) { dU[u.uid] = 0; return false; }   // нечего писать
  await cmd(['SET', UK(u.uid), json]);
  wU[u.uid] = json; dU[u.uid] = 0;
  return true;
}

// ---------- плановая запись (только постоянный сервер) ----------
// Ставим таймер не позже, чем через ms; если уже стоит более ранний — оставляем его.
function plan(ms) {
  if (!LOCAL) return;
  const t = Date.now() + ms;
  if (timer && nextAt <= t) return;
  if (timer) clearTimeout(timer);
  nextAt = t;
  timer = setTimeout(() => { timer = null; nextAt = 0; flushAll().catch(e => console.error('flush:', e && e.message)); }, ms);
  if (timer.unref) timer.unref();
}

// Записать в базу всё, что изменилось (звать при остановке сервера). Одновременно идёт одна запись.
async function flushAll() {
  if (!LOCAL) return false;
  if (flushing) { await flushing.catch(() => {}); }
  flushing = (async () => {
    let any = false;
    for (const uid of Object.keys(dU)) {
      if (!dU[uid] || !cU[uid]) continue;
      if (await writeUser(cU[uid])) any = true;
    }
    if (dG && cG) {
      dG = false;
      bump(); fold(cG, true);
      const json = JSON.stringify(cG);
      if (json !== wG) { await cmd(['SET', G, json]); wG = json; any = true; }
    }
    return any;
  })();
  try { return await flushing; } finally { flushing = null; }
}

async function loadUsers(list, maxAge) {
  const ids = (list || []).map(x => x.uid || x).filter(Boolean);
  if (!ids.length) return [];
  if (!live) return ids.map(id => mem.u[id]).filter(Boolean).map(fixUser);
  const need = ids.filter(id => !(cU[id] && (LOCAL || fresh(cUAt, maxAge))));
  if (need.length) {
    const r = await cmd(['MGET', ...need.map(UK)]);
    (r || []).forEach((raw, i) => {
      const id = need[i];
      if (!raw) return;
      let u; try { u = fixUser(JSON.parse(raw)); } catch { u = defUser(id); }
      if (cU[id] && dU[id]) { try { u = mergeUser(u, cU[id]); } catch (e) {} }
      cU[id] = u; wU[id] = raw;
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
const BEAT_EVERY = Number(process.env.BEAT_EVERY_MS || 20000);
async function setBeat(k, run, ttlSec) {
  if (!live || LOCAL) { mem.hb[k] = { at: Date.now(), run }; return; }   // постоянный сервер: ветки видят друг друга в памяти
  const key = k + ':' + run;
  if (lastBeat[key] && Date.now() - lastBeat[key] < BEAT_EVERY) return;   // ветка считается живой 45 с — чаще отмечаться незачем
  lastBeat[key] = Date.now();
  await cmd(['SET', HB(k), JSON.stringify({ at: Date.now(), run }), 'EX', String(ttlSec || 120)]);
}

// Короткий ключ активности: {h: активных охот, b: живых броней}.
// Пока он равен нулям, минутный пингер не читает ни глобальное состояние, ни пользователей.
async function setAct(v) {
  const s = JSON.stringify({ h: (v && v.h) | 0, b: (v && v.b) | 0 });
  if (s === lastAct) return;
  lastAct = s;
  if (!live || LOCAL) { mem.act = s; return; }
  await cmd(['SET', ACT, s]);
}
async function getAct() {
  try {
    const r = live && !LOCAL ? await cmd(['GET', ACT]) : mem.act;
    return r ? JSON.parse(r) : null;
  } catch { return null; }
}
// MGET нескольких ключей стоит РОВНО ОДНУ команду, поэтому забираем заодно и ch:act:
// пингеру больше не нужно отдельное чтение «есть ли активные охоты».
async function beats() {
  if (!live || LOCAL) return { a: mem.hb.a || null, b: mem.hb.b || null, act: mem.act ? JSON.parse(mem.act) : null };
  const r = await cmd(['MGET', HB('a'), HB('b'), ACT]);
  const parse = x => { try { return x ? JSON.parse(x) : null; } catch { return null; } };
  return { a: parse(r && r[0]), b: parse(r && r[1]), act: parse(r && r[2]) };
}
async function clearBeats() {
  mem.hb = {}; lastBeat = {};
  if (!live || LOCAL) return;
  await cmd(['DEL', HB('a'), HB('b')]);
}

module.exports = {
  live, LOCAL, IVS, DEF_IV, MAX_HUNTS, MAX_CONTACTS, newId, newHunt, isoToday,
  loadGlobal, saveGlobal, loadUser, loadOrCreate, loadUsers, saveUser, dropUser,
  markDirty, dirtyFor, setAct, getAct, loadBundle, used, budget, overBudget, fold, resetCmd, setCmd, flushCmd, flushAll,
  log, setBeat, beats, clearBeats
};
