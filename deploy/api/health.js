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
      APP_PASSWORD: process.env.APP_PASSWORD ? 'задан — им всегда можно войти' : 'НЕ ЗАДАН',
      ADMIN_USERNAME: (process.env.ADMIN_USERNAME || 'gaucho_bro (по умолчанию)'),
      ADMIN_UID: Number(process.env.ADMIN_UID || 0) || 'не задан',
      APP_URL: (process.env.APP_URL || '').trim() || 'НЕ ЗАДАН'
    },
    сервер: (() => {
      const st = global.__chStats;
      if (!st) return 'нет данных (запущено не через server.js)';
      const up = Math.round((Date.now() - st.bootAt) / 1000);
      const ago = t => t ? Math.round((Date.now() - t) / 1000) + ' с назад' : 'не было';
      return {
        работает_без_перезапуска: up >= 3600 ? Math.floor(up / 3600) + ' ч ' + Math.floor(up % 3600 / 60) + ' мин' : Math.floor(up / 60) + ' мин ' + (up % 60) + ' с',
        запущен: new Date(st.bootAt).toISOString(),
        пингер_cron_job_org: { последний_запрос: ago(st.extTick.last), запросов_с_запуска: st.extTick.count, самый_долгий_перерыв_с: st.extTick.maxGapS },
        самопинг: { последний: ago(st.selfPing.last), удачных: st.selfPing.ok, неудачных: st.selfPing.fail, ошибка: st.selfPing.lastErr || undefined }
      };
    })(),
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
      пароль_по_умолчанию: g.password === 'admin' ? 'ДА — состояние сброшено' : 'нет',
      длина_пароля_в_базе: String(g.password || '').length,
      пароль_в_базе_совпадает_с_APP_PASSWORD:
        !process.env.APP_PASSWORD ? 'APP_PASSWORD не задан'
        : (String(g.password || '').trim() === String(process.env.APP_PASSWORD).trim() ? 'да' : 'НЕТ — в базе другой пароль, но APP_PASSWORD всё равно подойдёт')
    };

    // Аварийная смена пароля: /api/health?key=TICK_KEY&setpass=НовыйПароль
    const sp = String((req.query || {}).setpass || '');
    if (full && sp) {
      if (sp.length < 6) out.смена_пароля = 'от 6 символов';
      else {
        g.password = sp;
        store.log(g, 'Пароль сменён аварийно через /api/health');
        await store.saveGlobal(g);
        out.смена_пароля = 'готово — новый пароль установлен';
        out.данные.длина_пароля_в_базе = sp.length;
      }
    }
    // Аварийный сброс счётчика: /api/health?key=TICK_KEY&resetcmd=1
    // Нужен, когда реальный расход в Upstash ниже нашей оценки (например, вы завели новую базу),
    // а бот всё ещё держит охоты на паузе.
    if (full && /^(1|true|yes|да)$/i.test(String((req.query || {}).resetcmd || ''))) {
      const было = store.used(g);
      store.resetCmd(g);
      store.log(g, `Счётчик обращений к базе сброшен вручную (было ${было})`);
      await store.saveGlobal(g);
      out.сброс_счётчика = `готово — было ${было}, стало 0. Охоты можно запускать снова.`;
    }
    // Выставить счётчик по цифре из панели Upstash: /api/health?key=TICK_KEY&setcmd=411000
    const sc = String((req.query || {}).setcmd || '').replace(/\D/g, '');
    if (full && sc) {
      const было = store.used(g);
      store.setCmd(g, Number(sc));
      store.log(g, `Счётчик обращений к базе выставлен вручную: ${sc} (было ${было})`);
      await store.saveGlobal(g);
      out.счётчик_выставлен = `готово — было ${было}, стало ${sc}. Если охоты стояли на паузе из-за лимита, запустите их снова.`;
    }
    const u_ = store.used(g), b_ = store.budget();
    out.команды_к_базе = {
      за_этот_месяц_оценка: u_,
      бюджет_автостопа: b_ || 'проверка выключена (CMD_BUDGET=0)',
      израсходовано: b_ ? Math.round(u_ / b_ * 100) + '%' : '—',
      бесплатный_лимит_upstash: 500000,
      состояние: store.overBudget(g) ? 'БЮДЖЕТ ИСЧЕРПАН — охоты стоят на паузе' : 'в норме',
      сброс: 'добавьте &resetcmd=1 к этому адресу (нужен ключ); выставить по панели Upstash: &setcmd=ЦИФРА',
      режим: store.LOCAL ? 'память процесса: в базу пишем только изменения' : 'каждый вызов читает базу'
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
    out.подсказка = 'Добавьте ?key=ВАШ_TICK_KEY — покажу состояние вебхука Telegram. Сменить пароль: ?key=ВАШ_TICK_KEY&setpass=НовыйПароль · Сбросить счётчик базы: ?key=ВАШ_TICK_KEY&resetcmd=1';
  }

  return res.status(200).json(out);
};
