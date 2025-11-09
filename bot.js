import express from "express";
import { Telegraf, Markup, Scenes, session } from "telegraf";

// === ENV ===
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHANNEL = process.env.ADMIN_CHANNEL ? Number(process.env.ADMIN_CHANNEL) : undefined;
const PAYMENT_QR_URL = process.env.PAYMENT_QR_URL || "";
const MEETING_URL = process.env.MEETING_URL || "https://telemost.yandex.ru/";
const PRICE_RUB = 3500;

if (!BOT_TOKEN) {
  console.error("❌ Missing BOT_TOKEN");
  process.exit(1);
}
const bot = new Telegraf(BOT_TOKEN);

// === Уведомления только в канал ===
async function sendToAdmins(telegram, payload, photos = []) {
  if (!Number.isFinite(ADMIN_CHANNEL)) return;
  try {
    await telegram.sendMessage(ADMIN_CHANNEL, payload, { disable_web_page_preview: true });
    for (const f of photos) await telegram.sendPhoto(ADMIN_CHANNEL, f).catch(() => {});
  } catch (e) {
    console.warn("admin send warn:", e.message);
  }
}

// === Тексты ===
const LEGAL_BRIEF =
  "⚖️ Важно:\n" +
  "— Бот не является медицинской консультацией и не ставит диагноз.\n" +
  "— Ответы носят информационный характер и не заменяют очный осмотр.\n" +
  "— Данные не сохраняются вне Telegram.\n" +
  "— При экстренных состояниях обращайтесь за неотложной помощью.";

const TERMS_TEXT =
  "📄 Пользовательское соглашение\n\n" +
  "1) Бот даёт информационные ответы без постановки диагноза.\n" +
  "2) Сообщения не являются телемедицинской консультацией.\n" +
  "3) Данные не сохраняются вне Telegram.\n" +
  "4) Решения принимаются после очной консультации.\n" +
  "5) При неотложных состояниях — экстренная помощь.";

const PRIVACY_TEXT =
  "🔒 Политика конфиденциальности\n\n" +
  "1) Обрабатываются только данные, которые вы отправляете в чат.\n" +
  "2) Переписка хранится по правилам Telegram.\n" +
  "3) Используем сведения только для обратной связи.\n" +
  "4) Не передаём данные третьим лицам.\n" +
  "5) Не отправляйте избыточную информацию.";

// === Слоты расписания ===
const timeSlots = [
  ["Сегодня 19:00", "Сегодня 20:00"],
  ["Завтра 11:00", "Завтра 12:00"],
  ["Пн 14:00", "Пн 15:00"],
];

function prettify(s) {
  return (s || "").trim() || "—";
}
function summarize(ctx) {
  const d = ctx.session?.ari || {};
  const parts = [
    "📨 Новая заявка ARI",
    `Пациент: @${ctx.from?.username || "—"} (id ${ctx.from?.id})`,
    `Жалобы: ${prettify(d.complaints)}`,
    `Анамнез заболевания: ${prettify(d.hxDisease)}`,
  ];
  if (d.photos?.length) parts.push(`Фото: ${d.photos.length} шт.`);
  if (d.slot) parts.push(`🕒 Выбранное время: ${d.slot}`);
  if (d.paid) parts.push("💳 Оплата подтверждена");
  return parts.join("\n");
}

// === Сцена ===
const { WizardScene, Stage } = Scenes;

const wizard = new WizardScene(
  "ari",
  async (ctx) => {
    ctx.session.ari = { photos: [], paid: false };
    await ctx.reply(
      "Как это работает:\n" +
        "1) Опишете жалобы и анамнез заболевания\n" +
        "2) Пришлёте фото высыпаний\n" +
        `3) Оплатите консультацию по QR (${PRICE_RUB} ₽)\n` +
        "4) Выберете удобное время\n\n" +
        LEGAL_BRIEF,
      Markup.inlineKeyboard([
        [Markup.button.callback("📄 Пользовательское соглашение", "terms")],
        [Markup.button.callback("🔒 Политика конфиденциальности", "privacy")],
        [Markup.button.callback("✅ Согласен(а) и начать", "agree")],
      ])
    );
    return ctx.wizard.next();
  },

  // === Шаг 1: жалобы
  async (ctx) => {
    if (ctx.updateType === "callback_query") {
      const cb = ctx.callbackQuery.data;
      await ctx.answerCbQuery();
      if (cb === "terms") return ctx.reply(TERMS_TEXT);
      if (cb === "privacy") return ctx.reply(PRIVACY_TEXT);
      if (cb === "agree") {
        await ctx.reply("Опишите ваши жалобы (что, где, когда появилось, что усиливает/ослабляет):");
        return ctx.wizard.next();
      }
      return;
    }
    await ctx.reply("Нажмите «✅ Согласен(а) и начать» для продолжения.");
  },

  // === Шаг 2: анамнез
  async (ctx) => {
    if (!ctx.message?.text) return await ctx.reply("Пожалуйста, напишите текстом.");
    ctx.session.ari.complaints = ctx.message.text.trim();
    await ctx.reply(
      "Опишите анамнез заболевания:\n— Когда началось, чем лечили, помогало ли?\n— Есть ли хронические болезни, аллергия?"
    );
    return ctx.wizard.next();
  },

  // === Шаг 3: фото (автопереход после 3 фото)
  async (ctx) => {
    if (ctx.message?.photo?.length) {
      const largest = ctx.message.photo.at(-1);
      ctx.session.ari.photos.push(largest.file_id);
      await ctx.reply(`Фото получено ✅ (${ctx.session.ari.photos.length})`);
      if (ctx.session.ari.photos.length >= 3) {
        await ctx.replyWithPhoto(PAYMENT_QR_URL, {
          caption: `Отлично! Фото достаточно.\n💳 Оплата консультации: ${PRICE_RUB} ₽.\nОтсканируйте QR и нажмите кнопку ниже.`,
          reply_markup: { inline_keyboard: [[{ text: "Я оплатил(а)", callback_data: "paid_yes" }]] },
        });
        return ctx.wizard.next();
      }
      return;
    }
    await ctx.reply("Пришлите фото высыпаний (3–5 снимков).");
  },

  // === Шаг 4: подтверждение оплаты → выбор времени
  async (ctx) => {
    if (!(ctx.updateType === "callback_query" && ctx.callbackQuery.data === "paid_yes")) {
      return await ctx.reply("После оплаты нажмите кнопку «Я оплатил(а)».");
    }
    await ctx.answerCbQuery("Спасибо!");
    ctx.session.ari.paid = true;
    await ctx.reply(
      "Оплата подтверждена ✅\nВыберите удобное время для консультации:",
      Markup.inlineKeyboard(
        timeSlots.map((row) => row.map((t) => Markup.button.callback(t, `slot_${t}`)))
      )
    );
    await sendToAdmins(ctx.telegram, summarize(ctx), ctx.session.ari.photos);
    return ctx.scene.leave();
  }
);

// === Выбор времени (inline)
bot.action(/^slot_(.+)/, async (ctx) => {
  const time = ctx.match[1];
  ctx.session.ari.slot = time;
  await ctx.answerCbQuery();
  await ctx.reply(
    `✅ Вы выбрали время: *${time}*\n🔗 Ссылка на телемост: [Перейти](${MEETING_URL})\n\nПожалуйста, подключитесь за 5 минут до начала.`,
    { parse_mode: "Markdown", disable_web_page_preview: true }
  );
  await sendToAdmins(ctx.telegram, summarize(ctx), ctx.session?.ari?.photos);
});

// === Сцены
const stage = new Stage([wizard]);
bot.use(session());
bot.use(stage.middleware());

// === Команды
bot.start(async (ctx) => {
  await ctx.scene.enter("ari");
});
bot.command("terms", (ctx) => ctx.reply(TERMS_TEXT));
bot.command("privacy", (ctx) => ctx.reply(PRIVACY_TEXT));
bot.command("id", (ctx) => ctx.reply(`Ваш Telegram ID: ${ctx.from.id}`));

// === Express health check ===
const app = express();
app.get("/", (_, res) => res.send("ARI bot running"));
const PORT = process.env.PORT || 3000;

(async () => {
  await bot.launch();
  app.listen(PORT, () => console.log("✅ Bot running on port", PORT));
})();
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));


