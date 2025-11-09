// index.js — ARI Telegram Bot (QR 3500 ₽ + Cal.com webhook + /id + fallback)
// Поток: согласие → жалобы → анамнез заболевания → фото → QR → "Я оплатил(а)" → Cal.com (?tgid=...) → webhook подтверждает
// ENV: BOT_TOKEN, ADMIN_ID, PAYMENT_QR_URL, CAL_BOOKING_URL, PUBLIC_BASE_URL, CAL_WEBHOOK_SECRET (опц.)
// Требования: Node >= 20, зависимости: telegraf, express

import express from 'express';
import crypto from 'crypto';
import { Telegraf, Markup, Scenes, session } from 'telegraf';

// ===== ENV =====
const BOT_TOKEN          = process.env.BOT_TOKEN;
const ADMIN_ID           = process.env.ADMIN_ID ? Number(process.env.ADMIN_ID) : undefined;
const PAYMENT_QR_URL     = process.env.PAYMENT_QR_URL || '';            // URL картинки QR для оплаты
const CAL_BOOKING_URL    = process.env.CAL_BOOKING_URL || '';           // https://cal.com/yourname/event
const PUBLIC_BASE_URL    = process.env.PUBLIC_BASE_URL || '';           // https://<bot>.up.railway.app
const CAL_WEBHOOK_SECRET = process.env.CAL_WEBHOOK_SECRET || '';        // строка для подписи (можно пусто на отладке)
const PRICE_RUB          = 3500;

if (!BOT_TOKEN) { console.error('❌ Missing BOT_TOKEN'); process.exit(1); }

const bot = new Telegraf(BOT_TOKEN);

// ===== Юридический блок =====
const LEGAL_BRIEF =
  '⚖️ Важно:\n' +
  '— Бот не является медицинской консультацией и не ставит диагноз.\n' +
  '— Ответы носят информационный характер и не заменяют очный осмотр.\n' +
  '— Данные не сохраняются вне Telegram. Внешние БД не используются.\n' +
  '— При экстренных состояниях обращайтесь за неотложной медицинской помощью.';

const TERMS_TEXT =
  'Пользовательское соглашение (кратко)\n\n' +
  '1) Бот даёт информационные ответы без постановки диагноза и назначения лечения.\n' +
  '2) Сообщения в боте не являются телемедицинской консультацией.\n' +
  '3) Сведения предоставляются добровольно в рамках Telegram; внешнего хранения нет.\n' +
  '4) Итоговые решения — после очной консультации у врача.\n' +
  '5) При неотложных состояниях — экстренная помощь.\n\n' +
  'Полная версия — по запросу.';

const PRIVACY_TEXT =
  'Политика конфиденциальности (кратко)\n\n' +
  '1) Получаем только то, что вы отправляете в чат.\n' +
  '2) Внешних баз данных нет; переписка хранится по правилам Telegram.\n' +
  '3) Используем сведения для ответа и организации консультации.\n' +
  '4) Передача третьим лицам — только по закону.\n' +
  '5) Не отправляйте избыточные персональные данные.';

// ===== Хелперы =====
function prettify(s){ return (s || '').trim() || '—'; }
function summarize(ctx){
  const d = ctx.session?.ari || {};
  const parts = [
    '📨 Новая заявка ARI',
    `Пациент: @${ctx.from?.username || '—'} (id ${ctx.from?.id})`,
    `Жалобы: ${prettify(d.complaints)}`,
    `Анамнез заболевания: ${prettify(d.hxDisease)}`,
  ];
  if (d.photos?.length) parts.push(`Фото: ${d.photos.length} шт.`);
  if (d.paid) parts.push('Оплата: подтверждена пользователем');
  return parts.join('\n');
}

function extractTgIdFromCalPayload(body){
  const meta = body?.metadata || body?.meta || {};
  if (meta.tgid && /^\d+$/.test(String(meta.tgid))) return Number(meta.tgid);

  const responses = body?.responses || body?.answers || body?.questionsAndAnswers || [];
  for (const r of responses) {
    const label = (r?.label || r?.question || '').toString().toLowerCase();
    const val   = (r?.value || r?.answer || '').toString().trim();
    if ((/telegram\s*id/.test(label) || /tgid|telegram_id/.test(label)) && /^\d+$/.test(val)) {
      return Number(val);
    }
  }

  const attendees = body?.attendees || [];
  for (const a of attendees) {
    const note = (a?.notes || '').toString();
    const m = note.match(/tgid[:=]\s*(\d{4,})/i);
    if (m) return Number(m[1]);
  }

  const urlParams = body?.urlParameters || body?.urlParams || {};
  if (urlParams.tgid && /^\d+$/.test(String(urlParams.tgid))) return Number(urlParams.tgid);

  return undefined;
}

function bookingShortInfo(body){
  try{
    const event = body?.eventType?.slug || body?.eventType || 'event';
    const start = body?.startTime || body?.start?.time || body?.start_time || '';
    const end   = body?.endTime   || body?.end?.time   || body?.end_time   || '';
    const name  = body?.name || body?.attendees?.[0]?.name || '';
    const email = body?.email || body?.attendees?.[0]?.email || '';
    return `🗓 Бронь: ${event}\nИмя: ${name}\nEmail: ${email}\nВремя: ${start} → ${end}`;
  } catch { return '🗓 Новая бронь'; }
}

// ===== Сцены =====
const { WizardScene, Stage } = Scenes;

const wizard = new WizardScene(
  'ari',
  // Шаг 0 — старт и согласие
  async (ctx) => {
    ctx.session.ari = { photos: [], paid: false };
    await ctx.reply(
      'Как это работает:\n' +
      '1) Опишете жалобы и анамнез заболевания\n' +
      '2) Пришлёте 3–5 фото высыпаний\n' +
      `3) Оплатите консультацию по QR (${PRICE_RUB} ₽)\n` +
      '4) Выберете удобное время в календаре\n' +
      '5) Я свяжусь с вами для консультации\n\n' + LEGAL_BRIEF,
      Markup.inlineKeyboard([
        [Markup.button.callback('📄 Пользовательское соглашение', 'terms')],
        [Markup.button.callback('🔒 Политика конфиденциальности', 'privacy')],
        [Markup.button.callback('✅ Согласен(а) и начать', 'agree')],
      ])
    );
    return ctx.wizard.next();
  },

  // Шаг 1 — жалобы
  async (ctx) => {
    if (ctx.updateType === 'callback_query') {
      const cb = ctx.callbackQuery.data;
      await ctx.answerCbQuery();
      if (cb === 'terms')   { await ctx.reply(TERMS_TEXT); return; }
      if (cb === 'privacy') { await ctx.reply(PRIVACY_TEXT); return; }
      if (cb === 'agree') {
        await ctx.reply(
          'Опишите жалобы: что беспокоит, где локализация, когда началось, что усиливает/ослабляет.\n\n' +
          'Пример: «2 недели зудящие пятна на шее и плечах, усиливаются вечером, частично проходят после увлажняющего крема».'
        );
        return ctx.wizard.next();
      }
      return;
    }
    await ctx.reply('Пожалуйста, подтвердите согласие: «✅ Согласен(а) и начать».');
  },

  // Шаг 2 — анамнез заболевания
  async (ctx) => {
    if (!ctx.message?.text) { await ctx.reply('Напишите, пожалуйста, текстом.'); return; }
    ctx.session.ari.complaints = ctx.message.text.trim();
    await ctx.reply('Опишите анамнез заболевания: начало, динамика, что уже пробовали лечить (препараты, дозы, длительность), переносимость.');
    return ctx.wizard.next();
  },

  // Шаг 3 — фото
  async (ctx) => {
    if (!ctx.session.ari.photosInit) {
      ctx.session.ari.photosInit = true;
      await ctx.reply(
        'Пришлите, пожалуйста, 3–5 фото:\n' +
        '• общий план (видна область целиком)\n' +
        '• 2–3 крупных плана (резко, в фокусе)\n' +
        '• хорошее освещение, без фильтров',
        Markup.inlineKeyboard([[Markup.button.callback('📦 Фото отправлены', 'photos_done')]])
      );
      return;
    }

    if (ctx.message?.photo?.length) {
      const largest = ctx.message.photo.at(-1);
      ctx.session.ari.photos.push(largest.file_id);
      await ctx.reply(`Фото получено ✅ (${ctx.session.ari.photos.length})`);
      return;
    }

    if (ctx.updateType === 'callback_query' && ctx.callbackQuery.data === 'photos_done') {
      await ctx.answerCbQuery();
      if (PAYMENT_QR_URL) {
        await ctx.replyWithPhoto(PAYMENT_QR_URL, {
          caption: `Оплата консультации: ${PRICE_RUB} ₽.\nОтсканируйте QR, оплатите и нажмите кнопку ниже.`,
          reply_markup: { inline_keyboard: [[{ text: 'Я оплатил(а)', callback_data: 'paid_yes' }]] }
        });
      } else {
        await ctx.reply(
          `Сумма консультации: ${PRICE_RUB} ₽.\nQR не подключён. После оплаты нажмите «Я оплатил(а)».`,
          Markup.inlineKeyboard([[Markup.button.callback('Я оплатил(а)', 'paid_yes')]])
        );
      }
      return ctx.wizard.next();
    }

    await ctx.reply('Пришлите фото или нажмите «Фото отправлены».');
  },

  // Шаг 4 — подтверждение оплаты → Cal.com + fallback
  async (ctx) => {
    if (!(ctx.updateType === 'callback_query' && ctx.callbackQuery.data === 'paid_yes')) {
      await ctx.reply('После оплаты нажмите кнопку «Я оплатил(а)».'); return;
    }
    await ctx.answerCbQuery('Спасибо!');
    ctx.session.ari.paid = true;

    const chatId = ctx.chat?.id || ctx.from?.id;
    const url = CAL_BOOKING_URL
      ? (CAL_BOOKING_URL + (CAL_BOOKING_URL.includes('?') ? '&' : '?') + `tgid=${encodeURIComponent(chatId)}`)
      : '';

    if (url) {
      await ctx.reply(
        'Оплата подтверждена ✅\nВыберите удобное время (живая ссылка с актуальными слотами):',
        Markup.inlineKeyboard([[ Markup.button.url('📅 Выбрать время', url) ]])
      );
      await ctx.reply(
        'Когда завершите запись в календаре, вернитесь сюда и нажмите кнопку ниже:',
        Markup.inlineKeyboard([[Markup.button.callback('Я забронировал(а)', 'booked_yes')]])
      );
    } else {
      await ctx.reply('Оплата подтверждена ✅. Напишите удобные дни/время — подберу ближайшее окно.');
    }

    if (ADMIN_ID) {
      await ctx.telegram.sendMessage(ADMIN_ID, summarize(ctx));
      const d = ctx.session.ari;
      if (d.photos?.length) {
        for (const file_id of d.photos) {
          await ctx.telegram.sendPhoto(ADMIN_ID, file_id).catch(()=>{});
        }
      }
    }

    await ctx.reply('Спасибо! После выбора времени пришлю подтверждение.');
    return ctx.scene.leave();
  }
);

// ===== Сцены и middleware =====
const stage = new Stage([wizard]);
bot.use(session());
bot.use(stage.middleware());

// ===== Команды =====
bot.start(async (ctx) => { await ctx.scene.enter('ari'); });
bot.command('terms', async (ctx) => ctx.reply(TERMS_TEXT));
bot.command('privacy', async (ctx) => ctx.reply(PRIVACY_TEXT));
bot.command('id', async (ctx) => {
  await ctx.reply(`Ваш Telegram ID: \`${ctx.from.id}\``, { parse_mode: 'Markdown' });
});

// Fallback на случай, если вебхук Cal.com не дошёл
bot.action('booked_yes', async (ctx) => {
  await ctx.answerCbQuery('Спасибо!');
  await ctx.reply('Запись отмечена ✅. Я пришлю ссылку на телемост и уточню детали перед консультацией.');
  if (ADMIN_ID) {
    try {
      await ctx.telegram.sendMessage(
        ADMIN_ID,
        `Пациент @${ctx.from.username || '—'} (id ${ctx.from.id}) отметил, что бронь выполнена.`
      );
      const d = ctx.session?.ari || {};
      if (d?.photos?.length) {
        for (const file_id of d.photos) {
          await ctx.telegram.sendPhoto(ADMIN_ID, file_id).catch(()=>{});
        }
      }
    } catch {}
  }
});

// ===== Express / health-check =====
const app = express();
app.get('/', (_req, res) => res.send('ARI bot is running'));

// Пинг-страница для Cal.com
app.get('/cal/webhook', (_req, res) => res.status(200).send('Cal webhook endpoint is alive'));

// Основной вебхук Cal.com — принимаем ЛЮБОЙ content-type, отвечаем мгновенно
app.post('/cal/webhook', express.raw({ type: () => true, limit: '2mb' }), async (req, res) => {
  try {
    const buf = req.body || Buffer.from('{}');
    const textBody = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf || '{}');

    // Если Cal.com шлёт пустой ping — просто 200
    if (!textBody || textBody.trim() === '') return res.status(200).send('OK');

    // Проверка подписи (можно оставить пустым CAL_WEBHOOK_SECRET на отладке)
    if (CAL_WEBHOOK_SECRET) {
      const sigHeader =
        req.header('x-cal-signature') ||
        req.header('x-cal-signature-256') ||
        req.header('x-webhook-signature') ||
        req.header('cal-signature') || '';
      const expected = crypto.createHmac('sha256', CAL_WEBHOOK_SECRET).update(textBody).digest('hex');
      const presented = sigHeader.replace(/^sha256=/,'').trim();
      if (!presented || presented !== expected) {
        console.warn('⚠️ Cal webhook bad signature');
        return res.status(400).send('bad signature');
      }
    } else {
      console.warn('⚠️ CAL_WEBHOOK_SECRET empty — signature check disabled (debug)');
    }

    let data; try { data = JSON.parse(textBody); } catch { data = {}; }

    // Сразу отвечаем 200, чтобы не было 502 из-за таймаута
    res.status(200).send('OK');

    const event = (data?.triggerEvent || data?.event || '').toString().toUpperCase();
    if (!event || !/BOOKING|SCHEDULED|CREATED|CONFIRMED/.test(event)) return;

    let tgId = extractTgIdFromCalPayload(data);
    // Доп. попытка: часто кладут id в questionsAndAnswers
    if (!tgId) {
      const q = data?.questionsAndAnswers || [];
      for (const qa of q) {
        const lbl = String(qa?.question || qa?.label || '').toLowerCase();
        const val = String(qa?.answer || qa?.value || '').trim();
        if ((/telegram\s*id|tgid|telegram_id/.test(lbl)) && /^\d+$/.test(val)) { tgId = Number(val); break; }
      }
    }

    const short = bookingShortInfo(data);

    if (ADMIN_ID) {
      await bot.telegram.sendMessage(ADMIN_ID, `📥 Cal.com webhook\n${short}\nTGID: ${tgId || 'не найден'}`).catch(()=>{});
    }

    if (tgId) {
      await bot.telegram.sendMessage(
        tgId,
        'Запись получена ✅\nСпасибо! Я пришлю ссылку на телемост и уточню детали перед консультацией.'
      ).catch((e)=>console.error('send to patient failed:', e.message));
    }
  } catch (e) {
    console.error('Cal webhook error:', e);
    if (!res.headersSent) res.status(500).send('error');
  }
});

// ===== Запуск =====
const PORT = process.env.PORT || 3000;
(async () => {
  try {
    await bot.telegram.deleteWebhook({ drop_pending_updates: false });
    console.log('🔧 TG webhook deleted (switch to polling)');
  } catch (e) {
    console.warn('TG webhook delete warn:', e.message);
  }
  await bot.launch();
  console.log('✅ ARI bot started');
  app.listen(PORT, () => console.log('Health server on', PORT));
})();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

