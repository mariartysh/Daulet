// /api/health — что живо, а что нет. Открывается без ключа (секреты не показываются).
// С ?key=TICK_KEY добавляет состояние вебхука Telegram и последнюю ошибку доставки.
const store = require('../lib/store');

const ms = t => t ? Math.round((Date.now() - t) / 1000) + ' с назад' : 'не было';

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const full = (req.query || {}).key && (req.query || {}).key === process.env.TICK_KEY;
  const out = {
    функция_отвечает: true,
    время: new Date().toISOString(),
    переменные: {
      UPSTASH_REDIS_REST_URL: !!process.env.UPSTASH_REDIS_REST_URL,
      UPSTASH_REDIS_REST_TOKEN: !!process.env.UPSTASH_REDIS_REST_TOKEN,
      TELEGRAM_TOKEN: !!process.env.TELEGRAM_TOKEN,
      ALTEGIO_AUTH: !!process.env.ALTEGIO_AUTH,
      TICK_KEY: !!process.env.TICK_KEY,
      APP_URL: (process.env.APP_URL || '').trim() || 'НЕ ЗАДАН'
    },
    база: store.live ? 'настроена' : 'НЕТ — данные живут в памяти и стираются при каждом запуске (отсюда «слетел пароль»)'
  };

  // Проверяем, что база реально отвечает
  if (store.live) {
    try {
      const r = await fetch(process.env.UPSTASH_REDIS_REST_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(['PING'])
      });
      const t = await r.text();
      out.база_ответ = r.status === 200 && /PONG/i.test(t) ? 'PONG — работает' : `статус ${r.status}: ${t.slice(0, 160)}`;
    } catch (e) { out.база_ответ = 'нет связи: ' + e.message; }
  }

  // Состояние данных
  try {
    const g = await store.loadGlobal();
    out.данные = {
      схема: g.v, пользователей: (g.users || []).length, владелец_uid: g.adminUid,
      бот_включён: g.botOn !== false,
      пароль_задан: !!g.password,
      пароль_по_умолчанию: g.password === 'admin' ? 'ДА — состояние сброшено' : 'нет'
    };
    out.команды_к_базе = {
      за_этот_месяц_оценка: store.used(g),
      бюджет_автостопа: store.budget(),
      бесплатный_лимит_upstash: 500000,
      состояние: store.overBudget(g) ? 'БЮДЖЕТ ИСЧЕРПАН — охоты стоят на паузе' : 'в норме'
    };
    const b = await store.beats().catch(() => ({}));
    out.фоновый_поиск = { ветка_A: ms(b.a && b.a.at), ветка_B: ms(b.b && b.b.at) };
  } catch (e) {
    out.данные = 'НЕ ЧИТАЮТСЯ: ' + e.message;
  }

  if (full && process.env.TELEGRAM_TOKEN) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/getWebhookInfo`);
      const j = await r.json();
      const d = j.result || {};
      out.вебхук = {
        адрес: d.url || 'НЕ УСТАНОВЛЕН — бот не получает сообщения',
        необработанных: d.pending_update_count,
        последняя_ошибка: d.last_error_message || 'нет',
        когда: d.last_error_date ? new Date(d.last_error_date * 1000).toISOString() : '—'
      };
    } catch (e) { out.вебхук = 'не проверить: ' + e.message; }
  } else if (!full) {
    out.подсказка = 'Добавьте ?key=ВАШ_TICK_KEY — покажу состояние вебхука Telegram и последнюю ошибку доставки.';
  }

  return res.status(200).json(out);
};
