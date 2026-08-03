// Telegram-бот: весь путь на кнопках. Меню правится на месте (editMessageText).
const store = require('../lib/store');
const hunt = require('../lib/hunt');
const tg = require('../lib/tg');
const L = require('../lib/logic');

const ADMIN = (process.env.ADMIN_USERNAME || 'gaucho_bro').toLowerCase().replace('@', '');
const CHAIN_TTL = 100e3;

// Поднять фоновую цепочку, если порвалась
function reviveChain(s) {
  if (!s.task.active || s.botOn === false || !process.env.TICK_KEY) return false;
  if (s.chainAt && Date.now() - s.chainAt < CHAIN_TTL) return false;
  const base = (process.env.APP_URL || '').replace(/\/+$/, '');
  if (!base) return false;
  s.chainAt = Date.now();
  try { fetch(base + '/api/tick?key=' + encodeURIComponent(process.env.TICK_KEY) + '&chain=1').catch(() => {}); } catch (e) {}
  return true;
}
const bgAlive = s => !!(s.chainAt && Date.now() - s.chainAt < CHAIN_TTL);
const APP_URL = (process.env.APP_URL || '').trim();
const DAY = ['Сегодня', 'Завтра', 'Послезавтра'];
const kb = rows => ({ reply_markup: { inline_keyboard: rows } });
const btn = (text, data) => ({ text, callback_data: data });
const appBtn = () => APP_URL ? [{ text: '📱 Открыть панель', web_app: { url: APP_URL } }] : null;

// Постоянная клавиатура под полем ввода — команды вручную не нужны
const TOASTER = {
  keyboard: [
    [{ text: '🎾 Меню' }, { text: '📊 Статус' }],
    [{ text: '📋 Брони' }, { text: '⏹ Стоп' }],
    [{ text: '❓ Помощь' }]
  ],
  resize_keyboard: true, is_persistent: true, input_field_placeholder: 'Жмите кнопки 👇'
};

const COMMANDS = [
  { command: 'menu', description: '🎾 Меню — всё управление' },
  { command: 'status', description: '📊 Что происходит сейчас' },
  { command: 'bookings', description: '📋 Мои брони и отмена' },
  { command: 'stop', description: '⏹ Остановить охоту' },
  { command: 'help', description: '❓ Как это работает' }
];

module.exports = async (req, res) => {
  if (process.env.TG_SECRET && req.headers['x-telegram-bot-api-secret-token'] !== process.env.TG_SECRET)
    return res.status(401).json({ ok: false });
  const u = req.body || {};
  const s = await store.load();
  try {
    if (u.message && u.message.text) await onMessage(s, u.message);
    else if (u.callback_query) await onCallback(s, u.callback_query);
  } catch (e) {
    store.log(s, 'Сбой в Telegram: ' + e.message, 1);
  }
  reviveChain(s);
  await store.save(s);
  return res.status(200).json({ ok: true });
};

const linked = (s, chat) => (s.chats || []).some(c => (c.id || c) === chat);
function touch(s, chat) {
  const c = (s.chats || []).find(x => x.id === chat);
  if (c) { c.last = Date.now(); c.acts = (c.acts || 0) + 1; }
}
const isAdmin = from => (((from && from.username) || '').toLowerCase() === ADMIN);

// ---------- экраны ----------
function vMain(s, admin) {
  const t = s.task, act = hunt.activeBookings(s).length;
  const days = (t.dayOffsets || [0]).map(o => DAY[o].toLowerCase()).join(', ');
  const off = s.botOn === false ? '🔴 <b>Бот выключен владельцем</b>\n\n' : '';
  const text = `🎾 <b>Court Hunter</b>\n\n` + off + (t.active
    ? `🟢 <b>Ловлю прямо сейчас</b>\nПлан: ${days}, ${L.hourLabel(parseInt(t.timeFrom))}–${L.hourLabel(parseInt(t.timeTo))}, ${Math.round(t.dur / 60)} ч\nПоймано: ${act} из ${t.needed}\n\n${bgAlive(s) ? '📡 Фоновый поиск работает — телефон можно закрыть.' : '⏳ Поднимаю фоновый поиск…'}`
    : `⚪ <b>Сплю</b>\nПлан: ${days}, ${t.timeFrom}–${t.timeTo}, ${Math.round(t.dur / 60)} ч · нужно кортов: ${t.needed}\nПоймано: ${act} из ${t.needed}\n\nПроверьте план и жмите «Начать охоту».`);
  const rows = [
    [t.active ? btn('⏹ Остановить охоту', 'M|stop') : btn('▶️ Начать охоту', 'M|go')],
    [btn('🗓 Когда', 'V|when'), btn('🎛 Фильтр', 'V|filters')],
    [btn('🙋 Кто играет', 'V|profile'), btn(`📋 Брони (${act})`, 'V|bookings')],
    [btn('📊 Статус', 'V|status'), btn('❓ Как это работает', 'V|help')]
  ];
  const ab = appBtn(); if (ab) rows.push(ab);
  if (admin) rows.push([btn('👑 Админ-панель', 'V|admin')]);
  return { text, ...kb(rows) };
}

function vHelp(s) {
  return { text:
`❓ <b>Как это работает</b>

Корты в Даулете разбирают за минуты. Я обновляю расписание каждые ~15 секунд и хватаю то, что подходит под ваш план.

<b>1. Когда</b> — день (сегодня / завтра / послезавтра — дальше сайт не открывает), окно времени и длительность.
<b>2. Фильтр</b> — крытый или открытый, конкретный номер, и главное: бронировать сразу или сначала спросить.
<b>3. Кто играет</b> — имя и телефон, на них оформляется бронь. Оплата на месте.
<b>4. Начать охоту</b> — дальше я сам.

<b>Что придёт в чат:</b>
🔔 «Освободился корт» + кнопка «Забрать» — в режиме «сначала спросить».
🎾 «Поймал корт!» + кнопка отмены — когда бронь уже сделана.
⏰ «Час до дедлайна отмены» — напоминание.

<b>Про отмену:</b> онлайн — не позднее 5 часов до игры, потом только звонком на ресепшн (до 3 часов). Кнопка отмены исчезает сама, когда время вышло.

<b>Хитрость с полуночью:</b> слот «завтра 00:00» на сайте — это сегодня ночью. Я подписываю такие слоты 🌙, чтобы вы не приехали не в тот день.

Набрали нужное количество кортов — охота выключается сама.`,
  ...kb([[btn('⬅️ В меню', 'V|main')]]) };
}

function vWhen(s) {
  const t = s.task;
  const dayRow = [0, 1, 2].map(o => btn(`${(t.dayOffsets || []).includes(o) ? '✅ ' : ''}${DAY[o]}`, `Wd|${o}`));
  const night = parseInt(t.timeTo) > 23 ? '\n🌙 Ночные слоты включены: на сайте это «завтра 00:00/01:00», играете этой же ночью.' : '';
  return { text: `🗓 <b>Когда играем</b>\n\nСейчас ловлю: ${(t.dayOffsets || [0]).map(o => DAY[o].toLowerCase()).join(', ')}, с ${L.hourLabel(parseInt(t.timeFrom))} до ${L.hourLabel(parseInt(t.timeTo))}, по ${Math.round(t.dur / 60)} ч. Кортов нужно: ${t.needed}.${night}\n\nЖмите кнопки — всё сохраняется сразу.`, ...kb([
    dayRow,
    [btn('−', 'Wf|-1'), btn(`начало  ${L.hourLabel(parseInt(t.timeFrom))}`, 'x'), btn('+', 'Wf|1')],
    [btn('−', 'Wt|-1'), btn(`конец  ${L.hourLabel(parseInt(t.timeTo))}`, 'x'), btn('+', 'Wt|1')],
    [btn(`${t.dur === 60 ? '✅ ' : ''}1 час`, 'Du|60'), btn(`${t.dur === 120 ? '✅ ' : ''}2 часа`, 'Du|120'), btn(`${t.dur === 180 ? '✅ ' : ''}3 часа`, 'Du|180')],
    [btn('−', 'N|-1'), btn(`кортов нужно  ${t.needed}`, 'x'), btn('+', 'N|1')],
    [btn(`${t.split !== false ? '✅' : '⬜️'} можно набирать по частям`, 'Sp|t')],
    [btn('⏱ обновлять каждые', 'x'), btn(`${t.interval || 15} с`, 'Iv|next')],
    [btn('⬅️ В меню', 'V|main')]
  ]) };
}

function vFilters(s) {
  const t = s.task;
  const rows = [
    [btn(`${t.type === 'any' ? '✅ ' : ''}Любой`, 'Ft|any'), btn(`${t.type === 'indoor' ? '✅ ' : ''}Крытый`, 'Ft|indoor'), btn(`${t.type === 'outdoor' ? '✅ ' : ''}Открытый`, 'Ft|outdoor')]
  ];
  let note = '';
  if (t.type === 'any') note = '\n\nНомер можно выбрать после типа: у крытых №1–8 и открытых №1–5 нумерация своя.';
  else {
    const maxN = t.type === 'indoor' ? 8 : 5;
    const nums = [btn(`${!t.courts.length ? '✅ ' : ''}Любой №`, 'Fc|0')];
    for (let n = 1; n <= maxN; n++) nums.push(btn(`${t.courts.includes(n) ? '✅' : ''}№${n}`, `Fc|${n}`));
    for (let i = 0; i < nums.length; i += 5) rows.push(nums.slice(i, i + 5));
  }
  rows.push([btn(`${t.mode === 'confirm' ? '✅ ' : ''}Спросить меня`, 'Fm|confirm'), btn(`${t.mode === 'auto' ? '✅ ' : ''}Брать сразу`, 'Fm|auto')]);
  rows.push([btn('⬅️ В меню', 'V|main')]);
  const mode = t.mode === 'confirm'
    ? '✋ <b>Спросить меня</b> — пришлю слот с кнопкой «Забрать», бронь только после нажатия. Безопасно, но корт могут увести за эти секунды.'
    : '⚡ <b>Брать сразу</b> — бронирую молча и потом сообщаю. Так надёжнее поймать вечерний слот.';
  return { text: `🎛 <b>Какой корт ловим</b>${note}\n\n${mode}`, ...kb(rows) };
}

function vProfile(s) {
  const p = s.profile;
  const ready = p.name && p.phone;
  return { text: `🙋 <b>На кого бронируем</b>\n\nИмя: ${p.name || '— не указано'}\nТелефон: ${p.phone || '— не указан'}\nПочта: ${p.email || '—'}\n\n${ready ? 'Всё на месте, можно охотиться. ' : '⚠️ Имя и телефон обязательны — без них не начну. '}Сайт данные не проверяет, оплата на месте.`, ...kb([
    [btn('✏️ Имя', 'P|name'), btn('✏️ Телефон', 'P|phone')],
    [btn('✏️ Почта', 'P|email')],
    [btn('⬅️ В меню', 'V|main')]
  ]) };
}

function vBookings(s) {
  const act = hunt.activeBookings(s).sort((a, b) => a.start - b.start);
  if (!act.length) return { text: '📋 <b>Брони</b>\n\nПока пусто. Запустите охоту — добыча появится здесь.', ...kb([[btn('▶️ Начать охоту', 'M|go')], [btn('⬅️ В меню', 'V|main')]]) };
  let text = '📋 <b>Брони</b>';
  const rows = [];
  for (const b of act) {
    const d = L.deadlines(b.start);
    const late = Date.now() >= d.online;
    text += `\n\n🎾 <b>${hunt.courtTitle(b, b.name)}</b> · ${L.whenText(b.start, b.dur)}${L.midnightNote(b.start)}\n${late ? `Онлайн уже поздно — только звонком, до ${L.hm(d.phone)}` : `Отменить онлайн можно до ${L.hm(d.online)}, звонком — до ${L.hm(d.phone)}`}`;
    if (!late) rows.push([btn(`↩️ Отменить ${L.hm(b.start)} · ${hunt.courtTitle(b, b.name)}`, `c|${b.id}`)]);
  }
  rows.push([btn('⬅️ В меню', 'V|main')]);
  return { text, ...kb(rows) };
}

function vStatus(s) {
  return { text: '📊 <b>Статус</b>\n\n' + hunt.statusText(s), ...kb([[btn('🔄 Обновить', 'V|status'), btn('⬅️ В меню', 'V|main')]]) };
}

function ago(ts) {
  if (!ts) return 'ещё не заходил';
  const m = Math.floor((Date.now() - ts) / 60000);
  if (m < 1) return 'только что';
  if (m < 60) return `${m} мин назад`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} ч назад`;
  const d = Math.floor(h / 24);
  return d === 1 ? 'вчера' : `${d} дн назад`;
}

function vAdmin(s) {
  const list = s.chats || [];
  const on = s.botOn !== false;
  let text = `👑 <b>Админ-панель</b>\n\n` +
    `Бот: ${on ? '🟢 включён' : '🔴 выключен для всех'}\n` +
    `Охота: ${s.task.active ? 'идёт' : 'на паузе'} · поймано ${hunt.activeBookings(s).length} из ${s.task.needed}\n` +
    `Пользователей: ${list.length}\n`;
  list.forEach((c, i) => {
    const me = (c.u || '').toLowerCase() === ADMIN;
    text += `\n${i + 1}. ${c.u ? '@' + c.u : (c.name || 'без ника')}${me ? ' 👑 (вы)' : ''}\n` +
      `    ${c.name || '—'} · id <code>${c.id}</code>\n` +
      `    подключён: ${c.at ? L.fmt(c.at) : '—'}\n` +
      `    был: ${ago(c.last)} · действий: ${c.acts || 0}`;
  });
  text += `\n\nПароль: <code>${s.password}</code>\nСменить: <code>/key НовыйПароль</code>`;
  const rows = [[on ? btn('🔴 Отключить бот', 'AB|off') : btn('🟢 Включить бот', 'AB|on')]];
  for (const c of list) {
    if ((c.u || '').toLowerCase() === ADMIN) continue;
    rows.push([btn(`🚫 Отключить ${c.u ? '@' + c.u : (c.name || c.id)}`, `A|${c.id}`)]);
  }
  rows.push([btn('🔄 Обновить', 'V|admin'), btn('⬅️ В меню', 'V|main')]);
  return { text, ...kb(rows) };
}

const VIEWS = { main: vMain, when: vWhen, filters: vFilters, profile: vProfile, bookings: vBookings, status: vStatus, help: vHelp, admin: vAdmin };

// ---------- сообщения ----------
async function onMessage(s, m) {
  const chat = m.chat.id;
  const text = (m.text || '').trim();
  const [cmd, ...rest] = text.split(/\s+/);
  const arg = rest.join(' ');
  const admin = isAdmin(m.from);
  touch(s, chat);
  if (s.botOn === false && !admin && linked(s, chat))
    return tg.send(chat, '🔴 Бот сейчас выключен владельцем. Загляните позже.');

  // ---- не подключён: только пароль ----
  if (!linked(s, chat)) {
    const pw = cmd === '/start' ? arg : text;
    if (pw && pw === s.password) {
      s.chats = s.chats || [];
      s.chats.push({ id: chat, name: (m.from && m.from.first_name) || '', u: (m.from && m.from.username) || '', at: Date.now() });
      store.log(s, `Подключился чат: ${(m.from && m.from.first_name) || chat}${(m.from && m.from.username) ? ' @' + m.from.username : ''}`);
      await tg.setCommands(COMMANDS);
      if (APP_URL) await tg.call('setChatMenuButton', { chat_id: chat, menu_button: { type: 'web_app', text: 'Панель', web_app: { url: APP_URL } } });
      await tg.send(chat, '⌨️ Кнопки внизу — вместо команд.', { reply_markup: TOASTER });
      const ab = appBtn();
      await tg.send(chat,
        `🤝 <b>Пароль принят — вы в деле!</b>\n\n` +
        `Дальше всё на кнопках, ничего печатать не нужно. Быстрый старт:\n` +
        `1️⃣ «Кто играет» — имя и телефон\n` +
        `2️⃣ «Когда» — день и время\n` +
        `3️⃣ «Начать охоту» — я слежу за расписанием и пишу сюда\n\n` +
        (ab ? `Кнопка «📱 Открыть панель» — то же самое, но экраном: удобно с телефона.` : ''),
        ab ? { reply_markup: { inline_keyboard: [ab] } } : {});
      const v = vMain(s, admin);
      return tg.send(chat, v.text, { reply_markup: v.reply_markup });
    }
    if (cmd.startsWith('/')) {
      return tg.send(chat, '🔒 <b>Сначала пароль</b>\nЭто закрытый бот. Пришлите пароль одним сообщением — и открою доступ.');
    }
    return tg.send(chat,
      `🎾 <b>Court Hunter</b>\n\nЛовлю свободные корты в Daulet Tennis (Кордай, 6) и бронирую их на вас, пока не увели.\n\n🔒 Доступ по паролю — пришлите его одним сообщением.`);
  }

  // ---- скрытая команда владельца ----
  if (cmd === '/key') {
    if (!admin) return tg.send(chat, '⛔️ Такой команды нет.');
    if (!arg || arg.length < 6) return tg.send(chat, 'Формат: <code>/key НовыйПароль</code> (от 6 символов)');
    s.password = arg;
    store.log(s, 'Пароль обновлён владельцем');
    return tg.send(chat, `🔑 Готово, новый пароль: <code>${arg}</code>\nСтарый больше не работает — уже подключённые чаты остаются.`);
  }

  // ---- ждём текстовый ввод ----
  if (s.pending && s.pending.chat === chat && !text.startsWith('/')) {
    const f = s.pending.field;
    s.pending = null;
    if (f === 'phone') {
      let d = text.replace(/\D/g, '');
      if (d.startsWith('8')) d = '7' + d.slice(1);
      if (!d.startsWith('7')) d = '7' + d;
      if (d.length !== 11) { s.pending = { chat, field: 'phone' }; return tg.send(chat, 'В казахстанском номере 10 цифр после +7. Ещё раз? Например: 705 123 45 67'); }
      s.profile.phone = '+' + d;
    } else if (f === 'email') {
      if (text !== '-' && !/^\S+@\S+\.\S+$/.test(text)) { s.pending = { chat, field: 'email' }; return tg.send(chat, 'Кажется, опечатка в адресе. Ещё раз? (или «-», чтобы оставить пустым)'); }
      s.profile.email = text === '-' ? '' : text;
    } else s.profile.name = text.slice(0, 60);
    store.log(s, 'Данные для брони обновлены из Telegram');
    const v = vProfile(s);
    return tg.send(chat, '👌 Записал.\n\n' + v.text, { reply_markup: v.reply_markup });
  }

  if (cmd === '/start' || cmd === '/menu' || text === '🎾 Меню') {
    await tg.send(chat, '⌨️ Кнопки внизу — вместо команд.', { reply_markup: TOASTER });
    const v = vMain(s, admin); return tg.send(chat, v.text, { reply_markup: v.reply_markup });
  }
  if (cmd === '/help' || text === '❓ Помощь') { const v = vHelp(s); return tg.send(chat, v.text, { reply_markup: v.reply_markup }); }
  if (cmd === '/status' || text === '📊 Статус') { const v = vStatus(s); return tg.send(chat, v.text, { reply_markup: v.reply_markup }); }
  if (cmd === '/bookings' || cmd === '/cancel' || text === '📋 Брони') { const v = vBookings(s); return tg.send(chat, v.text, { reply_markup: v.reply_markup }); }
  if (cmd === '/stop' || text === '⏹ Стоп') { s.task.active = false; store.log(s, 'Охота остановлена из Telegram'); return tg.send(chat, '⏹ Остановил. Вернуться — /menu'); }
  if (cmd === '/admin') {
    if (!admin) return tg.send(chat, '⛔️ Такой команды нет.');
    const v = vAdmin(s); return tg.send(chat, v.text, { reply_markup: v.reply_markup });
  }
  const v = vMain(s, admin);
  return tg.send(chat, 'Я тут 👋 Всё управление — на кнопках:', { reply_markup: v.reply_markup });
}

// ---------- кнопки ----------
async function onCallback(s, cb) {
  const chat = cb.message && cb.message.chat.id;
  const msgId = cb.message && cb.message.message_id;
  const admin = isAdmin(cb.from);
  touch(s, chat);
  if (s.botOn === false && !admin && linked(s, chat)) return tg.answerCb(cb.id, 'Бот выключен владельцем');
  if (!linked(s, chat)) { await tg.send(chat, '🔒 Сначала пришлите пароль одним сообщением.'); return tg.answerCb(cb.id, 'Нужен пароль'); }
  const [op, a, b2, c2] = String(cb.data || '').split('|');
  const t = s.task;
  let view = null, toast = '';

  const show = async name => {
    const v = VIEWS[name](s, admin);
    await tg.edit(chat, msgId, v.text, { reply_markup: v.reply_markup });
  };

  if (op === 'x') return tg.answerCb(cb.id, '');
  if (op === 'V') {
    if (a === 'admin' && !admin) return tg.answerCb(cb.id, 'Только для владельца');
    await show(a); return tg.answerCb(cb.id, '');
  }

  if (op === 'M') {
    if (a === 'stop') { t.active = false; store.log(s, 'Охота остановлена кнопкой'); toast = 'Остановил'; view = 'main'; }
    else if (a === 'go') {
      if (s.botOn === false) return tg.answerCb(cb.id, 'Бот выключен владельцем');
      if (!s.profile.name || !s.profile.phone) { await show('profile'); return tg.answerCb(cb.id, 'Сначала имя и телефон'); }
      if (hunt.leftHours(s) <= 0) { toast = 'Цель уже набрана — добавьте кортов'; view = 'when'; }
      else { t.active = true; s.stats.startedAt = Date.now(); hunt.dropPhantoms(s); s.offers = []; s.seen = {}; store.log(s, `Охота запущена из Telegram: нужно ${t.needed}, ${t.timeFrom}–${t.timeTo}`); toast = 'Погнали! 🟢'; view = 'main'; }
    }
  }
  else if (op === 'Wd') {
    const o = Number(a);
    const next = (t.dayOffsets || []).includes(o) ? t.dayOffsets.filter(x => x !== o) : [...(t.dayOffsets || []), o].sort();
    if (!next.length) return tg.answerCb(cb.id, 'Хотя бы один день нужен');
    t.dayOffsets = next; view = 'when';
  }
  else if (op === 'Wf') {
    const h = Math.max(6, Math.min(24, parseInt(t.timeFrom) + Number(a)));
    t.timeFrom = L.hourVal(h);
    L.fitWindow(t);
    view = 'when';
  }
  else if (op === 'Wt') {
    const h = Math.max(parseInt(t.timeFrom) + 1, Math.min(L.MAX_H, parseInt(t.timeTo) + Number(a)));
    t.timeTo = L.hourVal(h);
    if (h - parseInt(t.timeFrom) < Math.round(t.dur / 60)) t.dur = 60;
    view = 'when';
  }
  else if (op === 'Sp') { t.split = t.split === false; hunt.pruneOffers(s); s.seen = {}; view = 'when'; }
  else if (op === 'Iv') {
    const opts = [1, 5, 10, 15, 30, 60];
    t.interval = opts[(opts.indexOf(Number(t.interval) || 15) + 1) % opts.length];
    view = 'when';
  }
  else if (op === 'Du') { t.dur = Number(a); L.fitWindow(t); hunt.pruneOffers(s); s.seen = {}; view = 'when'; }
  else if (op === 'N') { t.needed = Math.max(1, Math.min(10, t.needed + Number(a))); view = 'when'; }
  else if (op === 'Ft') { t.type = a; t.courts = []; hunt.pruneOffers(s); s.seen = {}; view = 'filters'; }
  else if (op === 'Fc') {
    const n = Number(a);
    t.courts = n === 0 ? [] : (t.courts.includes(n) ? t.courts.filter(x => x !== n) : [...t.courts, n].sort());
    view = 'filters';
  }
  else if (op === 'Fm') { t.mode = a; hunt.pruneOffers(s); view = 'filters'; }
  else if (op === 'P') {
    s.pending = { chat, field: a };
    const ask = a === 'phone' ? 'Пришлите номер: 705 123 45 67 (+7 добавлю сам)'
      : a === 'email' ? 'Пришлите почту (или «-», чтобы оставить пустой)'
      : 'Как записать? Пришлите имя и фамилию';
    await tg.send(chat, '✏️ ' + ask);
    return tg.answerCb(cb.id, '');
  }
  else if (op === 'AB') { // включить/выключить бота целиком
    if (!admin) return tg.answerCb(cb.id, 'Только для владельца');
    s.botOn = a === 'on';
    if (!s.botOn) s.task.active = false;
    store.log(s, s.botOn ? 'Владелец включил бота' : 'Владелец выключил бота');
    await show('admin');
    return tg.answerCb(cb.id, s.botOn ? 'Бот включён 🟢' : 'Бот выключен 🔴');
  }
  else if (op === 'A') { // отключить чат (только владелец)
    if (!admin) return tg.answerCb(cb.id, 'Только для владельца');
    const id = Number(a);
    const gone = (s.chats || []).find(c => c.id === id);
    s.chats = (s.chats || []).filter(c => c.id !== id);
    store.log(s, `Владелец отключил чат ${gone ? (gone.name || id) : id}`);
    if (gone) await tg.send(id, '🚪 Доступ к боту закрыт владельцем. Если это ошибка — напишите ему.');
    await show('admin');
    return tg.answerCb(cb.id, 'Отключил');
  }
  else if (op === 'b') { // забрать предложенный слот
    const r = await hunt.takeOffer(s, a);
    if (!r.ok) await tg.send(chat, '⚠️ ' + r.why);
    return tg.answerCb(cb.id, r.ok ? 'Есть! Забронировал 🎾' : 'Не вышло');
  }
  else if (op === 'sk') { // пропустить предложение
    hunt.dropOffer(s, a);
    await tg.edit(chat, msgId, ((cb.message && cb.message.text) || 'Предложение') + '\n\n✖️ Пропущено', {});
    return tg.answerCb(cb.id, 'Ок, пропустил');
  }
  else if (op === 'c') { // отмена брони
    const r = await hunt.doCancel(s, a);
    if (r.ok) {
      await hunt.sendAll(s, `↩️ Бронь отменена: ${hunt.courtTitle(r.b, r.b.name)} · ${L.whenText(r.b.start, r.b.dur)}\nСлот снова свободен на сайте.`);
      return tg.answerCb(cb.id, 'Отменил ✅');
    }
    await tg.send(chat, '⚠️ ' + r.why);
    return tg.answerCb(cb.id, 'Не получилось');
  }

  if (view) await show(view);
  return tg.answerCb(cb.id, toast);
}
