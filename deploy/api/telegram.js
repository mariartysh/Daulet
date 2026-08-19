// Telegram-бот. Всё на кнопках. Каждый пользователь видит только свои охоты;
// действия те же, что в мини-приложении (общий слой lib/svc.js).
const store = require('../lib/store');
const svc = require('../lib/svc');
const hunt = require('../lib/hunt');
const chain = require('../lib/chain');
const tg = require('../lib/tg');
const L = require('../lib/logic');

const APP_URL = (process.env.APP_URL || '').trim();
const DAY = ['Сегодня', 'Завтра', 'Послезавтра'];
const kb = rows => ({ reply_markup: { inline_keyboard: rows.filter(Boolean) } });
const btn = (text, data) => ({ text, callback_data: data });
const panelBtn = u => APP_URL && u ? [{ text: '📱 Открыть панель', web_app: { url: `${APP_URL}#tk=${svc.mkToken(u.uid)}` } }] : null;

const TOASTER = {
  keyboard: [
    [{ text: '🎾 Меню' }, { text: '📊 Статус' }],
    [{ text: '📋 Брони' }, { text: '⏹ Стоп' }],
    [{ text: '❓ Помощь' }]
  ],
  resize_keyboard: true, is_persistent: true, input_field_placeholder: 'Жмите кнопки 👇'
};

const COMMANDS = [
  { command: 'menu', description: '🎾 Меню — все охоты' },
  { command: 'status', description: '📊 Что происходит сейчас' },
  { command: 'bookings', description: '📋 Мои брони и отмена' },
  { command: 'stop', description: '⏹ Остановить все охоты' },
  { command: 'help', description: '❓ Как это работает' }
];

module.exports = async (req, res) => {
  if (process.env.TG_SECRET && req.headers['x-telegram-bot-api-secret-token'] !== process.env.TG_SECRET)
    return res.status(401).json({ ok: false });
  let upd = req.body || {};
  if (typeof upd === 'string') { try { upd = JSON.parse(upd); } catch { upd = {}; } }
  let g;
  try { g = await store.loadGlobal(); }
  catch (e) {
    // База недоступна — отвечаем 200 (иначе Telegram копит очередь) и говорим человеку, что случилось.
    const chat = (upd.message && upd.message.chat && upd.message.chat.id)
      || (upd.callback_query && upd.callback_query.message && upd.callback_query.message.chat.id);
    if (chat) await tg.send(chat, '⚠️ Не могу прочитать базу — сервер отвечает ошибкой.\n<code>' + String(e.message).slice(0, 120) + '</code>\nПроверьте переменные хранилища в Vercel и откройте /api/health.').catch(() => {});
    return res.status(200).json({ ok: true, storeDown: true });
  }
  try {
    if (upd.message && upd.message.text) await onMessage(g, upd.message, req);
    else if (upd.callback_query) await onCallback(g, upd.callback_query, req);
  } catch (e) {
    store.log(g, 'Сбой в Telegram: ' + e.message, 1);
    await store.saveGlobal(g);
  }
  return res.status(200).json({ ok: true });
};

// ---------- экраны ----------
function vMain(u, g) {
  const off = g.botOn === false ? '🔴 <b>Бот выключен владельцем</b>\n\n' : '';
  const act = u.hunts.filter(h => h.active).length;
  const text = `🎾 <b>Court Hunter</b>\n\n` + off +
    (act ? `🟢 Ловлю прямо сейчас: ${act} ${act === 1 ? 'охота' : 'охоты'}\n\n` : `⚪ Все охоты на паузе\n\n`) +
    u.hunts.map(h => hunt.huntLine(u, h)).join('\n\n');
  const rows = [];
  for (const h of u.hunts) {
    rows.push([
      btn(h.active ? '⏹' : '▶️', `H|${h.active ? 'stop' : 'go'}|${h.id}`),
      btn(`${h.active ? '🟢' : '⚪'} ${hunt.label(h)}`.slice(0, 42), `V|hunt|${h.id}`)
    ]);
  }
  if (u.hunts.length < store.MAX_HUNTS) rows.push([btn('➕ Ещё одна охота', 'H|add')]);
  rows.push([btn(`👥 Контакты (${(u.contacts || []).filter(c => c.name && c.phone).length})`, 'V|contacts'),
    btn(`📋 Брони (${hunt.allActiveBookings(u).length})`, 'V|bookings')]);
  rows.push([btn('📊 Статус', 'V|status'), btn('❓ Как это работает', 'V|help')]);
  const p = panelBtn(u); if (p) rows.push(p);
  if (u.isAdmin) rows.push([btn('👑 Админ-панель', 'V|admin')]);
  return { text, ...kb(rows) };
}

function vHunt(u, h) {
  const dayRow = [0, 1, 2].map(o => {
    const iso = store.isoToday(o);
    return btn(`${(h.days || []).includes(iso) ? '✅ ' : ''}${DAY[o]}`, `D|${h.id}|${o}`);
  });
  const night = parseInt(h.timeTo) > 23 ? '\n🌙 Ночные слоты включены: на сайте это «завтра 00:00/01:00», играете этой же ночью.' : '';
  const type = h.type === 'indoor' ? 'крытые' : h.type === 'outdoor' ? 'открытые' : 'любой тип';
  const rows = [
    dayRow,
    [btn('−', `F|${h.id}|-1`), btn(`начало  ${L.hourLabel(parseInt(h.timeFrom))}`, 'x'), btn('+', `F|${h.id}|1`)],
    [btn('−', `T|${h.id}|-1`), btn(`конец  ${L.hourLabel(parseInt(h.timeTo))}`, 'x'), btn('+', `T|${h.id}|1`)],
    [btn('−', `N|${h.id}|-1`), btn(`кортов на день  ${h.needed}`, 'x'), btn('+', `N|${h.id}|1`)],
    [btn('⏱ проверять каждые', 'x'), btn(`${h.interval} с`, `I|${h.id}`)],
    [btn(`${h.type === 'any' ? '✅ ' : ''}Любой`, `Y|${h.id}|any`), btn(`${h.type === 'indoor' ? '✅ ' : ''}Крытый`, `Y|${h.id}|indoor`), btn(`${h.type === 'outdoor' ? '✅ ' : ''}Открытый`, `Y|${h.id}|outdoor`)]
  ];
  if (h.type !== 'any') {
    const maxN = h.type === 'indoor' ? 8 : 5;
    const nums = [btn(`${!h.courts.length ? '✅ ' : ''}Любой №`, `C|${h.id}|0`)];
    for (let n = 1; n <= maxN; n++) nums.push(btn(`${h.courts.includes(n) ? '✅' : ''}№${n}`, `C|${h.id}|${n}`));
    for (let i = 0; i < nums.length; i += 5) rows.push(nums.slice(i, i + 5));
  }
  rows.push([btn(`${h.mode === 'auto' ? '✅ ' : ''}Брать сразу`, `M|${h.id}|auto`), btn(`${h.mode === 'confirm' ? '✅ ' : ''}Спросить меня`, `M|${h.id}|confirm`)]);
  rows.push([h.active ? btn('⏹ Остановить эту охоту', `H|stop|${h.id}`) : btn('▶️ Запустить эту охоту', `H|go|${h.id}`)]);
  if (u.hunts.length > 1) rows.push([btn('🗑 Удалить охоту', `H|del|${h.id}`)]);
  rows.push([btn('⬅️ В меню', 'V|main')]);
  const plan = hunt.dayPlan(h).map(d => `${L.isoWord(d.iso)} ${Math.min(d.need, d.got)}/${d.need}`).join(' · ');
  const mode = h.mode === 'auto'
    ? '⚡ <b>Брать сразу</b> — бронирую молча и потом сообщаю. Надёжнее для вечерних слотов.'
    : '✋ <b>Спросить меня</b> — пришлю кнопку «Забрать», бронь только после нажатия.';
  const mass = h.needed > 1
    ? `\n\n👥 На одно время несколько кортов — оформлю на разных людей из списка контактов (${(u.contacts || []).filter(c => c.name && c.phone).length} шт.), чтобы администрация не отменила.`
    : '';
  return { text: `🎯 <b>${hunt.label(h)}</b>\n\n${plan || '—'} · ${type} · каждые ${h.interval} с${night}${mass}\n\n${mode}`, ...kb(rows) };
}

function vContacts(u) {
  const list = u.contacts || [];
  let text = `👥 <b>На кого бронируем</b>\n\nПервый контакт — основной. Остальные нужны, когда на одно и то же время берём больше одного корта: администрация отменяет несколько кортов, записанных на одного человека.\n`;
  if (!list.length) text += `\nПока пусто. Добавьте себя — имя и телефон.`;
  const rows = [];
  list.forEach((c, i) => {
    text += `\n${i + 1}. <b>${c.name || '— без имени'}</b> · ${c.phone || '— без телефона'}${c.email ? ' · ' + c.email : ''}${i === 0 ? '  ← основной' : ''}`;
    rows.push([btn(`✏️ ${i + 1}. ${(c.name || 'без имени').slice(0, 18)}`, `PE|${i}`), btn('🗑', `PD|${i}`)]);
  });
  if (list.length < store.MAX_CONTACTS) rows.push([btn('➕ Добавить контакт', 'PA|0')]);
  rows.push([btn('⬅️ В меню', 'V|main')]);
  return { text, ...kb(rows) };
}

function vContact(u, i) {
  const c = (u.contacts || [])[i] || { name: '', phone: '', email: '' };
  return { text: `✏️ <b>Контакт ${Number(i) + 1}</b>\n\nИмя: ${c.name || '— не указано'}\nТелефон: ${c.phone || '— не указан'}\nПочта: ${c.email || '—'}\n\nСайт данные не проверяет, оплата на месте — главное, чтобы на ресепшене узнали.`, ...kb([
    [btn('Имя', `P|${i}|name`), btn('Телефон', `P|${i}|phone`), btn('Почта', `P|${i}|email`)],
    [btn('⬅️ К контактам', 'V|contacts')]
  ]) };
}

function vBookings(u) {
  const act = hunt.allActiveBookings(u).sort((a, b) => a.b.start - b.b.start);
  if (!act.length) return { text: '📋 <b>Брони</b>\n\nПока пусто. Запустите охоту — добыча появится здесь.', ...kb([[btn('⬅️ В меню', 'V|main')]]) };
  let text = '📋 <b>Брони</b>';
  const rows = [];
  for (const { b } of act) {
    const d = L.deadlines(b.start);
    const late = Date.now() >= d.online;
    text += `\n\n🎾 <b>${hunt.courtTitle(b, b.name)}</b> · ${L.whenText(b.start, 60)}${L.midnightNote(b.start)}\nна ${b.onName || '—'}\n${late ? `Онлайн уже поздно — только звонком, до ${L.hm(d.phone)}` : `Отменить онлайн можно до ${L.hm(d.online)}, звонком — до ${L.hm(d.phone)}`}`;
    if (!late) rows.push([btn(`↩️ Отменить ${L.hm(b.start)} · ${hunt.courtTitle(b, b.name)}`, `c|${b.id}`)]);
  }
  rows.push([btn('⬅️ В меню', 'V|main')]);
  return { text, ...kb(rows) };
}

const vStatus = (u, g) => ({ text: '📊 <b>Статус</b>\n\n' + hunt.statusText(u, g), ...kb([[btn('🔄 Обновить', 'V|status'), btn('⬅️ В меню', 'V|main')]]) });

const vHelp = u => ({ text:
`❓ <b>Как это работает</b>

Корты в Даулете разбирают за минуты. Я обновляю расписание каждые ${(u.hunts[0] || {}).interval || store.DEF_IV} секунд и хватаю то, что подходит под ваш план.

<b>1. Контакты</b> — имя и телефон, на них оформляется бронь. Нужно взять несколько кортов на одно время — добавьте разных людей: на одно имя администрация отменяет.
<b>2. Охота</b> — дни, окно времени, сколько кортов на каждый день, тип корта.
<b>3. Запуск</b> — дальше я сам. Можно держать до ${store.MAX_HUNTS} охот одновременно: например «сегодня вечер» и «выходные утро».

<b>Единица брони — один час.</b> Нужно два часа подряд — поставьте «2 корта на день»: возьму два соседних часа, если они свободны.

<b>Что придёт в чат:</b>
🔔 «Освободился корт» + «Забрать» — в режиме «спросить меня».
🎾 «Поймал корт!» + кнопка отмены — когда бронь сделана.
⏰ «Час до дедлайна отмены».

<b>Про отмену:</b> онлайн — не позднее 5 часов до игры, потом только звонком (до 3 часов).

<b>Полночь:</b> слот «завтра 00:00» на сайте — это сегодня ночью, помечаю 🌙. Когда сутки меняются, «завтра» само становится «сегодня» — план не сбивается.

Искать перестаю только если: всё поймано · вы остановили · прошло 12 часов · выбранные дни закончились. Telegram можно закрывать, поиск идёт на сервере.`,
  ...kb([[btn('⬅️ В меню', 'V|main')]]) });

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

async function vAdmin(g) {
  const users = await store.loadUsers(g.users || []);
  const on = g.botOn !== false;
  let text = `👑 <b>Админ-панель</b>\n\nБот: ${on ? '🟢 включён' : '🔴 выключен для всех'}\nПользователей: ${(g.users || []).length}\n`;
  (g.users || []).forEach((r, i) => {
    const x = users.find(y => y.uid === r.uid);
    const hs = x ? x.hunts : [];
    const act = hs.filter(h => h.active);
    text += `\n${i + 1}. ${r.u ? '@' + r.u : (r.name || 'без ника')}${r.uid === g.adminUid ? ' 👑 (вы)' : ''}${r.blocked ? ' 🚫 отключён' : ''}\n` +
      `    ${r.name || '—'} · был: ${ago(r.last)} · действий: ${r.acts || 0}\n` +
      `    охоты: ${hs.length}${act.length ? ` · 🟢 идёт ${act.length}` : ' · на паузе'}\n`;
    for (const h of hs) {
      text += `      ${h.active ? '🟢' : '⚪'} ${hunt.label(h)} — ${hunt.bookedSlots(h)}/${hunt.goalSlots(h)}, каждые ${h.interval} с, ${h.mode === 'auto' ? 'сразу' : 'спрашивает'}\n`;
      for (const b of hunt.activeBookings(h)) text += `         🎾 ${hunt.courtTitle(b, b.name)} ${L.whenText(b.start, 60)} · ${b.onName || '—'}\n`;
    }
    const cs = x ? (x.contacts || []).filter(c => c.name || c.phone) : [];
    if (cs.length) text += `    контакты: ${cs.map(c => `${c.name} ${c.phone}`).join(' · ')}\n`;
  });
  text += `\nПароль доступа: <code>${g.password}</code>\nСменить: <code>/key НовыйПароль</code>`;
  const rows = [[on ? btn('🔴 Отключить бот', 'AB|off') : btn('🟢 Включить бот', 'AB|on')]];
  for (const r of g.users || []) {
    if (r.uid === g.adminUid) continue;
    const x = users.find(y => y.uid === r.uid);
    const line = [];
    if (x && x.hunts.some(h => h.active)) line.push(btn(`⏹ ${r.u ? '@' + r.u : r.name || r.uid}`, `AS|${r.uid}`));
    line.push(btn(`${r.blocked ? '🔓 Вернуть' : '🚫 Отключить'} ${r.u ? '@' + r.u : r.name || r.uid}`.slice(0, 38), `A|${r.uid}`));
    rows.push(line);
  }
  rows.push([btn('🔄 Обновить', 'V|admin'), btn('⬅️ В меню', 'V|main')]);
  return { text, ...kb(rows) };
}

async function view(name, u, g, arg) {
  if (name === 'hunt') return vHunt(u, svc.findHunt(u, arg));
  if (name === 'contacts') return vContacts(u);
  if (name === 'contact') return vContact(u, arg);
  if (name === 'bookings') return vBookings(u);
  if (name === 'status') return vStatus(u, g);
  if (name === 'help') return vHelp(u);
  if (name === 'admin') return u.isAdmin ? await vAdmin(g) : vMain(u, g);
  return vMain(u, g);
}

// ---------- сообщения ----------
async function onMessage(g, m, req) {
  const chat = m.chat.id;
  const from = m.from || {};
  const uid = Number(from.id || chat);
  const text = (m.text || '').trim();
  const [cmd, ...rest] = text.split(/\s+/);
  const arg = rest.join(' ');
  let row = svc.userRow(g, uid);

  // ---- не подключён: только пароль ----
  if (!row) {
    const pw = cmd === '/start' ? arg : text;
    if (pw && pw === g.password) {
      const { u } = await svc.linkUser(g, from, chat);
      store.log(g, `Подключился: ${from.first_name || uid}${from.username ? ' @' + from.username : ''}`);
      await store.saveGlobal(g);
      await tg.setCommands(COMMANDS);
      if (APP_URL) await tg.call('setChatMenuButton', { chat_id: chat, menu_button: { type: 'web_app', text: 'Панель', web_app: { url: `${APP_URL}#tk=${svc.mkToken(uid)}` } } });
      await tg.send(chat, '⌨️ Кнопки внизу — вместо команд.', { reply_markup: TOASTER });
      const p = panelBtn(u);
      await tg.send(chat,
        `🤝 <b>Пароль принят — вы в деле!</b>\n\n` +
        `У вас свой профиль: свои контакты, свои охоты, свои брони. Другие пользователи их не видят.\n\n` +
        `1️⃣ «Контакты» — имя и телефон\n2️⃣ «Охота» — дни и время\n3️⃣ «Запустить» — дальше я сам\n\n` +
        (p ? `Кнопка «📱 Открыть панель» — то же самое экраном.` : ''),
        p ? { reply_markup: { inline_keyboard: [p] } } : {});
      const v = vMain(u, g);
      return tg.send(chat, v.text, { reply_markup: v.reply_markup });
    }
    if (cmd.startsWith('/')) return tg.send(chat, '🔒 <b>Сначала пароль</b>\nЭто закрытый бот. Пришлите пароль одним сообщением — и открою доступ.');
    return tg.send(chat, `🎾 <b>Court Hunter</b>\n\nЛовлю свободные корты в Daulet Tennis (Кордай, 6) и бронирую их на вас, пока не увели.\n\n🔒 Доступ по паролю — пришлите его одним сообщением.`);
  }

  const u = await store.loadOrCreate(uid, chat);
  u.chat = chat; u.name = from.first_name || u.name; u.u = from.username || u.u;
  svc.bind(g, u);
  svc.touch(g, uid);
  if (row.blocked && !u.isAdmin) { await store.saveGlobal(g); return tg.send(chat, '🚪 Доступ закрыт владельцем.'); }
  if (g.botOn === false && !u.isAdmin) { await store.saveGlobal(g); return tg.send(chat, '🔴 Бот сейчас выключен владельцем. Загляните позже.'); }

  const done = async r => { await store.saveGlobal(g); await store.saveUser(u); return r; };

  if (cmd === '/key') {
    if (!u.isAdmin) return done(tg.send(chat, '⛔️ Такой команды нет.'));
    if (!arg || arg.length < 6) return done(tg.send(chat, 'Формат: <code>/key НовыйПароль</code> (от 6 символов)'));
    g.password = arg;
    store.log(g, 'Пароль обновлён владельцем');
    return done(tg.send(chat, `🔑 Готово, новый пароль: <code>${arg}</code>\nУже подключённые остаются.`));
  }

  // ---- ждём текстовый ввод (контакты) ----
  if (u.pending && !text.startsWith('/')) {
    const { field, ci } = u.pending;
    u.pending = null;
    if (field === 'phone') {
      const ph = svc.normPhone(text);
      if (!ph) { u.pending = { field, ci }; return done(tg.send(chat, 'В казахстанском номере 10 цифр после +7. Ещё раз? Например: 705 123 45 67')); }
      svc.setContact(u, ci, { phone: ph });
    } else if (field === 'email') {
      if (text !== '-' && !/^\S+@\S+\.\S+$/.test(text)) { u.pending = { field, ci }; return done(tg.send(chat, 'Кажется, опечатка в адресе. Ещё раз? (или «-», чтобы оставить пустым)')); }
      svc.setContact(u, ci, { email: text === '-' ? '' : text });
    } else svc.setContact(u, ci, { name: text.slice(0, 60) });
    store.log(u, 'Контакты обновлены из Telegram');
    const v = vContact(u, ci);
    return done(tg.send(chat, '👌 Записал.\n\n' + v.text, { reply_markup: v.reply_markup }));
  }

  if (cmd === '/start' || cmd === '/menu' || text === '🎾 Меню') {
    // Держим кнопку меню чата на том же URL, что и кнопка в сообщении: разные ссылки
    // Telegram считает разными мини-аппами и открывает второе окно.
    if (APP_URL) await tg.call('setChatMenuButton', { chat_id: chat, menu_button: { type: 'web_app', text: 'Панель', web_app: { url: `${APP_URL}#tk=${svc.mkToken(uid)}` } } });
    await tg.send(chat, '⌨️ Кнопки внизу — вместо команд.', { reply_markup: TOASTER });
    const v = vMain(u, g); return done(tg.send(chat, v.text, { reply_markup: v.reply_markup }));
  }
  if (cmd === '/help' || text === '❓ Помощь') { const v = vHelp(u); return done(tg.send(chat, v.text, { reply_markup: v.reply_markup })); }
  if (cmd === '/status' || text === '📊 Статус') { const v = vStatus(u, g); return done(tg.send(chat, v.text, { reply_markup: v.reply_markup })); }
  if (cmd === '/bookings' || cmd === '/cancel' || text === '📋 Брони') { const v = vBookings(u); return done(tg.send(chat, v.text, { reply_markup: v.reply_markup })); }
  if (cmd === '/stop' || text === '⏹ Стоп') {
    let n = 0;
    for (const h of u.hunts) if (h.active) { await svc.stopHunt(u, g, h, req, 'Telegram'); n++; }
    const v = vMain(u, g);
    return done(tg.send(chat, n ? `⏹ Остановил ${n === 1 ? 'охоту' : `охот: ${n}`}. В панели тоже выключено.` : 'Все охоты и так на паузе.', { reply_markup: v.reply_markup }));
  }
  if (cmd === '/admin') {
    if (!u.isAdmin) return done(tg.send(chat, '⛔️ Такой команды нет.'));
    const v = await vAdmin(g); return done(tg.send(chat, v.text, { reply_markup: v.reply_markup }));
  }
  const v = vMain(u, g);
  return done(tg.send(chat, 'Я тут 👋 Всё управление — на кнопках:', { reply_markup: v.reply_markup }));
}

// ---------- кнопки ----------
async function onCallback(g, cb, req) {
  const chat = cb.message && cb.message.chat.id;
  const msgId = cb.message && cb.message.message_id;
  const uid = Number((cb.from && cb.from.id) || chat);
  const row = svc.userRow(g, uid);
  if (!row) { await tg.send(chat, '🔒 Сначала пришлите пароль одним сообщением.'); return tg.answerCb(cb.id, 'Нужен пароль'); }
  const u = await store.loadOrCreate(uid, chat);
  svc.bind(g, u);
  svc.touch(g, uid);
  if (row.blocked && !u.isAdmin) return tg.answerCb(cb.id, 'Доступ закрыт владельцем');
  if (g.botOn === false && !u.isAdmin) return tg.answerCb(cb.id, 'Бот выключен владельцем');

  const [op, a, b2] = String(cb.data || '').split('|');
  let toast = '', target = null, targetArg = null;
  const show = async (name, arg) => {
    const v = await view(name, u, g, arg);
    await tg.edit(chat, msgId, v.text, { reply_markup: v.reply_markup });
  };
  const fin = async () => {
    await store.saveGlobal(g);
    await store.saveUser(u);
    if (target) await show(target, targetArg);
    return tg.answerCb(cb.id, toast);
  };

  if (op === 'x') return tg.answerCb(cb.id, '');

  if (op === 'V') {
    if (a === 'admin' && !u.isAdmin) return tg.answerCb(cb.id, 'Только для владельца');
    target = a; targetArg = b2;
    return fin();
  }

  // ---- охоты ----
  if (op === 'H') {
    if (a === 'add') {
      const r = svc.addHunt(u);
      toast = r.ok ? 'Добавил охоту' : r.why;
      target = r.ok ? 'hunt' : 'main'; targetArg = r.ok ? r.h.id : null;
      return fin();
    }
    const h = svc.findHunt(u, b2);
    if (a === 'go') {
      const r = await svc.startHunt(u, g, h, req, 'Telegram');
      if (!r.ok) {
        if (/контакт/i.test(r.why)) { await store.saveUser(u); await show('contacts'); return tg.answerCb(cb.id, r.why); }
        toast = r.why; target = 'hunt'; targetArg = h.id;
        return fin();
      }
      toast = `Погнали! Каждые ${h.interval} с 🟢`;
      target = 'main';
      return fin();
    }
    if (a === 'stop') { await svc.stopHunt(u, g, h, req, 'Telegram'); toast = 'Остановил — и в панели тоже'; target = 'main'; return fin(); }
    if (a === 'del') {
      const r = svc.removeHunt(u, h.id);
      toast = r.ok ? 'Удалил' : r.why; target = r.ok ? 'main' : 'hunt'; targetArg = r.ok ? null : h.id;
      return fin();
    }
  }

  // ---- правки плана ----
  const H = () => svc.findHunt(u, a);
  if (op === 'D') {
    const h = H(), iso = store.isoToday(Number(b2));
    const days = (h.days || []).includes(iso) ? h.days.filter(x => x !== iso) : [...(h.days || []), iso].sort();
    if (!days.length) return tg.answerCb(cb.id, 'Хотя бы один день нужен');
    svc.patchHunt(u, h, { days });
    target = 'hunt'; targetArg = h.id;
    return fin();
  }
  if (op === 'F' || op === 'T') {
    const h = H();
    const cur = parseInt(op === 'F' ? h.timeFrom : h.timeTo);
    const next = L.hourVal(cur + Number(b2));
    svc.patchHunt(u, h, op === 'F' ? { timeFrom: next } : { timeTo: next });
    if (parseInt(h.timeTo) - parseInt(h.timeFrom) === L.MIN_WINDOW) toast = `Окно не короче ${L.MIN_WINDOW} ч — иначе ловить нечего`;
    target = 'hunt'; targetArg = h.id;
    return fin();
  }
  if (op === 'N') { const h = H(); svc.patchHunt(u, h, { needed: h.needed + Number(b2) }); target = 'hunt'; targetArg = h.id; return fin(); }
  if (op === 'I') {
    const h = H();
    const i = store.IVS.indexOf(Number(h.interval));
    svc.patchHunt(u, h, { interval: store.IVS[(i + 1) % store.IVS.length] });
    toast = `Проверяю каждые ${h.interval} с`;
    target = 'hunt'; targetArg = h.id;
    return fin();
  }
  if (op === 'Y') { const h = H(); svc.patchHunt(u, h, { type: b2, courts: [] }); target = 'hunt'; targetArg = h.id; return fin(); }
  if (op === 'C') {
    const h = H(), n = Number(b2);
    const courts = n === 0 ? [] : (h.courts.includes(n) ? h.courts.filter(x => x !== n) : [...h.courts, n].sort());
    svc.patchHunt(u, h, { courts });
    target = 'hunt'; targetArg = h.id;
    return fin();
  }
  if (op === 'M') { const h = H(); svc.patchHunt(u, h, { mode: b2 }); target = 'hunt'; targetArg = h.id; return fin(); }

  // ---- контакты ----
  if (op === 'PA') {
    if ((u.contacts || []).length >= store.MAX_CONTACTS) return tg.answerCb(cb.id, `Максимум ${store.MAX_CONTACTS}`);
    svc.setContact(u, (u.contacts || []).length, { name: '', phone: '' });
    const i = u.contacts.length - 1;
    u.pending = { field: 'name', ci: i };
    await store.saveUser(u);
    await tg.send(chat, '✏️ Как записать? Пришлите имя и фамилию');
    return tg.answerCb(cb.id, '');
  }
  if (op === 'PE') { target = 'contact'; targetArg = Number(a); return fin(); }
  if (op === 'PD') {
    svc.delContact(u, Number(a));
    toast = 'Удалил'; target = 'contacts';
    return fin();
  }
  if (op === 'P') {
    u.pending = { field: b2, ci: Number(a) };
    await store.saveUser(u);
    await tg.send(chat, '✏️ ' + (b2 === 'phone' ? 'Пришлите номер: 705 123 45 67 (+7 добавлю сам)'
      : b2 === 'email' ? 'Пришлите почту (или «-», чтобы оставить пустой)' : 'Как записать? Пришлите имя и фамилию'));
    return tg.answerCb(cb.id, '');
  }

  // ---- предложения и брони ----
  if (op === 'b') {
    const r = await hunt.takeOffer(u, a);
    await store.saveUser(u);
    if (!r.ok) await tg.send(chat, '⚠️ ' + r.why);
    return tg.answerCb(cb.id, r.ok ? 'Есть! Забронировал 🎾' : 'Не вышло');
  }
  if (op === 'sk') {
    hunt.dropOffer(u, a);
    await store.saveUser(u);
    await tg.edit(chat, msgId, ((cb.message && cb.message.text) || 'Предложение') + '\n\n✖️ Пропущено', {});
    return tg.answerCb(cb.id, 'Ок, пропустил');
  }
  if (op === 'c') {
    const r = await hunt.doCancel(u, a);
    await store.saveUser(u);
    if (r.ok) {
      await hunt.alertAdmin(u, `↩️ <b>${hunt.who(u)}</b> отменил: ${hunt.courtTitle(r.b, r.b.name)} · ${L.whenText(r.b.start, 60)}`);
      await tg.send(chat, `↩️ Бронь отменена: ${hunt.courtTitle(r.b, r.b.name)} · ${L.whenText(r.b.start, 60)}\nСлот снова свободен на сайте.`);
      return tg.answerCb(cb.id, 'Отменил ✅');
    }
    await tg.send(chat, '⚠️ ' + r.why);
    return tg.answerCb(cb.id, 'Не получилось');
  }

  // ---- админ ----
  if (op === 'AB') {
    if (!u.isAdmin) return tg.answerCb(cb.id, 'Только для владельца');
    g.botOn = a === 'on';
    store.log(g, g.botOn ? 'Владелец включил бота' : 'Владелец выключил бота');
    if (!g.botOn) {
      const users = await store.loadUsers(g.users || []);
      for (const t of users) { for (const h of t.hunts) h.active = false; await store.saveUser(t); }
      await chain.drop();
    }
    toast = g.botOn ? 'Бот включён 🟢' : 'Бот выключен 🔴';
    target = 'admin';
    return fin();
  }
  if (op === 'AS') {
    if (!u.isAdmin) return tg.answerCb(cb.id, 'Только для владельца');
    const t = await store.loadUser(Number(a));
    if (t) {
      svc.bind(g, t);
      for (const h of t.hunts) if (h.active) { h.active = false; store.log(t, 'Охота остановлена владельцем', 1); }
      await store.saveUser(t);
      await hunt.sendTo(t, '⏹ Владелец остановил вашу охоту.');
    }
    toast = 'Остановил'; target = 'admin';
    return fin();
  }
  if (op === 'A') {
    if (!u.isAdmin) return tg.answerCb(cb.id, 'Только для владельца');
    const r2 = svc.userRow(g, Number(a));
    if (!r2 || r2.uid === g.adminUid) return tg.answerCb(cb.id, 'Так нельзя');
    r2.blocked = !r2.blocked;
    const t = await store.loadUser(r2.uid);
    if (t) {
      svc.bind(g, t);
      if (r2.blocked) for (const h of t.hunts) h.active = false;
      await store.saveUser(t);
      await hunt.sendTo(t, r2.blocked ? '🚪 Доступ к боту закрыт владельцем. Если это ошибка — напишите ему.' : '🔓 Доступ снова открыт — /menu');
    }
    store.log(g, `${r2.blocked ? 'Отключил' : 'Вернул'} ${r2.u ? '@' + r2.u : r2.uid}`);
    toast = r2.blocked ? 'Отключил' : 'Вернул доступ';
    target = 'admin';
    return fin();
  }

  return fin();
}
