// ARI — Telegram bot (WebApp-слоты без Cal.com)
// Поток: согласие → жалобы → анамнез → ≥3 фото → оплата (QR) → WebApp /datetime → подтверждение и карточка в админ-канал
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
const ADMIN_CHAT_ID  = process.env.ADMIN_CHAT_ID;                // -100... (канал/группа, бот — админ)
const PAYMENT_QR_URL = process.env.PAYMENT_QR_URL || "";         // HTTPS URL картинки QR
const RAW_WEBAPP     = process.env.WEBAPP_URL || "";             // может быть с /datetime или без
const PRICE_RUB      = Number(process.env.PRICE_RUB || 3500);
const TZ             = process.env.TZ || "Europe/Berlin";
const PORT           = process.env.PORT || 3000;

// нормализуем URL: если забыли /datetime — добавим
const WEBAPP_URL = RAW_WEBAPP.endsWith("/datetime")
  ? RAW_WEBAPP
  : RAW_WEBAPP.replace(/\/+$/, "") + "/datetime";

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
    ctx.session.ari = { photos: [], paid: false, slot: null, note: "", paymentAsked: false, _album: { t: null, id: null } };
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
    await ctx.reply("Опишите анамнез заболевания: начало, динамика, что уже пробовали (препараты/дозы/длительность), переносимость.");
    return ctx.wizard.next();
  },

  // Шаг 3 — фото (альбомы, анти-спам, гарантированный переход к оплате)
  async (ctx) => {
    ctx.session.ari = ctx.session.ari || { photos: [], paid: false, slot: null, note: "", paymentAsked: false, _album: { t: null, id: null } };
    const S = ctx.session.ari;

    // если уже предложили оплату — лишние фото не триггерят повторов
    if (S.paymentAsked) {
      if (ctx.message?.photo?.length) {
        await ctx.reply("Фото принял 👍 Теперь нажмите «Я оплатил(а)» и выберите время.");
      } else {
        await ctx.reply("После оплаты нажмите «Я оплатил(а)».");
      }
      return;
    }

    // просим фото, если пришло не фото
    if (!ctx.message?.photo?.length) {
      await ctx.reply("Пришлите 3–5 фото высыпаний (общий план и крупные планы).");
      return;
    }

    // добавляем фото
    const largest = ctx.message.photo.at(-1);
    S.photos.push(largest.file_id);
    const albumId = ctx.message.media_group_id || null;

    // счётчик
    await ctx.reply(`Фото получено ✅ (${S.photos.length})`);

    // ==== обработка альбомов ====
    S._album = S._album || {};
    if (albumId) {
      if (S._album.t) clearTimeout(S._album.t);
      S._album.id = albumId;

      S._album.t = setTimeout(async () => {
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
            await ctx.wizard.next(); // шаг 4
          }
        }
      }, 1200); // ждём дольёта кадров альбома
      return;
    }

    // ==== одиночные фото (не альбом) ====
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
        await ctx.wizard.next(); // шаг 4
      }
      return;
    }
  },

  // Шаг 4 — подтверждение оплаты → Кнопки WebApp (inline + url + текст)
  async (ctx) => {
    if (!(ctx.updateType === "callback_query" && ctx.callbackQuery.data === "paid_yes")) {
      await ctx.reply("После оплаты нажмите кнопку «Я оплатил(а)»."); return;
    }
    await ctx.answerCbQuery("Спасибо!");
    ctx.session.ari.paid = true;

    if (!WEBAPP_URL || !/^https?:\/\/.+/.test(WEBAPP_URL)) {
      await ctx.reply(
        "✅ Оплата подтверждена, но ссылка на форму выбора времени не настроена.\n" +
        "Сообщите, пожалуйста, удобные дату и время текстом.\n\n" +
        "Администратору: проверьте переменную Railway `WEBAPP_URL`."
      );
    } else {
      await ctx.reply(
        "✅ Оплата подтверждена\nТеперь выберите дату и время консультации:",
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "🗓 Открыть форму (WebApp)", web_app: { url: WEBAPP_URL } }],
              [{ text: "Открыть в браузере", url: WEBAPP_URL }]
            ]
          },
          disable_web_page_preview: true
        }
      );
      await ctx.reply(`Если кнопка не открывается, прямая ссылка: ${WEBAPP_URL}`);
    }

    // уведомляем канал — неблокирующе
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

// Диагностика: вручную открыть WebApp
bot.command("webapp", async (ctx) => {
  await ctx.reply(
    "Тест открытия WebApp:",
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🗓 Открыть форму (WebApp)", web_app: { url: WEBAPP_URL } }],
          [{ text: "Открыть в браузере", url: WEBAPP_URL }]
        ]
      }
    }
  );
  await ctx.reply(`Прямая ссылка: ${WEBAPP_URL}`);
});

// ===== Приём данных из WebApp (/datetime) =====
// WebApp: tg.sendData(JSON.stringify({ datetimeISO, note }))
bot.on("message", async (ctx) => {
  const raw = ctx.message?.web_app_data?.data;
  if (!raw) return;

  try {
    const { datetimeISO, note } = JSON.parse(raw || "{}");
    const utcISO = dayjs(datetimeISO).utc().format("YYYY-MM-DD HH:mm");

    ctx.session.ari = ctx.session.ari || { photos: [] };
    ctx.session.ari.slot = datetimeISO;
    ctx.session.ari.note = note || "";

    await ctx.reply(
      `🕒 Запрос на слот получен!\nДата и время: *${datetimeISO}* (${TZ})\nМы подтвердим встречу в ближайшее время.`,
      { parse_mode: "Markdown" }
    );

    const card = [
      "📬 *Новая запись на консультацию*",
      `Пациент: @${ctx.from?.username || ctx.from?.id}`,
      `🗓 Слот: *${datetimeISO}* (${TZ})`,
      `🌍 UTC: ${utcISO}`,
      `💬 Комментарий: ${note || "—"}`,
      `💬 Chat ID: \`${ctx.chat.id}\``
    ].join("\n");

    sendToAdmins(bot.telegram, card, ctx.session.ari.photos || []);
  } catch (e) {
    console.error(e);
    await ctx.reply("Упс, техническая ошибка. Попробуйте ещё раз.");
  }
});

// ===== Express: WebApp и health-check =====
const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// раздача статики (если позже добавишь css/js)
app.use(express.static(__dirname, { maxAge: "1h", etag: true }));

// Вшитая резервная версия datetime.html (если файла нет — всё равно откроется)
const DATETIME_HTML = `<!doctype html><html lang="ru"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1">
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<title>Выбор даты и времени</title>
<style>
body{font-family:system-ui,-apple-system,Arial;margin:20px;color:#222}
label{display:block;margin:12px 0 6px;font-weight:500}
input,textarea,button{width:100%;font-size:16px;padding:10px;box-sizing:border-box;border-radius:10px;border:1px solid #ccc}
button{background:#64C27B;color:#fff;border:none;margin-top:14px;padding:12px;border-radius:10px;font-weight:600}
</style></head><body>
<h3>Выберите дату и время консультации</h3>
<label>Дата и время</label>
<input id="dt" type="datetime-local">
<label>Комментарий (необязательно)</label>
<textarea id="note" rows="3" placeholder="Например: утром до 12 или после 18:00"></textarea>
<button id="send">Отправить</button>
<script>
const tg=window.Telegram.WebApp; tg.expand();
const WORK_START=9, WORK_END=19, STEP_MIN=30, MIN_HOURS=2;
const dt=document.getElementById('dt'); const pad=n=>String(n).padStart(2,'0');
function roundToStep(date, stepMin){const d=new Date(date); const m=d.getMinutes(); const r=Math.ceil(m/stepMin)*stepMin; d.setMinutes(r,0,0); return d;}
function nextWorkSlot(from){let d=roundToStep(from,STEP_MIN); const h=d.getHours();
  if(h<WORK_START){d.setHours(WORK_START,0,0,0);}
  if(h>=WORK_END){d.setDate(d.getDate()+1); d.setHours(WORK_START,0,0,0);}
  return d;}
const min=new Date(Date.now()+MIN_HOURS*3600*1000);
const start=nextWorkSlot(min);
const toLocal=(d)=>\`\${d.getFullYear()}-\${String(d.getMonth()+1).padStart(2,'0')}-\${String(d.getDate()).padStart(2,'0')}T\${String(d.getHours()).padStart(2,'0')}:\${String(d.getMinutes()).padStart(2,'0')}\`;
dt.min=toLocal(start); dt.value=toLocal(start);
document.getElementById('send').onclick=()=>{
  if(!dt.value) return alert('Выберите дату и время');
  const chosen=new Date(dt.value); const h=chosen.getHours();
  if(h<WORK_START||h>=WORK_END) return alert('Вне рабочих часов (09:00–19:00)');
  if(chosen<start) return alert('Выберите время не раньше чем через 2 часа');
  const payload={ datetimeISO: dt.value, note: document.getElementById('note').value||'' };
  tg.sendData(JSON.stringify(payload)); tg.close();
};
</script></body></html>`;

// если лежит реальный файл — отдадим его; иначе — встроенную копию
app.get("/datetime", (_req, res) => {
  const fsPath = path.join(__dirname, "datetime.html");
  res.sendFile(fsPath, (err) => {
    if (err) res.type("html").send(DATETIME_HTML);
  });
});

// health
app.get("/", (_req, res) => res.send("ARI bot running ✅"));

// ===== Запуск: чистим вебхук, отрезаем хвост, ограничиваем апдейты =====
(async () => {
  try { await bot.telegram.deleteWebhook({ drop_pending_updates: true }); }
  catch (e) { console.warn("Webhook delete warn:", e.message); }

  await bot.launch({
    dropPendingUpdates: true,
    allowedUpdates: ["message", "callback_query"]
  });

  console.log("✅ Bot launched. WEBAPP_URL =", WEBAPP_URL);
  app.listen(PORT, () => console.log("✅ ARI bot + WebApp listening on", PORT));
})();

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));


