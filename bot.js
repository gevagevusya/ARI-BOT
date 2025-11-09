// ARI — Telegram bot (WebApp-слоты без Cal.com)
// Поток: согласие → жалобы → анамнез → ≥3 фото → оплата (QR) → WebApp /datetime → бот подтверждает пациенту и шлёт карточку в админ-канал
// Node >= 20; deps: telegraf, express, dayjs

import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { Telegraf, Markup, Scenes, session } from "telegraf";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
dayjs.extend(utc);

// ===== ENV =====
const BOT_TOKEN      = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID  = process.env.ADMIN_CHAT_ID;                // -100... (канал/группа, бот должен быть админом)
const PAYMENT_QR_URL = process.env.PAYMENT_QR_URL || "";         // URL картинки QR на оплату
const WEBAPP_URL     = process.env.WEBAPP_URL || "";             // https://<railway>/datetime
const PRICE_RUB      = Number(process.env.PRICE_RUB || 3500);    // стоимость консультации
const TZ             = process.env.TZ || "Europe/Berlin";
const PORT           = process.env.PORT || 3000;

if (!BOT_TOKEN)      { console.error("❌ Missing BOT_TOKEN");      process.exit(1); }
if (!ADMIN_CHAT_ID)  { console.error("❌ Missing ADMIN_CHAT_ID");  process.exit(1); }

const bot = new Telegraf(BOT_TOKEN);

// ===== Быстрая отправка в канал (не блокируем ответы пациенту) =====
async function sendToAdmins(telegram, payload, photos = []) {
  const tasks = [];

  // текст — отдельным сообщением
  tasks.push(
    telegram.sendMessage(ADMIN_CHAT_ID, payload, { disable_web_page_preview: true }).catch(() => {})
  );

  // фото — медиагруппой (до 10) или одним фото
  if (photos.length > 1) {
    const media = photos.slice(0, 10).map((fileId, i) => ({
      type: "photo",
      media: fileId,
      ...(i === 0 ? { caption: "Фото по заявке" } : {})
    }));
    tasks.push(bot.telegram.sendMediaGroup(ADMIN_CHAT_ID, media).catch(() => {}));
  } else if (photos.length === 1) {
    tasks.push(bot.telegram.sendPhoto(ADMIN_CHAT_ID, photos[0], { caption: "Фото по заявке" }).catch(() => {}));
  }

  // выполняем в фоне
  Promise.allSettled(tasks);
}

// ===== Тексты (юридика кратко) =====
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
    `Анамнез заболевания: ${prettify(d.hxDisease)}`
  ];
  if (d.photos?.length) parts.push(`Фото: ${d.photos.length} шт.`);
  if (d.paid) parts.push("💳 Оплата подтверждена");
  if (d.slot) parts.push(`🕒 Выбранный слот: ${d.slot} (${TZ})`);
  if (d.note) parts.push(`💬 Комментарий: ${prettify(d.note)}`);
  return parts.join("\n");
}

// ===== Сцены (Wizard) =====
const { WizardScene, Stage } = Scenes;

const wizard = new WizardScene(
  "ari",
  // Шаг 0 — приветствие и согласие
  async (ctx) => {
    ctx.session.ari = { photos: [], paid: false, slot: null, note: "" };
    await ctx.reply(
      "Как это работает:\n" +
      "1) Опишете жалобы и анамнез заболевания\n" +
      "2) Пришлёте 3–5 фото высыпаний\n" +
      `3) Оплатите консультацию по QR (${PRICE_RUB} ₽)\n` +
      "4) Выберете удобное время через мини-страницу\n\n" + LEGAL_BRIEF,
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
    await ctx.reply(
      "Опишите анамнез заболевания: начало, динамика, что уже пробовали (препараты/дозы/длительность), переносимость."
    );
    return ctx.wizard.next();
  },

  // Шаг 3 — фото (автопереход на оплату после ≥3 фото)
  async (ctx) => {
    if (ctx.message?.photo?.length) {
      const largest = ctx.message.photo.at(-1);
      ctx.session.ari.photos.push(largest.file_id);
      await ctx.reply(`Фото получено ✅ (${ctx.session.ari.photos.length})`);

      if (ctx.session.ari.photos.length >= 3) {
        if (PAYMENT_QR_URL) {
          await ctx.replyWithPhoto(PAYMENT_QR_URL, {
            caption: `Отлично! Фото достаточно.\n💳 Оплата консультации: ${PRICE_RUB} ₽\nОтсканируйте QR и нажмите кнопку ниже.`,
            reply_markup: { inline_keyboard: [[{ text: "Я оплатил(а)", callback_data: "paid_yes" }]] }
          });
        } else {
          await ctx.reply(
            `Сумма консультации: ${PRICE_RUB} ₽.\n(QR не подключён) После оплаты нажмите «Я оплатил(а)».`,
            Markup.inlineKeyboard([[Markup.button.callback("Я оплатил(а)", "paid_yes")]])
          );
        }
        return ctx.wizard.next();
      }
      return; // ждём ещё фото
    }
    await ctx.reply("Пришлите 3–5 фото высыпаний (общий план и крупные планы).");
  },

  // Шаг 4 — подтверждение оплаты → Кнопка WebApp
  async (ctx) => {
    if (!(ctx.updateType === "callback_query" && ctx.callbackQuery.data === "paid_yes")) {
      await ctx.reply("После оплаты нажмите кнопку «Я оплатил(а)»."); return;
    }
    await ctx.answerCbQuery("Спасибо!");
    ctx.session.ari.paid = true;

    if (WEBAPP_URL) {
      await ctx.reply(
        "✅ Оплата подтверждена\nТеперь выберите дату и время консультации:",
        {
          reply_markup: {
            keyboard: [[{ text: "🗓 Открыть форму", web_app: { url: WEBAPP_URL } }]],
            resize_keyboard: true,
            one_time_keyboard: true
          }
        }
      );
    } else {
      await ctx.reply("✅ Оплата подтверждена. Напишите удобные дни/время текстом — подберу ближайшее окно.");
    }

    // уведомляем канал о факте оплаты и ранее собранных данных — НЕ блокируем ответ пациенту
    sendToAdmins(ctx.telegram, summarize(ctx), ctx.session.ari.photos || []);

    return ctx.scene.leave();
  }
);

// ===== Инициализация сцен и middleware =====
const stage = new Stage([wizard]);
bot.use(session());
bot.use(stage.middleware());

// ===== Команды =====
bot.start(async (ctx) => {
  await ctx.scene.enter("ari");
});
bot.command("terms", (ctx) => ctx.reply(TERMS_TEXT));
bot.command("privacy", (ctx) => ctx.reply(PRIVACY_TEXT));
bot.command("id", (ctx) => ctx.reply(`Ваш Telegram ID: ${ctx.from.id}`));

// ===== Приём данных из WebApp (/datetime) =====
// tg.sendData(JSON.stringify({ datetimeISO, note }))
bot.on("message", async (ctx) => {
  const raw = ctx.message?.web_app_data?.data;
  if (!raw) return; // не мешаем обычной переписке

  try {
    const { datetimeISO, note } = JSON.parse(raw || "{}");
    const utcISO = dayjs(datetimeISO).utc().format("YYYY-MM-DD HH:mm");

    // сохраняем в сессию
    ctx.session.ari = ctx.session.ari || { photos: [] };
    ctx.session.ari.slot = datetimeISO;
    ctx.session.ari.note = note || "";

    // мгновенный ответ пациенту
    await ctx.reply(
      `🕒 Запрос на слот получен!\nДата и время: *${datetimeISO}* (${TZ})\nМы подтвердим встречу в ближайшее время.`,
      { parse_mode: "Markdown" }
    );

    // карточка в канал (в фоне)
    const card = [
      "📬 *Новая запись на консультацию*",
      `Пациент: @${ctx.from?.username || ctx.from?.id}`,
      `🗓 Слот: *${datetimeISO}* (${TZ})`,
      `🌍 UTC: ${utcISO}`,
      `💬 Комментарий: ${note || "—"}`,
      `💬 Chat ID: \`${ctx.chat.id}\``
    ].join("\n");

    sendToAdmins(ctx.telegram, card, ctx.session.ari.photos || []);
  } catch (e) {
    console.error(e);
    await ctx.reply("Упс, техническая ошибка. Попробуйте ещё раз.");
  }
});

// ===== Express: WebApp и health-check =====
const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// раздача статики (+ возможные будущие css/js), кешируем
app.use(express.static(__dirname, { maxAge: "1h", etag: true }));

// мини-страница Telegram WebApp
app.get("/datetime", (_req, res) => {
  res.set("Cache-Control", "public, max-age=300");
  res.sendFile(path.join(__dirname, "datetime.html"));
});

// health
app.get("/", (_req, res) => res.send("ARI bot running ✅"));

// ===== Запуск: чистим вебхук, отрезаем хвост, ограничиваем апдейты =====
(async () => {
  try {
    await bot.telegram.deleteWebhook({ drop_pending_updates: true });
  } catch (e) {
    console.warn("Webhook delete warn:", e.message);
  }

  await bot.launch({
    dropPendingUpdates: true,
    allowedUpdates: ["message", "callback_query"]
  });

  app.listen(PORT, () => console.log("✅ ARI bot + WebApp listening on", PORT));
})();

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
