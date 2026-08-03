// Telegram Bot API. Никогда не бросает исключений и повторяет попытку при сетевом сбое,
// иначе упавшее сообщение обрывало весь проход охоты.
const wait = ms => new Promise(r => setTimeout(r, ms));

async function call(method, payload, tries) {
  const token = process.env.TELEGRAM_TOKEN;
  if (!token) return { ok: false, description: 'TELEGRAM_TOKEN не задан' };
  const n = Math.max(1, tries || 2);
  let last = { ok: false, description: 'нет ответа' };
  for (let i = 0; i < n; i++) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const j = await r.json().catch(() => ({ ok: false, description: 'HTTP ' + r.status }));
      if (j.ok) return j;
      last = j;
      const ra = j.parameters && j.parameters.retry_after;
      if (ra) await wait(Math.min(3, Number(ra)) * 1000);
      else if (r.status < 500 && r.status !== 429) return j;   // 400/403 — повтор не поможет
    } catch (e) {
      last = { ok: false, description: e.message };
      await wait(400);
    }
  }
  return last;
}

const send = (chat_id, text, extra = {}) =>
  call('sendMessage', { chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });

// правка сообщения на месте (меню на кнопках); "message is not modified" глотаем
const edit = (chat_id, message_id, text, extra = {}) =>
  call('editMessageText', { chat_id, message_id, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });

const answerCb = (id, text) => call('answerCallbackQuery', { callback_query_id: id, text: (text || '').slice(0, 190) });

const setCommands = commands => call('setMyCommands', { commands });

module.exports = { call, send, edit, answerCb, setCommands };
