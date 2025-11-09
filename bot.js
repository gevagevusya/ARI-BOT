// index.js — ARI Telegram Bot (QR 3500 ₽ + Cal.com redirect confirm_* + /id + admin channel)
// ENV: BOT_TOKEN, ADMIN_ID (opt), ADMIN_CHANNEL (opt), PAYMENT_QR_URL, CAL_BOOKING_URL, MEETING_URL
// Node >= 20; deps: telegraf, express

import express from 'express';
import { Telegraf, Markup, Scenes, session } from 'telegraf';

// ===== ENV =====
const BOT_TOKEN       = process.env.BOT_TOKEN;
const ADMIN_ID        = process.env.ADMIN_ID ? Number(process.env.ADMIN_ID) : undefined;
const ADMIN_CHANNEL   = process.env.ADMIN_CHANNEL ? Number(process.env.ADMIN_CHANNEL) : undefined;
const PAYMENT_QR_URL  = process.env.PAYMENT_QR_URL || '';
const CAL_BOOKING_URL = process.env.CAL_BOOKING_URL || '';
const MEETING_URL     = process.env.MEETING_URL || 'https://telemost.yandex.ru/'; // можно заменить в ENV
const PRICE_RUB       = 3500;

if (!BOT_TOKEN) { console.error('❌ Missing BOT_TOKEN'); process.exit(1); }

const bot = new Telegraf(BOT_TOKEN);

// ===== утилита: куда слать админу =====
function getAdminTargets() {
  const ids = [];
  if (Number.isFinite(ADMIN_ID)) ids.push(ADMIN_ID);
  if (Number.isFinite(ADMIN_CHANNEL)) ids.push(ADMIN_CHANNEL);
  return ids;
}
async function sendToAdmins(telegram, payload, photos = []) {
  const targets = getAdminTargets();
  for (const chatId of targets) {
    try {
      await telegram.sendMessage(chatId, payload, { disable_web_page_preview: true });
      for (const f of photos) {
        await telegram.sendPhoto(chatId, f).catch(()=>{});
      }
    } catch (e) {
      console.warn('admin send warn:', e.message);
    }
  }
}

// ===== Юридика (кратко) =====
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

// ru-формат даты: «12 ноября 14:00 (Europe/Moscow)»
function formatRuDate(date, tz = 'Europe/Moscow') {
  try {
    const d = new Date(date);
    const fmt = new Intl.DateTimeFormat('ru-RU', {
      timeZone: tz,
      day: '2-digit', month: 'long', hour: '2-digit', minute: '2-digit'
    });
    return fmt.format(d);
  } catch { return null; }
}

// Парсим payload из /start confirm_...
// Поддерживаем несколько форматов:
// 1) confirm_2025-11-12T14:00:00+03:00
// 2) confirm_20251112_1400
// 3) confirm-epoch-1699780800000
function parseConfirmPayload(p) {
  if (!p) return null;
  if (!/^confirm[_-]/i.test(p)) return null;

  const rest = decodeURIComponent(p.replace(/^confirm[_-]/i, '')).trim();

  // epoch миллисекундами
  if (/^epoch[-_]\d{10,}$/.test(rest)) {
    const ms = Number(rest.replace(/^epoch[-_]/, ''));
    if (Number.isFinite(ms)) return { iso: new Date(ms).toISOString(), tz: 'Europe/Moscow' };
  }

  // ISO
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(rest)) {
    return { iso: rest, tz: 'Europe/Moscow' };
  }

  // YYYYMMDD_HHmm
  const m = rest.match(/^(\d{4})(\d{2})(\d{2})[_-]?(\d{2})(\d{2})$/);
  if (m) {
    const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00`;
    return { iso, tz: 'Europe/Moscow' };
  }

  return null;
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
        'После брони Cal.com вернёт вас в бота. Если этого не произошло — нажмите:',
        Markup.inlineKeyboard([[Markup.button.callback('Я забронировал(а)', 'booked_yes')]])
      );
    } else {
      await ctx.reply('Оплата подтверждена ✅. Напишите удобные дни/время — подберу ближайшее окно.');
    }

    await sendToAdmins(ctx.telegram, summarize(ctx), (ctx.session.ari.photos || []));
    await ctx.reply('Спасибо! После выбора времени пришлю подтверждение.');
    return ctx.scene.leave();
  }
);

// ===== Сцены и middleware =====
const { WizardScene: _W, Stage } = Scenes;
const stage = new Stage([wizard]);
bot.use(session());
bot.use(stage.middleware());

// ===== Команды =====

// /start с deep-link параметром (например, /start confirm_2025-11-12T14:00:00+03:00)
bot.start(async (ctx) => {
  const payload = (ctx.startPayload || '').trim();

  // 1) Авто-подтверждение с датой: /start confirm_...
  if (/^confirm[_-]/i.test(payload)) {
    const parsed = parseConfirmPayload(payload);
    if (parsed?.iso) {
      const human = formatRuDate(parsed.iso) || parsed.iso;
      await ctx.reply(
        'Запись получена ✅\n' +
        `📅 Время консультации: *${human}*\n` +
        `🔗 Ссылка на телемост: [Перейти](${MEETING_URL})\n\n` +
        'Пожалуйста, подключитесь за 5 минут до начала.',
        { parse_mode: 'Markdown', disable_web_page_preview: true }
      );

      const d = ctx.session?.ari || {};
      const card =
        `📥 Автоподтверждение (deep-link)\n` +
        `Пациент: @${ctx.from?.username || '—'} (id ${ctx.from?.id})\n` +
        `Время: ${human}\n` +
        `Жалобы: ${prettify(d.complaints)}\n` +
        `Анамнез заболевания: ${prettify(d.hxDisease)}\n` +
        (d.photos?.length ? `Фото: ${d.photos.length} шт.\n` : '');
      await sendToAdmins(ctx.telegram, card, (d.photos || []));
      return;
    }

    // Если Cal не подставил время — мягкий fallback
    await ctx.reply('Запись получена ✅. Я пришлю точное время и ссылку на телемост в ближайшее время.');
    const d = ctx.session?.ari || {};
    await sendToAdmins(
      ctx.telegram,
      `📥 Подтверждение без времени (нет переменных в redirect)\n` +
      `Пациент: @${ctx.from?.username || '—'} (id ${ctx.from?.id})\n` +
      `Жалобы: ${prettify(d.complaints)}\n` +
      `Анамнез заболевания: ${prettify(d.hxDisease)}`,
      (d.photos || [])
    );
    return;
  }

  // 2) Старый сценарий «просто бронировал» (без времени)
  if (payload.toLowerCase() === 'booked') {
    await ctx.reply('Запись получена ✅\nСпасибо! Я пришлю ссылку на телемост и уточню детали перед консультацией.');
    const d = ctx.session?.ari || {};
    const card =
      `📥 Подтверждение через deep-link (без времени)\n` +
      `Пациент: @${ctx.from?.username || '—'} (id ${ctx.from?.id})\n` +
      `Жалобы: ${prettify(d.complaints)}\n` +
      `Анамнез заболевания: ${prettify(d.hxDisease)}\n` +
      (d.photos?.length ? `Фото: ${d.photos.length} шт.\n` : '');
    await sendToAdmins(ctx.telegram, card, (d.photos || []));
    return;
  }

  // Обычный запуск анкеты
  await ctx.scene.enter('ari');
});

bot.command('terms', async (ctx) => ctx.reply(TERMS_TEXT));
bot.command('privacy', async (ctx) => ctx.reply(PRIVACY_TEXT));
bot.command('id', async (ctx) => {
  await ctx.reply(`Ваш Telegram ID: \`${ctx.from.id}\``, { parse_mode: 'Markdown' });
});

// Fallback: «Я забронировал(а)»
bot.action('booked_yes', async (ctx) => {
  await ctx.answerCbQuery('Спасибо!');
  await ctx.reply('Запись отмечена ✅. Я пришлю ссылку на телемост и уточню детали перед консультацией.');
  const d = ctx.session?.ari || {};
  const note =
    `📥 Ручное подтверждение брони\n` +
    `Пациент: @${ctx.from.username || '—'} (id ${ctx.from.id})`;
  await sendToAdmins(ctx.telegram, note, (d.photos || []));
});

// ===== Express / health-check =====
const app = express();
app.get('/', (_req, res) => res.send('ARI bot is running'));

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
