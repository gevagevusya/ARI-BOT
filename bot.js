import 'dotenv/config';
import { Telegraf, Markup } from 'telegraf';

/** ===== ARI CONFIG ===== **/
const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBAPP_URL = process.env.WEBAPP_URL;        // публичный URL сайта ARI с Railway
const ADMIN_CHAT_ID = Number(process.env.ADMIN_CHAT_ID); // твой Telegram numeric id

if (!BOT_TOKEN) throw new Error('BOT_TOKEN is required');
if (!WEBAPP_URL) throw new Error('WEBAPP_URL is required');

const bot = new Telegraf(BOT_TOKEN);

/** ===== In-memory ===== **/
const photoPromptByChat = new Map();   // chatId -> messageId «попросить фото»
const dateState = new Map();           // chatId -> { step, date, time }

/** ===== Utils ===== **/
const cut = (t='', n=220) => t ? (t.length>n ? t.slice(0,n)+'…' : t) : '—';
const userDeepLink = (u) => u?.username ? `https://t.me/${u.username}` : `tg://user?id=${u?.id}`;

function slotDays(n=5){
  const base = new Date(); const arr=[];
  for(let i=0;i<n;i++){ const d=new Date(base); d.setDate(base.getDate()+i); arr.push(d); }
  return arr;
}
const dayLabel = (d) => d.toLocaleDateString('ru-RU',{weekday:'short', day:'2-digit', month:'2-digit'});

function buildDayKeyboard(){
  const days = slotDays(5);
  const row = days.map(d => Markup.button.callback(dayLabel(d), `pick_day:${d.toISOString().slice(0,10)}`));
  return Markup.inlineKeyboard([row, [Markup.button.callback('Отмена','pick_cancel')]]);
}
function buildTimeKeyboard(iso){
  const times = ['10:00','12:00','15:00','18:00'];
  const row = times.map(t => Markup.button.callback(t, `pick_time:${iso}:${t}`));
  return Markup.inlineKeyboard([row, [Markup.button.callback('Назад','pick_back'), Markup.button.callback('Отмена','pick_cancel')]]);
}

/** ===== Команды ===== **/
bot.start((ctx) => ctx.reply(
  'Онлайн-заявка ARI',
  Markup.inlineKeyboard([[Markup.button.webApp('Открыть форму', WEBAPP_URL)]])
));
bot.command('consult', (ctx) => ctx.reply(
  'Открыть форму',
  Markup.inlineKeyboard([[Markup.button.webApp('Онлайн-заявка ARI', WEBAPP_URL)]])
));
bot.command('help', (ctx) => ctx.reply(
  'Команды:\n/consult — открыть форму\n/help — помощь\n/price — стоимость/условия'
));
bot.command('price', (ctx) => ctx.reply(
  'Стоимость первичной онлайн-оценки: ₽ (QR в форме).\nНе заменяет очный приём; при «красных флагах» — очно.'
));

/** ===== Данные из WebApp ===== **/
bot.on('web_app_data', async (ctx) => {
  try {
    const payload = JSON.parse(ctx.webAppData.data); // { type, version, data }
    const d = payload?.data || {};
    const user = ctx.from;

    // Пациенту: подтверждение + просьба приложить фото + «Выбрать дату»
    const m = await ctx.reply(
      '✅ Заявка получена.\n' +
      '💳 Оплата: подтверждена\n' +
      '📎 Прикрепите, пожалуйста, 2–5 фото ответом на это сообщение ' +
      '(общий план + крупный план при дневном рассеянном свете).',
      { reply_markup: { inline_keyboard: [[{ text:'Выбрать дату', callback_data:'pick_date' }]] } }
    );
    photoPromptByChat.set(ctx.chat.id, m.message_id);

    // Врачу (тебе) — карточка
    if (ADMIN_CHAT_ID) {
      await ctx.telegram.sendMessage(
        ADMIN_CHAT_ID,
        '🆕 Новая заявка (ARI)\n' +
        `• Пациент: ${d.fio || '—'}\n` +
        `• ДР: ${d.dob || '—'}\n` +
        `• Жалобы: ${cut(d.complaints)}\n` +
        `• Оплата: ✅\n` +
        `• Фото: ожидаются\n\n` +
        `userId: ${user.id} (@${user.username || '—'})`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text:'Открыть диалог', url: userDeepLink(user) }],
              [{ text:'Попросить фото', callback_data:`nudge_photo:${ctx.chat.id}` }],
              [{ text:'Выбрать дату', callback_data:`admin_pick_date:${ctx.chat.id}` }]
            ]
          }
        }
      );
    }
  } catch (e) {
    console.error('web_app_data error', e);
    await ctx.reply('⚠️ Не удалось обработать данные. Попробуйте ещё раз.');
  }
});

/** ===== Фото: принимаем как ответ на «приглашатель фото» ===== **/
bot.on('photo', async (ctx) => {
  try {
    const promptId = photoPromptByChat.get(ctx.chat.id);
    const replyTo = ctx.message?.reply_to_message?.message_id;
    if (promptId && replyTo === promptId) {
      await ctx.reply('✅ Фото получены, спасибо! Я свяжусь с вами по итогам оценки.');
      if (ADMIN_CHAT_ID) {
        await ctx.forwardMessage(ADMIN_CHAT_ID, ctx.chat.id, ctx.message.message_id);
      }
    }
  } catch(e){ console.error('photo error', e); }
});

/** ===== Выбор даты (пациент) ===== **/
bot.action('pick_date', async (ctx) => {
  dateState.set(ctx.chat.id, { step:'day' });
  await ctx.editMessageReplyMarkup(buildDayKeyboard().reply_markup).catch(()=>{});
  await ctx.answerCbQuery();
});
bot.action(/pick_day:(\d{4}-\d{2}-\d{2})/, async (ctx) => {
  const iso = ctx.match[1];
  dateState.set(ctx.chat.id, { step:'time', date: iso });
  await ctx.editMessageReplyMarkup(buildTimeKeyboard(iso).reply_markup).catch(()=>{});
  await ctx.answerCbQuery(dayLabel(new Date(iso)));
});
bot.action(/pick_time:(\d{4}-\d{2}-\d{2}):(\d{2}:\d{2})/, async (ctx) => {
  const [, iso, time] = ctx.match;
  dateState.set(ctx.chat.id, { step:'done', date: iso, time });
  await ctx.editMessageText(`📅 Вы выбрали: ${iso} в ${time}`).catch(()=>{});
  await ctx.answerCbQuery('Слот выбран');

  if (ADMIN_CHAT_ID) {
    await ctx.telegram.sendMessage(
      ADMIN_CHAT_ID,
      `📅 Пациент выбрал слот: ${iso} в ${time}\nchatId: ${ctx.chat.id}`,
      { reply_markup: { inline_keyboard: [[{ text:'Открыть диалог', url: userDeepLink(ctx.from) }]] } }
    );
  }
});
bot.action('pick_back', async (ctx) => {
  const st = dateState.get(ctx.chat.id);
  if (st?.step === 'time') {
    await ctx.editMessageReplyMarkup(buildDayKeyboard().reply_markup).catch(()=>{});
    dateState.set(ctx.chat.id, { step:'day' });
  }
  await ctx.answerCbQuery();
});
bot.action('pick_cancel', async (ctx) => {
  dateState.delete(ctx.chat.id);
  await ctx.editMessageText('Выбор даты отменён.').catch(()=>{});
  await ctx.answerCbQuery('Отменено');
});

/** ===== Кнопки для врача ===== **/
bot.action(/nudge_photo:(\d+)/, async (ctx) => {
  const chatId = Number(ctx.match[1]);
  await ctx.answerCbQuery('Запрос отправлен');
  await ctx.telegram.sendMessage(
    chatId,
    '📎 Пожалуйста, прикрепите 2–5 фото ответом на это сообщение (общий план + крупный план при дневном рассеянном свете).'
  );
});
bot.action(/admin_pick_date:(\d+)/, async (ctx) => {
  const chatId = Number(ctx.match[1]);
  await ctx.answerCbQuery();
  await ctx.telegram.sendMessage(chatId, 'Давайте выберем дату консультации:', buildDayKeyboard());
});

/** ===== Запуск ===== **/
bot.launch().then(() => console.log('ARI bot started'));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
