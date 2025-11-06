
import express from 'express';
import { Telegraf, Markup } from 'telegraf';

// ====== ENV ======
const BOT_TOKEN      = process.env.BOT_TOKEN;        // токен бота из @BotFather
const ADMIN_ID_RAW   = process.env.ADMIN_ID;         // твой Telegram ID
const ADMIN_ID       = ADMIN_ID_RAW ? Number(ADMIN_ID_RAW) : undefined;
const SITE_URL       = process.env.SITE_URL || 'https://independent-intuition-production.up.railway.app/';
const PAYMENT_QR_URL = process.env.PAYMENT_QR_URL || ''; // прямая ссылка на картинку с QR (можно пусто)

if (!BOT_TOKEN) {
  console.error('❌ Missing BOT_TOKEN env');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// ====== Хелперы ======
function prettyCard(d = {}) {
  return [
    '📨 Новая заявка ARI',
    `ФИО: ${d.fio || '—'}`,
    `Дата рождения: ${d.dob || '—'}`,
    `Email: ${d.email || '—'}`,
    `Жалобы: ${d.complaints || '—'}`,
    `Анамнез заболевания: ${d.hx_disease || '—'}`,
    `Анамнез жизни: ${d.hx_life || '—'}`,
    `Хронические: ${d.chronic || '—'}`,
    `Лекарства: ${d.meds || '—'}`,
    `Аллергии: ${d.allergy || '—'}`,
    `Ранее лечение: ${d.prev_tx || '—'}`
  ].join('\n');
}

function makeSlots() {
  const today = new Date();
  const slot = (offsetDays, h, m) => {
    const d = new Date(today);
    d.setDate(today.getDate() + offsetDays);
    d.setHours(h, m, 0, 0);
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return { label: `${dd}.${mm} ${hh}:${mi}`, data: `slot_${d.getTime()}` };
  };
  return [
    slot(0, 18, 30),
    slot(1, 12, 0),
    slot(1, 19, 0),
    slot(2, 11, 30),
    slot(2, 16, 0),
  ];
}

// ====== Команды ======
bot.start(async (ctx) => {
  await ctx.reply(
    'Привет! Это ARI — онлайн-консультации дерматолога.\n\n' +
    '1) Нажмите кнопку ниже и заполните короткую анкету\n' +
    '2) Прикрепите фото высыпаний здесь, в чате\n' +
    '3) Оплатите по QR и подтвердите оплату\n' +
    '4) Я предложу время консультации',
    Markup.inlineKeyboard([
      [Markup.button.webApp('Открыть анкету', SITE_URL)]
    ])
  );
});

bot.command('id', async (ctx) => {
  await ctx.reply(`Ваш Telegram ID: \`${ctx.from.id}\``, { parse_mode: 'Markdown' });
});

// ====== Лог на всякий случай (видеть web_app_data в логах) ======
bot.on('message', (ctx, next) => {
  if (ctx.message?.web_app_data) {
    console.log('✅ got web_app_data from', ctx.from?.id);
  }
  return next();
});

// ====== ПРАВИЛЬНЫЙ обработчик WebApp-данных ======
// Используем универсальный on('message') и проверяем web_app_data,
// так как on('web_app_data') в Telegraf не срабатывает.
bot.on('message', async (ctx) => {
  if (!ctx.message?.web_app_data) return;

  try {
    const raw = ctx.message.web_app_data.data;
    const payload = JSON.parse(raw || '{}');

    if (payload?.type !== 'ari_request') {
      return ctx.reply('Получен неизвестный формат данных.');
    }

    const d = payload.data || {};

    // Сообщение пациенту
    await ctx.reply(
      'Спасибо! Заявка получена ✅\n' +
      'Пожалуйста, прикрепите сюда 3–5 фото высыпаний (хорошее освещение, фокус, общий план + крупный план).'
    );

    // Уведомление врачу
    if (ADMIN_ID) {
      await ctx.telegram.sendMessage(
        ADMIN_ID,
        `👤 От: @${ctx.from.username || '—'} (id ${ctx.from.id})\n${prettyCard(d)}`
      );
    }

    // QR или кнопка «Я оплатил(а)»
    if (PAYMENT_QR_URL) {
      await ctx.replyWithPhoto(PAYMENT_QR_URL, {
        caption: 'Оплата консультации: отсканируйте QR код. После оплаты нажмите кнопку ниже.',
        reply_markup: {
          inline_keyboard: [[{ text: 'Я оплатил(а)', callback_data: 'paid_yes' }]]
        }
      });
    } else {
      await ctx.reply(
        'Ссылка/QR для оплаты будет подключена. После оплаты нажмите «Я оплатил(а)».',
        { reply_markup: { inline_keyboard: [[{ text: 'Я оплатил(а)', callback_data: 'paid_yes' }]] } }
      );
    }

  } catch (e) {
    console.error('[web_app_data] parse error', e);
    await ctx.reply('Произошла ошибка при обработке заявки. Напишите, пожалуйста, данные вручную.');
  }
});

// ====== Приём фото ======
bot.on('photo', async (ctx) => {
  await ctx.reply('Фото получено ✅ Пришлите ещё 2–4 фото при необходимости, затем нажмите «Я оплатил(а)».');

  if (ADMIN_ID) {
    try {
      const largest = ctx.message.photo[ctx.message.photo.length - 1];
      await ctx.telegram.sendPhoto(ADMIN_ID, largest.file_id, {
        caption: `📷 Фото от @${ctx.from.username || '—'} (id ${ctx.from.id})`
      });
    } catch (e) {
      console.error('Forward photo error:', e);
    }
  }
});

// ====== Подтверждение оплаты → выбор слотов ======
bot.action('paid_yes', async (ctx) => {
  await ctx.answerCbQuery();

  // Попробуем обновить подпись к фото с QR (если была)
  await ctx.editMessageCaption?.({
    caption: 'Оплата подтверждена ✅',
    reply_markup: { inline_keyboard: [] }
  }).catch(() => { /* если не фото — игнорируем */ });

  const slots = makeSlots();
  await ctx.reply(
    'Спасибо! Выберите удобное время (предварительно):',
    {
      reply_markup: {
        inline_keyboard: [
          ...slots.map(s => [{ text: s.label, callback_data: s.data }]),
          [{ text: 'Другое время', callback_data: 'slot_other' }]
        ]
      }
    }
  );

  if (ADMIN_ID) {
    await ctx.telegram.sendMessage(ADMIN_ID, `💳 @${ctx.from.username || '—'} подтвердил(а) оплату. ID: ${ctx.from.id}`);
  }
});

bot.action(/slot_\d+/, async (ctx) => {
  await ctx.answerCbQuery();
  const when = new Date(Number(ctx.match[0].split('_')[1]));
  const dd = String(when.getDate()).padStart(2, '0');
  const mm = String(when.getMonth() + 1).padStart(2, '0');
  const hh = String(when.getHours()).padStart(2, '0');
  const mi = String(when.getMinutes()).padStart(2, '0');

  await ctx.editMessageText(`Предварительно выбрано: ${dd}.${mm} ${hh}:${mi}. Я свяжусь с вами для подтверждения.`);

  if (ADMIN_ID) {
    await ctx.telegram.sendMessage(ADMIN_ID, `🗓 Пациент @${ctx.from.username || '—'} выбрал слот ${dd}.${mm} ${hh}:${mi}`);
  }
});

bot.action('slot_other', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText('Напишите, пожалуйста, удобные для вас дни и время — я подберу ближайшее доступное окно.');
  if (ADMIN_ID) {
    await ctx.telegram.sendMessage(ADMIN_ID, `🗓 Пациент @${ctx.from.username || '—'} попросил другое время.`);
  }
});

// ====== Запуск бота (long polling) ======
bot.launch();
console.log('✅ ARI bot started');

// Graceful shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

// ====== Мини-Express сервер для health-check на Railway ======
const app = express();
app.get('/', (_req, res) => res.send('ARI bot is running'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Health server on', PORT));
