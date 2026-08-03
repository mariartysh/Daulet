// Telegram-webhook: команды владельца + inline-кнопки (бронь по кнопке, отмена).
const store = require('../lib/store');
const hunt = require('../lib/hunt');
const tg = require('../lib/tg');
const L = require('../lib/logic');

const HELP =
  '🤖 <b>Команды</b>\n' +
  '/status — задание, брони, дедлайны\n' +
  '/auto — включить охоту\n' +
  '/stop — выключить охоту\n' +
  '/cancel — отменить бронь (кнопки)\n' +
  '/password НОВЫЙ — сменить пароль панели\n' +
  '/help — это меню';

module.exports = async (req, res) => {
  if (process.env.TG_SECRET && req.headers['x-telegram-bot-api-secret-token'] !== process.env.TG_SECRET)
    return res.status(401).json({ ok: false });
  const u = req.body || {};
  const s = await store.load();
  try {
    if (u.message && u.message.text) await onMessage(s, u.message);
    else if (u.callback_query) await onCallback(s, u.callback_query);
  } catch (e) {
    store.log(s, 'Ошибка webhook: ' + e.message, 1);
  }
  await store.save(s);
  return res.status(200).json({ ok: true });
};

async function onMessage(s, m) {
  const chat = m.chat.id;
  const text = (m.text || '').trim();
  const [cmd, ...rest] = text.split(/\s+/);
  const arg = rest.join(' ');

  if (cmd === '/start') {
    if (s.ownerChat === chat) return tg.send(chat, 'Уже привязано ✅\n\n' + HELP);
    if (arg && arg === s.password) {
      s.ownerChat = chat;
      store.log(s, 'Telegram привязан (chat ' + chat + ')');
      return tg.send(chat, '✅ Привязано! Уведомления будут приходить сюда.\n\n' + HELP);
    }
    return tg.send(chat, 'Пришлите пароль панели: <code>/start ПАРОЛЬ</code>');
  }
  if (s.ownerChat !== chat) return; // чужих игнорируем молча

  if (cmd === '/help') return tg.send(chat, HELP);
  if (cmd === '/status') return tg.send(chat, hunt.statusText(s));
  if (cmd === '/auto') {
    if (hunt.activeBookings(s).length >= s.task.needed)
      return tg.send(chat, `Цель уже достигнута (${s.task.needed}). Увеличьте цель в панели или отмените бронь.`);
    s.task.active = true;
    store.log(s, 'Охота включена через Telegram');
    return tg.send(chat, `🟢 Охота включена.\n${hunt.statusText(s)}`);
  }
  if (cmd === '/stop') {
    s.task.active = false;
    store.log(s, 'Охота выключена через Telegram');
    return tg.send(chat, '⚪ Охота выключена. Включить снова — /auto');
  }
  if (cmd === '/password') {
    if (!arg || arg.length < 6) return tg.send(chat, 'Формат: <code>/password НовыйПароль</code> (минимум 6 символов)');
    s.password = arg;
    store.log(s, 'Пароль панели изменён через Telegram');
    return tg.send(chat, '🔑 Пароль панели изменён. Активные сессии панели сброшены.');
  }
  if (cmd === '/cancel') {
    const act = hunt.activeBookings(s).sort((a, b) => a.start - b.start);
    if (!act.length) return tg.send(chat, 'Активных броней нет.');
    return tg.send(chat, 'Какую бронь отменить?', {
      reply_markup: { inline_keyboard: act.map(b => [{ text: `${hunt.courtTitle(b, b.name)} · ${L.fmt(b.start)}`, callback_data: `c|${b.id}` }]) }
    });
  }
  return tg.send(chat, 'Не понял. ' + HELP);
}

async function onCallback(s, cb) {
  const chat = cb.message && cb.message.chat.id;
  if (s.ownerChat !== chat) return tg.answerCb(cb.id, 'Нет доступа');
  const [op, a, b, c] = String(cb.data || '').split('|');

  if (op === 'b') { // бронь по кнопке (режим confirm)
    if (hunt.activeBookings(s).length >= s.task.needed) return tg.answerCb(cb.id, 'Цель уже достигнута');
    const startMs = Number(c) * 1000;
    if (Date.now() > startMs - 10 * 60e3) return tg.answerCb(cb.id, 'Слот уже в прошлом');
    const r = await hunt.doBook(s, Number(a), Number(b) || null, startMs);
    return tg.answerCb(cb.id, r.ok ? 'Забронировано ✅' : 'Не вышло: слот мог уйти');
  }
  if (op === 'c') { // отмена
    const r = await hunt.doCancel(s, a);
    if (r.ok) {
      await tg.send(chat, `↩️ <b>Бронь отменена</b>\n${hunt.courtTitle(r.b, r.b.name)} · ${L.fmt(r.b.start)}\nСлот снова свободен на сайте.`);
      return tg.answerCb(cb.id, 'Отменено ✅');
    }
    await tg.send(chat, '⚠️ ' + r.why);
    return tg.answerCb(cb.id, 'Не вышло');
  }
  return tg.answerCb(cb.id, '');
}
