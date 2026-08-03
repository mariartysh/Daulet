// Telegram Bot API
async function call(method, payload) {
  const token = process.env.TELEGRAM_TOKEN;
  if (!token) return { ok: false, description: 'TELEGRAM_TOKEN не задан' };
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  return r.json().catch(() => ({ ok: false }));
}

const send = (chat_id, text, extra = {}) =>
  call('sendMessage', { chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });

// правка сообщения на месте (меню на кнопках); "message is not modified" глотаем
const edit = (chat_id, message_id, text, extra = {}) =>
  call('editMessageText', { chat_id, message_id, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });

const answerCb = (id, text) => call('answerCallbackQuery', { callback_query_id: id, text: (text || '').slice(0, 190) });

const setCommands = commands => call('setMyCommands', { commands });

module.exports = { call, send, edit, answerCb, setCommands };
