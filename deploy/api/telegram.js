// Telegram-бот: всё управление кнопками. Меню правится на месте (editMessageText).
const store = require('../lib/store');
const hunt = require('../lib/hunt');
const tg = require('../lib/tg');
const L = require('../lib/logic');

const ADMIN = (process.env.ADMIN_USERNAME || 'gaucho_bro').toLowerCase().replace('@', '');
const DAY = ['Сегодня', 'Завтра', 'Послезавтра'];
const kb = rows => ({ reply_markup: { inline_keyboard: rows } });
const btn = (text, data) => ({ text, callback_data: data });

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
  await store.save(s);
  return res.status(200).json({ ok: true });
};

const linked = (s, chat) => (s.chats || []).some(c => (c.id || c) === chat);

// ---------- экраны ----------
function vMain(s) {
  const t = s.task, act = hunt.activeBookings(s).length;
  const days = (t.dayOffsets || [0]).map(o => DAY[o].toLowerCase()).join(', ');
  const text = `🎾 <b>Court Hunter</b>\n` + (t.active
    ? `🟢 Ловлю: ${days}, ${t.timeFrom}–${t.timeTo}, ${Math.round(t.dur / 60)} ч\nПоймано ${act} из ${t.needed}`
    : `⚪ Сплю. Настройте и жмите «Начать охоту»\nПлан: ${days}, ${t.timeFrom}–${t.timeTo}, нужно кортов: ${t.needed}`);
  return { text, ...kb([
    [t.active ? btn('⏹ Остановить охоту', 'M|stop') : btn('▶️ Начать охоту', 'M|go')],
    [btn('🗓 Когда', 'V|when'), btn('🎛 Фильтр', 'V|filters')],
    [btn('🙋 Кто играет', 'V|profile'), btn(`📋 Брони (${act})`, 'V|bookings')],
    [btn('📊 Статус', 'V|status'), btn('🔄 Обновить', 'V|main')]
  ]) };
}

function vWhen(s) {
  const t = s.task;
  const dayRow = [0, 1, 2].map(o => btn(`${(t.dayOffsets || []).includes(o) ? '✅ ' : ''}${DAY[o]}`, `Wd|${o}`));
  return { text: `🗓 <b>Когда играем</b>\nСейчас: ${(t.dayOffsets || [0]).map(o => DAY[o].toLowerCase()).join(', ')} · ${t.timeFrom}–${t.timeTo} · ${Math.round(t.dur / 60)} ч · кортов: ${t.needed}`, ...kb([
    dayRow,
    [btn('−', 'Wf|-1'), btn(`начало: ${t.timeFrom}`, 'x'), btn('+', 'Wf|1')],
    [btn('−', 'Wt|-1'), btn(`конец: ${t.timeTo}`, 'x'), btn('+', 'Wt|1')],
    [btn(`${t.dur === 60 ? '✅ ' : ''}1 ч`, 'Du|60'), btn(`${t.dur === 120 ? '✅ ' : ''}2 ч`, 'Du|120'), btn(`${t.dur === 180 ? '✅ ' : ''}3 ч`, 'Du|180')],
    [btn('−', 'N|-1'), btn(`кортов: ${t.needed}`, 'x'), btn('+', 'N|1')],
    [btn('⬅️ В меню', 'V|main')]
  ]) };
}

function vFilters(s) {
  const t = s.task;
  const rows = [
    [btn(`${t.type === 'any' ? '✅ ' : ''}Любой`, 'Ft|any'), btn(`${t.type === 'indoor' ? '✅ ' : ''}Крытый`, 'Ft|indoor'), btn(`${t.type === 'outdoor' ? '✅ ' : ''}Уличный`, 'Ft|outdoor')]
  ];
  let note = '';
  if (t.type === 'any') note = '\nНомер корта можно выбрать после типа — у крытых (1–8) и уличных (1–5) нумерация своя.';
  else {
    const maxN = t.type === 'indoor' ? 8 : 5;
    const nums = [btn(`${!t.courts.length ? '✅ ' : ''}Любой №`, 'Fc|0')];
    for (let n = 1; n <= maxN; n++) nums.push(btn(`${t.courts.includes(n) ? '✅' : ''}№${n}`, `Fc|${n}`));
    for (let i = 0; i < nums.length; i += 5) rows.push(nums.slice(i, i + 5));
  }
  rows.push([btn(`${t.mode === 'confirm' ? '✅ ' : ''}✋ Сначала спросить`, 'Fm|confirm'), btn(`${t.mode === 'auto' ? '✅ ' : ''}⚡ Бронить сразу`, 'Fm|auto')]);
  rows.push([btn('⬅️ В меню', 'V|main')]);
  return { text: `🎾 <b>Какой корт ловим</b>${note}\n«Сначала спросить» — пришлю свободный слот с кнопкой, бронь только после вашего нажатия.`, ...kb(rows) };
}

function vProfile(s) {
  const p = s.profile;
  return { text: `🙋 <b>На кого бронируем</b>\nИмя: ${p.name || '—'}\nТелефон: ${p.phone || '—'}\nПочта: ${p.email || '—'}\n\nОплата на месте, при себе ничего не нужно.`, ...kb([
    [btn('✏️ Имя', 'P|name'), btn('✏️ Телефон', 'P|phone')],
    [btn('✏️ Почта', 'P|email')],
    [btn('⬅️ В меню', 'V|main')]
  ]) };
}

function vBookings(s) {
  const act = hunt.activeBookings(s).sort((a, b) => a.start - b.start);
  if (!act.length) return { text: '📋 <b>Брони</b>\nПока пусто. Запустите охоту — сюда упадёт добыча 🎾', ...kb([[btn('⬅️ В меню', 'V|main')]]) };
  let text = '📋 <b>Брони</b>';
  const rows = [];
  for (const b of act) {
    const d = L.deadlines(b.start);
    text += `\n\n${hunt.courtTitle(b, b.name)} · ${L.whenText(b.start, b.dur)}${L.midnightNote(b.start)}\nОтмена: онлайн до ${L.hm(d.online)} · звонком до ${L.hm(d.phone)}`;
    if (Date.now() < d.online) rows.push([btn(`↩️ Отменить ${L.hm(b.start)} (${hunt.courtTitle(b, b.name)})`, `c|${b.id}`)]);
  }
  rows.push([btn('⬅️ В меню', 'V|main')]);
  return { text, ...kb(rows) };
}

function vStatus(s) {
  return { text: '📊 ' + hunt.statusText(s), ...kb([[btn('🔄 Обновить', 'V|status'), btn('⬅️ В меню', 'V|main')]]) };
}

const VIEWS = { main: vMain, when: vWhen, filters: vFilters, profile: vProfile, bookings: vBookings, status: vStatus };

// ---------- сообщения ----------
async function onMessage(s, m) {
  const chat = m.chat.id;
  const text = (m.text || '').trim();
  const [cmd, ...rest] = text.split(/\s+/);
  const arg = rest.join(' ');
  const isAdmin = ((m.from && m.from.username) || '').toLowerCase() === ADMIN;

  if (!linked(s, chat)) {
    const pw = cmd === '/start' ? arg : text;
    if (pw && pw === s.password) {
      s.chats = s.chats || [];
      s.chats.push({ id: chat, name: (m.from && m.from.first_name) || '', u: (m.from && m.from.username) || '' });
      store.log(s, `Подключился новый чат: ${(m.from && m.from.first_name) || chat}`);
      await tg.setCommands([
        { command: 'menu', description: 'Меню с кнопками' },
        { command: 'status', description: 'Что происходит' },
        { command: 'stop', description: 'Остановить охоту' }
      ]);
      await tg.send(chat, '🤝 Готово, вы в деле! Уведомления теперь будут приходить сюда.');
      const v = vMain(s);
      return tg.send(chat, v.text, { reply_markup: v.reply_markup });
    }
    return tg.send(chat, 'Привет! Это приватный Court Hunter 🎾\nПришлите пароль одним сообщением — и я вас подключу.');
  }

  // скрытая команда владельца
  if (cmd === '/key') {
    if (!isAdmin) return;
    if (!arg || arg.length < 6) return tg.send(chat, 'Так: <code>/key НовыйПароль</code> (от 6 символов)');
    s.password = arg;
    store.log(s, 'Пароль обновлён владельцем');
    return tg.send(chat, '🔑 Принял, пароль обновлён.');
  }

  // ждём текстовый ввод (имя/телефон/почта)
  if (s.pending && s.pending.chat === chat && !text.startsWith('/')) {
    const f = s.pending.field;
    s.pending = null;
    if (f === 'phone') {
      let d = text.replace(/\D/g, '');
      if (d.startsWith('8')) d = '7' + d.slice(1);
      if (!d.startsWith('7')) d = '7' + d;
      if (d.length !== 11) { s.pending = { chat, field: 'phone' }; return tg.send(chat, 'Хм, в казахстанском номере 10 цифр после +7. Попробуйте ещё раз, например: 705 123 45 67'); }
      s.profile.phone = '+' + d;
    } else if (f === 'email') {
      if (arg !== '-' && !/^\S+@\S+\.\S+$/.test(text)) { s.pending = { chat, field: 'email' }; return tg.send(chat, 'Похоже, в адресе опечатка. Ещё раз? (или «-», чтобы оставить пустым)'); }
      s.profile.email = text === '-' ? '' : text;
    } else s.profile.name = text.slice(0, 60);
    store.log(s, 'Данные для брони обновлены из Telegram');
    const v = vProfile(s);
    return tg.send(chat, '👌 Записал.\n\n' + v.text, { reply_markup: v.reply_markup });
  }

  if (cmd === '/start' || cmd === '/menu' || cmd === '/help') { const v = vMain(s); return tg.send(chat, v.text, { reply_markup: v.reply_markup }); }
  if (cmd === '/status') { const v = vStatus(s); return tg.send(chat, v.text, { reply_markup: v.reply_markup }); }
  if (cmd === '/stop') { s.task.active = false; store.log(s, 'Охота остановлена из Telegram'); return tg.send(chat, '⏹ Остановил. Продолжить — /menu'); }
  if (cmd === '/cancel') { const v = vBookings(s); return tg.send(chat, v.text, { reply_markup: v.reply_markup }); }
  const v = vMain(s);
  return tg.send(chat, 'Я тут 👋 Всё управление — на кнопках:', { reply_markup: v.reply_markup });
}

// ---------- кнопки ----------
async function onCallback(s, cb) {
  const chat = cb.message && cb.message.chat.id;
  const msgId = cb.message && cb.message.message_id;
  if (!linked(s, chat)) return tg.answerCb(cb.id, 'Нет доступа');
  const [op, a, b2, c2] = String(cb.data || '').split('|');
  const t = s.task;
  let view = null, toast = '';

  const show = async name => { const v = VIEWS[name](s); await tg.edit(chat, msgId, v.text, { reply_markup: v.reply_markup }); };

  if (op === 'x') return tg.answerCb(cb.id, '');
  if (op === 'V') { await show(a); return tg.answerCb(cb.id, ''); }

  if (op === 'M') {
    if (a === 'stop') { t.active = false; store.log(s, 'Охота остановлена кнопкой'); toast = 'Остановил'; view = 'main'; }
    else if (a === 'go') {
      if (!s.profile.name || !s.profile.phone) { await show('profile'); return tg.answerCb(cb.id, 'Сначала имя и телефон — на кого бронировать?'); }
      if (hunt.activeBookings(s).length >= t.needed) { toast = 'Цель уже набрана — добавьте кортов'; view = 'when'; }
      else { t.active = true; s.stats.startedAt = Date.now(); store.log(s, `Охота запущена из Telegram: нужно ${t.needed}, ${t.timeFrom}–${t.timeTo}`); toast = 'Погнали! 🟢'; view = 'main'; }
    }
  }
  else if (op === 'Wd') {
    const o = Number(a);
    const next = (t.dayOffsets || []).includes(o) ? t.dayOffsets.filter(x => x !== o) : [...(t.dayOffsets || []), o].sort();
    if (!next.length) return tg.answerCb(cb.id, 'Хотя бы один день нужен');
    t.dayOffsets = next; view = 'when';
  }
  else if (op === 'Wf') {
    let h = parseInt(t.timeFrom) + Number(a);
    h = Math.max(6, Math.min(23, h));
    t.timeFrom = `${String(h).padStart(2, '0')}:00`;
    if (parseInt(t.timeTo) <= h) t.timeTo = h + 1 === 24 ? '24:00' : `${String(h + 1).padStart(2, '0')}:00`;
    view = 'when';
  }
  else if (op === 'Wt') {
    let h = parseInt(t.timeTo) + Number(a);
    h = Math.max(parseInt(t.timeFrom) + 1, Math.min(24, h));
    t.timeTo = h === 24 ? '24:00' : `${String(h).padStart(2, '0')}:00`;
    view = 'when';
  }
  else if (op === 'Du') { t.dur = Number(a); view = 'when'; }
  else if (op === 'N') { t.needed = Math.max(1, Math.min(10, t.needed + Number(a))); view = 'when'; }
  else if (op === 'Ft') { t.type = a; t.courts = []; view = 'filters'; }
  else if (op === 'Fc') {
    const n = Number(a);
    t.courts = n === 0 ? [] : (t.courts.includes(n) ? t.courts.filter(x => x !== n) : [...t.courts, n].sort());
    view = 'filters';
  }
  else if (op === 'Fm') { t.mode = a; view = 'filters'; }
  else if (op === 'P') {
    s.pending = { chat, field: a };
    const ask = a === 'phone' ? 'Пришлите номер: 705 123 45 67 (+7 добавлю сам)' : a === 'email' ? 'Пришлите почту (или «-», чтобы оставить пустой)' : 'Как записать? Пришлите имя и фамилию';
    await tg.send(chat, '✏️ ' + ask);
    return tg.answerCb(cb.id, '');
  }
  else if (op === 'b') { // забрать слот (режим «спросить»)
    if (hunt.activeBookings(s).length >= t.needed) return tg.answerCb(cb.id, 'Цель уже набрана');
    const startMs = Number(c2) * 1000;
    if (Date.now() > startMs - 10 * 60e3) return tg.answerCb(cb.id, 'Увы, этот слот уже в прошлом');
    const r = await hunt.doBook(s, Number(a), Number(b2) || null, startMs);
    return tg.answerCb(cb.id, r.ok ? 'Есть! Забронировал 🎾' : 'Не вышло — похоже, слот увели');
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
