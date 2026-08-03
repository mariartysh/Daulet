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

const answerCb = (id, text) => call('answerCallbackQuery', { callback_query_id: id, text: (text || '').slice(0, 190) });

module.exports = { call, send, answerCb };
