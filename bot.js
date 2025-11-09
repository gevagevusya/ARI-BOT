// ARI — Telegram bot (упрощённый поток БЕЗ выбора даты)
// Поток: согласие → жалобы → анамнез → ≥3 фото → оплата (QR) → сообщение "оплата прошла; пришлём ссылку позже" → заявка в админ-канал
// Node >= 20; deps: telegraf, express

import express from "express";
import { Telegraf, Markup, Scenes, session } from "telegraf";

// ===== ENV =====
const BOT_TOKEN      = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID  = process.env.ADMIN_CHAT_ID;                // -100... (канал/группа, бот — админ)
const PAYMENT_QR_URL = process.env.PAYMENT_QR_URL || "";         // HTTPS URL картинки QR
const PRICE_RUB      = Number(process.env.PRICE_RUB || 3500);
const PORT           = process.env.PORT || 3000;

if (!BOT_TOKEN)     { console.error("❌ Missing BOT_TOKEN");     process.exit(1); }
if (!ADMIN_CHAT_ID) { console.error("❌ Missing ADMIN_CHAT_ID"); process.exit(1); }

const bot = new Telegraf(BOT_TOKEN);

// ===== Быстрая отправка в канал (не блокируем ответы пациенту) =====
async function sendToAdmins(telegram, payload, photos = []) {
  const tasks = [];
  tasks.push(
    telegram.sendMessage(ADMIN_CHAT_ID, payload, { disable_web_page_preview: true }).catch(() => {})
  );
  if (photos.length > 1) {
    const media = photos.slice(0, 10).map((fileId, i) => ({
      type: "photo",
      media: fileId,
      ...(i === 0 ? { caption: "Фото по заявке" } : {})
    }));
    tasks.push(telegram.sendMediaGroup(ADMIN_CHAT_ID, media).catch(() => {}));
  } else if (photos.length === 1) {
    tasks.push(telegram.sendPhoto(ADMIN_CHAT_ID, photos[0], { caption: "Фото по заявке" }).catch(() => {}));
  }
  Promise.allSettled(tasks);
}

// ===== Тексты =====
const LEGAL_BRIEF =
  "⚖️ Важно:\n" +
  "— Бот не является медицинской консультацией и не ставит диагноз.\n" +
  "— Ответы носят информационный характер и не заменяют очный осмотр.\n" +
  "— Данные не сохраняются вне Telegram.\n" +
  "— При экстренных состояниях обращайтесь за неотложной помощью.";

const TERMS_TEXT =
  "📄 Пользовательское соглашение (кратко)\n\n" +
  "1) Бот даёт информационные ответы без постановки диагноза/назначений.\n" +
  "2) Сообщения в боте не являются телемедицинской консультацией.\n" +
  "3) Данные обрабатываются в рамках Telegram; внешних БД нет.\n" +
  "4) Решения принимаются после очной консультации у врача.\n" +
  "5) При неотложных состояниях — экстренная помощь.";

const PRIVACY_TEXT =
  "🔒 Политика конфиденциальности (кратко)\n\n" +
  "1) Получаем только то, что вы отправляете в чат.\n" +
  "2) Переписка хранится по правилам Telegram.\n" +
  "3) Используем сведения для ответа и организации консультации.\n" +
  "4) Передача третьим лицам — только по закону.\n" +
  "5) Не отправляйте избыточные персональные данные.";

// ===== Хелперы =====
function prettify(s) { return (s || "").trim() || "—"; }
function summarize(ctx) {
  const d = ctx.session?.ari || {};
  const parts = [
    "📨 Новая заявка ARI",
    `Пациент: @${ctx.from?.username || "—"} (id ${ctx.from?.id})`,
    `Жалобы: ${prettify(d.complaints)}`,
    `Анамнез заболевания: ${prettify(d.hxDisease)}`,
  ];
  if (d.photos?.length) parts.push(`Фото: ${d.photos.length} шт.`);
  if (d.paid) parts.push("💳 Оплата подтверждена пользователем");
  return parts.join("\n");
}

// ===== Сцены (Wizard) =====
const { WizardScene, Stage } = Scenes;

const wizard = new WizardScene(
  "ari",
  // Шаг 0 — приветствие и согласие
  async (ctx) => {
    ctx.session.ari = { photos: [], paid: false, paymentAsked: false, _album: { t: null, id: null } };
    await ctx.reply(
      "Как это работает:\n" +
      "1) Опишете жалобы и анамнез заболевания\n" +
      "2) Пришлёте 3–5 фото высыпаний\n" +
      `3) Оплатите консультацию по QR (${PRICE_RUB} ₽)\n\n` + LEGAL_BRIEF,
      Markup.inlineKeyboard([
        [Markup.button.callback("📄 Пользовательское соглашение", "terms")],
        [Markup.button.callback("🔒 Политика конфиденциальности", "privacy")],
        [Markup.button.callback("✅ Согласен(а) и начать", "agree")],
      ])
    );
    return ctx.wizard.next();
  },

  // Шаг 1 — жалобы
  async (ctx) => {
    if (ctx.updateType === "callback_query") {
      const cb = ctx.callbackQuery.data;
      await ctx.answerCbQuery();
      if (cb === "terms")   { await ctx.reply(TERMS_TEXT); return; }
      if (cb === "privacy") { await ctx.reply(PRIVACY_TEXT); return; }
      if (cb === "agree") {
        await ctx.reply("Опишите жалобы: что беспокоит, где локализация, когда началось, что усиливает/ослабляет.");
        return ctx.wizard.next();
      }
      return;
    }
    await ctx.reply("Нажмите «✅ Согласен(а) и начать» для продолжения.");
  },

  // Шаг 2 — анамнез заболевания
  async (ctx) => {
    if (!ctx.message?.text) { await ctx.reply("Пожалуйста, напишите текстом."); return; }
    ctx.session.ari.complaints = ctx.message.text.trim();
    await ctx.reply("Опишите анамнез заболевания: начало, динамика, что уже пробовали (препараты/дозы/длительность), переносимость.");
    return ctx.wizard.next();
  },

  // Шаг 3 — фото (альбомы, анти-спам, один показ оплаты)
  async (ctx) => {
    ctx.session.ari = ctx.session.ari || { photos: [], paid: false, paymentAsked: false, _album: { t: null, id: null } };
    const S = ctx.session.ari;

    // Если оплату уже предложили — не триггерим заново
    if (S.paymentAsked) {
      if (ctx.message?.photo?.length) {
        await ctx.reply("Фото принял 👍 После оплаты нажмите «Я оплатил(а)».");
      } else {
        await ctx.reply("После оплаты нажмите «Я оплатил(а)».");
      }
      return;
    }

    if (!ctx.message?.photo?.length) {
      await ctx.reply("Пришлите 3–5 фото высыпаний (общий план и крупные планы).");
      return;
    }

    const largest = ctx.message.photo.at(-1);
    S.photos.push(largest.file_id);
    const albumId = ctx.message.media_group_id || null;

    await ctx.reply(`Фото получено ✅ (${S.photos.length})`);

    const showPaymentOnce = async () => {
      if (S.photos.length >= 3 && !S.paymentAsked) {
        S.paymentAsked = true;
        const kb = { inline_keyboard: [[{ text: "Я оплатил(а)", callback_data: "paid_yes" }]] };

        if (PAYMENT_QR_URL) {
          await ctx.replyWithPhoto(PAYMENT_QR_URL, {
            caption: `Отлично! Фото достаточно.\n💳 Оплата консультации: ${PRICE_RUB} ₽\nОтсканируйте QR и нажмите кнопку ниже.`,
            reply_markup: kb
          });
        } else {
          await ctx.reply(
            `Сумма консультации: ${PRICE_RUB} ₽.\n(QR не подключён) После оплаты нажмите «Я оплатил(а)».`,
            { reply_markup: kb }
          );
        }

        if (ctx.wizard && ctx.wizard.cursor === 3) {
          await ctx.wizard.next(); // переходим к шагу оплаты
        }
      }
    };

    // Альбом: ждём, пока «дольются» кадры, и показываем оплату один раз
    if (albumId) {
      if (S._album.t) clearTimeout(S._album.t);
      S._album.id = albumId;
      S._album.t = setTimeout(showPaymentOnce, 1200);
      return;
    }

    // Не альбом: проверяем сразу
    await showPaymentOnce();
  },

  // Шаг 4 — подтверждение оплаты (без выбора времени)
  async (ctx) => {
    if (!(ctx.updateType === "callback_query" && ctx.callbackQuery.data === "paid_yes")) {
      await ctx.reply("После оплаты нажмите кнопку «Я оплатил(а)»."); return;
    }
    await ctx.answerCbQuery("Спасибо!");
    ctx.session.ari.paid = true;

    // Сообщение пациенту
    await ctx.reply(
      "✅ Оплата подтверждена.\n" +
      "Мы скоро пришлём ссылку для выбора даты и времени консультации.\n" +
      "Если нужно срочно — напишите здесь, постараемся найти ближайшее окно."
    );

    // Отправляем карточку в админ-канал (не блокируя ответ)
    sendToAdmins(bot.telegram, summarize(ctx), ctx.session.ari.photos || []);

    return ctx.scene.leave();
  }
);

// ===== Сцены =====
const stage = new Stage([wizard]);
bot.use(session());
bot.use(stage.middleware());

// ===== Команды =====
bot.start(async (ctx) => { await ctx.scene.enter("ari"); });
bot.command("terms", (ctx) => ctx.reply(TERMS_TEXT));
bot.command("privacy", (ctx) => ctx.reply(PRIVACY_TEXT));
bot.command("id", (ctx) => ctx.reply(`Ваш Telegram ID: ${ctx.from.id}`));

// ===== Express: health =====
const app = express();
app.get("/", (_req, res) => res.send("ARI bot running ✅"));

// ===== Запуск: чистим вебхук, отрезаем хвост, ограничиваем апдейты =====
(async () => {
  try { await bot.telegram.deleteWebhook({ drop_pending_updates: true }); }
  catch (e) { console.warn("Webhook delete warn:", e.message); }

  await bot.launch({
    dropPendingUpdates: true,
    allowedUpdates: ["message", "callback_query"]
  });

  app.listen(PORT, () => console.log("✅ ARI bot listening on", PORT));
})();

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
