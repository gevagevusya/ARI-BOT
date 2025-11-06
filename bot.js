import express from 'express';
import { Telegraf, Markup } from 'telegraf';

// ====== ENV ======
const BOT_TOKEN      = process.env.BOT_TOKEN;        // токен @BotFather
const ADMIN_ID       = Number(process.env.ADMIN_ID); // твой Telegram ID (получишь через /id)
const SITE_URL       = process.env.SITE_URL || 'https://independent-intuition-production.up.railway.app/';
const PAYMENT_QR_URL = process.env.PAYMENT_QR_URL || ''; // прямая ссылка на картинку твоего QR

if (!BOT_TOKEN) {
  console.error('Missing BOT_TOKEN env');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// ====== Команды ======
bot.start(async (ctx) => {
  await ctx.reply(
    'Привет! Это ARI — онлайн-консультации дерматолога.\n\n' +
    '1) Нажмите кнопку ниже, заполните короткую анкету\n' +
    '2) Прикрепите фото высыпаний здесь в чате\n' +
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

// ====== Обработка WebApp данных (после sendData(JSON) со страницы) ======
bot.on('web_app_data', async (ctx) => {
  try {
    const raw = ctx.message.web_app_data?.data;
    const payload = JSON.parse(raw || '{}');

    if (payload?.type !== 'ari_request') {
      return ctx.reply('Получен неизвестный формат данных.');
    }

    const d = payload.data || {};
    const pretty = [
      `📨 Новая заявка ARI`,
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

    // Сообщение пациенту
    await ctx.reply(
      'Спасибо! Заявка получена ✅\n' +
      'Пожалуйста, прикрепите сюда 3–5 фото высыпаний (хорошее освещение, фокус, общий план + крупный план).'
    );

    // Форвард тебе (врачу)
    if (ADMIN_ID) {
      await ctx.telegram.sendMessage(ADMIN_ID, `👤 От: @${ctx.from.username || '—'} (id ${ctx.from.id})\n${pretty}`);
    }

    // Кнопка "Оплатить" / "QR"
    if (PAYMENT_QR_URL) {
      await ctx.replyWithPhoto(PAYMENT_QR_URL, {
        caption: 'Оплата консультации: отсканируйте QR код. После оплаты нажмите кнопку ниже.',
        reply_markup: {
          inline_keyboard: [[{ text: 'Я оплатил(а)', callback_data: 'paid_yes' }]]
        }
      });
    } else {
      await ctx.reply(
        'Ссылка/QR для оплаты пока не подключены. После оплаты нажмите «Я оплатил(а)».',
        Markup.inlineKeyboard([[Markup.button.callback('Я оплатил(а)', 'paid_yes')]])
      );
    }
  } catch (e) {
    console.error(e);
    await ctx.reply('Произошла ошибка при обработке заявки. Напишите, пожалуйста, в этот чат ваши данные вручную.');
  }
});

// ====== Приём фото ======
bot.on('photo', async (ctx) => {
  // Просто подтверждаем получение. Файлы можно будет скачивать по FileID,
  // но без БД сейчас сохраняем только факт/уведомление.
  await ctx.reply('Фото получено ✅ Пришлите ещё 2–4 фото при необходимости, затем нажмите «Я оплатил(а)».');

  // Уведомим врача
  if (ADMIN_ID) {
    const largest = ctx.message.photo[ctx.message.photo.length - 1];
    await ctx.telegram.sendPhoto(ADMIN_ID, largest.file_id, { caption: `📷 Фото от @${ctx.from.username || '—'} (id ${ctx.from.id})` });
  }
});

// ====== Подтверждение оплаты ======
bot.action('paid_yes', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageCaption?.({
    caption: 'Оплата подтверждена ✅',
    reply_markup: { inline_keyboard: [] }
  }).catch(() => {}); // если сообщение без фото — просто игнорируем

  // Предлагаем слоты (заготовка — можно заменить на свою логику)
  const today = new Date();
  const slot = (offsetDays, h, m) => {
    const d = new Date(today);
    d.setDate(today.getDate() + offsetDays);
    d.setHours(h, m, 0, 0);
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth()+1).padStart(2, '0');
    const hh = String(h).padStart(2, '0');
    const mi = String(m).padStart(2, '0');
    return { label: `${dd}.${mm} ${hh}:${mi}`, data: `slot_${d.getTime()}` };
  };

  const slots = [
    slot(0, 18, 30), slot(1, 12, 0), slot(1, 19, 0),
    slot(2, 11, 30), slot(2, 16, 0)
  ];

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

  // Уведомим врача
  if (ADMIN_ID) {
    await ctx.telegram.sendMessage(ADMIN_ID, `💳 @${ctx.from.username || '—'} подтвердил(а) оплату. ID: ${ctx.from.id}`);
  }
});

bot.action(/slot_\d+/, async (ctx) => {
  await ctx.answerCbQuery();
  const when = new Date(Number(ctx.match[0].split('_')[1]));
  const dd = String(when.getDate()).padStart(2, '0');
  const mm = String(when.getMonth()+1).padStart(2, '0');
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

// ====== Запуск (Polling) ======
// Для Railway проще всего оставить long polling.
// Если захочешь webhook — скажу, что включить в settings.
bot.launch();
console.log('ARI bot started');

// Грейсфул-шатдаун
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

// ====== Пустой express для здоровья на Railway (не обязателен, но полезен)
const app = express();
app.get('/', (_req, res) => res.send('ARI bot is running'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Health server on', PORT));
