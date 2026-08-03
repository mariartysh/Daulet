// Фоновые «ветки» охоты. Задание живёт на сервере и НЕ зависит от того,
// открыт ли Telegram или панель. Останавливается только по трём причинам:
// цель набрана · охота отменена · прошло 12 часов поиска.
//
//   A — рабочая ветка: проверяет расписание с выбранной частотой.
//   B — страж: тикает раз в 10 сек и почти ничего не грузит, но если A замолчала —
//       сама делает проверки и поднимает A.
//
// Каждое звено работает ~44 сек и передаёт эстафету следующему, ДОЖИДАЯСЬ
// подтверждения по heartbeat в базе. Соединение с новым звеном не обрываем:
// abort() выглядел для Vercel как «клиент ушёл» и убивал только что запущенное звено.
const store = require('./store');

const STRANDS = ['a', 'b'];
const TTL = 45e3;                       // ветка жива, если отметилась меньше 45 сек назад
const sleep = ms => new Promise(r => setTimeout(r, ms));

function baseUrl(req) {
  const env = (process.env.APP_URL || '').replace(/\/+$/, '');
  if (env) return env;
  const h = req && req.headers && (req.headers['x-forwarded-host'] || req.headers.host);
  return h ? `https://${h}` : '';
}

const at = (beats, k) => (beats && beats[k] && beats[k].at) || 0;
const alive = (beats, k) => Date.now() - at(beats, k) < TTL;
const aliveList = beats => STRANDS.filter(k => alive(beats, k));
const beats = () => store.beats();
const beat = (strand, run) => store.setBeat(strand, run, 120);
const drop = () => store.clearBeats();

// Запустить звено ветки. confirm — дождаться, что оно реально ожило.
async function spawn(req, strand, opts) {
  const o = opts || {};
  const base = baseUrl(req);
  if (!base || !process.env.TICK_KEY) return false;
  const run = Math.random().toString(36).slice(2, 9);
  const url = `${base}/api/tick?key=${encodeURIComponent(process.env.TICK_KEY)}&chain=1&strand=${strand}&run=${run}`
    + (o.delay ? `&delay=${o.delay}` : '');
  for (let a = 0, tries = o.confirm ? 2 : 1; a < tries; a++) {
    fetch(url, { headers: { 'x-chain': '1' }, cache: 'no-store' }).catch(() => {});
    if (!o.confirm) { await sleep(1200); return true; }   // ждём, чтобы запрос успел уйти до заморозки инстанса
    for (let i = 0; i < 4; i++) {
      await sleep(700);
      const b = await beats().catch(() => null);
      if (b && b[strand] && b[strand].run === run) return true;
    }
  }
  return false;
}

// Поднять все мёртвые ветки
async function revive(req, opts) {
  const o = opts || {};
  const b = await beats().catch(() => ({}));
  const started = [];
  for (const k of STRANDS) {
    if (alive(b, k)) continue;
    if (await spawn(req, k, { confirm: o.confirm, delay: k === 'b' ? 20 : 0 })) started.push(k);
  }
  return started;
}

module.exports = { STRANDS, TTL, sleep, baseUrl, at, alive, aliveList, beat, beats, drop, spawn, revive };
