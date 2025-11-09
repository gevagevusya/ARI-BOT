import express from "express";
import { Telegraf, Markup } from "telegraf";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
dayjs.extend(utc);

// ENV
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const WEBAPP_URL = process.env.WEBAPP_URL;
const PRICE_RUB = process.env.PRICE_RUB || 3500;
const TZ = process.env.TZ || "Europe/Berlin";

if (!BOT_TOKEN) {
  console.error("❌ Missing BOT_TOKEN");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const app = express();

// ======= 1️⃣  Запуск сценария =======
bot.start(async (ctx) => {
  await ctx.reply(
    `👋 Добро пожаловать в *ARI*!\n\nЯ помогу оформить онлайн-консультацию:\n1️⃣ Опишите жалобы\n2️⃣ Пришлите фото\n3️⃣ Оплатите консультацию (${PRICE_RUB} ₽)\n4️⃣ Выберите время встречи`,
    { parse_mode: "Markdown" }
  );
  await ctx.reply("Начнём! Опишите, что вас беспокоит 👇");
});

// ======= 2️⃣  Фото и оплата =======
bot.on("photo", async (ctx) => {
  const photos = ctx.message.photo;
  const count = photos ? photos.length : 0;

  if (count >= 1) {
    await ctx.reply("Фото получено ✅");
    if (!ctx.session?.paidPrompt) {
      await ctx.replyWithPhoto(process.env.PAYMENT_QR_URL, {
        caption: `💳 Стоимость консультации ${PRICE_RUB} ₽\nПосле оплаты нажмите кнопку ниже.`,
        reply_markup: { inline_keyboard: [[{ text: "Я оплатил(а)", callback_data: "paid_yes" }]] },
      });
      ctx.session = { paidPrompt: true };
    }
  }
});

// ======= 3️⃣  Оплата подтверждена =======
bot.action("paid_yes", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(
    "✅ Оплата подтверждена\nТеперь выберите дату и время консультации:",
    {
      reply_markup: {
        keyboard: [[{ text: "🗓 Открыть форму", web_app: { url: WEBAPP_URL } }]],
        resize_keyboard: true,
        one_time_keyboard: true,
      },
    }
  );
});

// ======= 4️⃣  Приём данных из WebApp =======
bot.on("message", async (ctx) => {
  const raw = ctx.message?.web_app_data?.data;
  if (!raw) return;

  try {
    const { datetimeISO, note } = JSON.parse(raw);
    const utcISO = dayjs(datetimeISO).utc().format("YYYY-MM-DD HH:mm");

    await ctx.reply(
      `🕒 Ваш запрос получен!\nДата и время: *${datetimeISO}* (${TZ})\nМы подтвердим встречу в ближайшее время.`,
      { parse_mode: "Markdown" }
    );

    await ctx.telegram.sendMessage(
      ADMIN_CHAT_ID,
      [
        "📬 *Новая запись на консультацию*",
        `Пациент: @${ctx.from?.username || ctx.from?.id}`,
        `🗓 Слот: *${datetimeISO}* (${TZ})`,
        `🌍 UTC: ${utcISO}`,
        `💬 Комментарий: ${note || "—"}`,
        `💬 Chat ID: \`${ctx.chat.id}\``,
      ].join("\n"),
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    console.error(err);
    await ctx.reply("Произошла ошибка, попробуйте позже ❗️");
  }
});

// ======= 5️⃣  WebApp роут =======
app.get("/datetime", (_req, res) => {
  res.sendFile(process.cwd() + "/datetime.html");
});

app.get("/", (_, res) => res.send("ARI bot running ✅"));

const PORT = process.env.PORT || 3000;
bot.launch();
app.listen(PORT, () => console.log("✅ Bot + WebApp запущены на", PORT));
