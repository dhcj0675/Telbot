// worker.js — Telegram bot on Cloudflare Workers (Reply Keyboard only; بدون اتکا به منوی سه‌خط)
// نکته: برای اینکه «منوی سه‌خط» چیزی نشون نده، اصلاً تو BotFather /setcommands تنظیم نکن
// (یا اگر قبلاً تنظیم کردی، لیست رو خالی کن). تمام آیتم‌ها رو در کیبورد لیبلی آورده‌ایم.
//
// Variables لازم (Workers → Settings → Variables):
//   BOT_TOKEN  (Secret)
//   WH_SECRET  (Var یا داخل wrangler.toml)
// اختیاری:
//   TG_SECRET_TOKEN (Secret) — اگر در setWebhook پارامتر secret_token= می‌دهی

const tg = async (env, method, payload) => {
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const body = await res.text();
    console.error("Telegram API error:", res.status, body);
    throw new Error(`tg ${method} ${res.status}`);
  }
  return res.json();
};

const send = (env, chat_id, text, extra = {}) =>
  tg(env, "sendMessage", { chat_id, text, ...extra });

const answerCallback = (env, callback_query_id, text = "", show_alert = false) =>
  tg(env, "answerCallbackQuery", { callback_query_id, text, show_alert });

// ====== برچسب‌های کیبورد لیبلی (تمام آیتم‌های «منوی سه‌خط» اینجاست) ======
const KB = {
  home: "🏠 خانه",
  help: "ℹ️ راهنما",
  products: "🛒 محصولات",
  account: "👤 حساب",
  ping: "🏓 پینگ",
  time: "⏰ زمان",
  whoami: "🆔 من کیم؟"
};

// کیبورد ثابت و همیشه باز
const REPLY_KB = {
  keyboard: [
    [{ text: KB.home }, { text: KB.help }],
    [{ text: KB.products }, { text: KB.account }],
    [{ text: KB.ping }, { text: KB.time }, { text: KB.whoami }]
  ],
  resize_keyboard: true,
  is_persistent: true,
  one_time_keyboard: false,
  input_field_placeholder: "از دکمه‌های پایین انتخاب کن…"
};

// پشتیبانی اختیاری از /command@BotName در گروه‌ها (برای سازگاری؛ ولی ما روی کیبورد تکیه می‌کنیم)
function parseCommand(text = "", botUsername = "") {
  if (!text || !text.startsWith("/")) return { cmd: null, args: [] };
  const [first, ...rest] = text.trim().split(/\s+/);
  const [raw, at] = first.split("@");
  if (at && botUsername && at.toLowerCase() !== botUsername.toLowerCase()) return { cmd: null, args: [] };
  return { cmd: raw.slice(1).toLowerCase(), args: rest };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Health: روت به جای "hello world" فقط ok می‌دهد
    if (request.method === "GET" && url.pathname === "/") {
      return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
    }

    // Webhook: فقط همین مسیر
    if (request.method === "POST" && url.pathname === `/webhook/${env.WH_SECRET}`) {
      // چک اختیاری هدر امنیتی تلگرام
      const hdr = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
      if (env.TG_SECRET_TOKEN && hdr !== env.TG_SECRET_TOKEN) return new Response("forbidden", { status: 403 });

      let update; try { update = await request.json(); } catch { update = null; }

      // ====== کال‌بک‌های اینلاین (برای زیرمنوی محصولات) ======
      if (update?.callback_query) {
        const cq = update.callback_query;
        const chatId = cq.message?.chat?.id;
        const data = cq.data || "";

        if (data === "prod_a") {
          await send(env, chatId, "جزئیات محصول A: قیمت 100٬000 تومان ✅", { reply_markup: REPLY_KB });
          await answerCallback(env, cq.id);
        } else if (data === "prod_b") {
          await send(env, chatId, "جزئیات محصول B: قیمت 150٬000 تومان ✅", { reply_markup: REPLY_KB });
          await answerCallback(env, cq.id);
        } else if (data === "back_home") {
          await send(env, chatId, "به خانه برگشتی 🏠", { reply_markup: REPLY_KB });
          await answerCallback(env, cq.id);
        } else {
          await send(env, chatId, `داده‌ی دکمه: ${data}`, { reply_markup: REPLY_KB });
          await answerCallback(env, cq.id);
        }
        return new Response("ok");
      }

      // ====== پیام‌های معمولی ======
      const msg = update && (update.message || update.edited_message);
      if (!msg) return new Response("ok");

      const chatId = msg.chat.id;
      const from = msg.from || {};
      const text = msg.text || "";

      // (اختیاری) اگر کاربر عمداً /command زد، همچنان کار کند
      let me = { result: { username: "" } };
      try { me = await tg(env, "getMe", {}); } catch {}
      const { cmd, args } = parseCommand(text, me.result.username);

      // ====== روتر بر اساس کیبورد لیبلی ======
      if (text === KB.home || cmd === "start") {
        await send(env, chatId,
          "سلام! ✅ همه گزینه‌ها در کیبورد پایین هست. (منوی سه‌خط استفاده نمی‌شود)",
          { reply_markup: REPLY_KB }
        );

      } else if (text === KB.help || cmd === "help") {
        await send(env, chatId,
          "راهنما:\n" +
          "• " + KB.home + " — برگشت به خانه\n" +
          "• " + KB.products + " — لیست محصولات و جزئیات\n" +
          "• " + KB.account + " — نمایش حساب شما\n" +
          "• " + KB.ping + " — تست زنده بودن\n" +
          "• " + KB.time + " — زمان فعلی UTC\n" +
          "• " + KB.whoami + " — شناسه شما",
          { reply_markup: REPLY_KB }
        );

      } else if (text === KB.products) {
        // منوی اینلاین زیرمجموعه‌ی محصولات
        await send(env, chatId, "لیست محصولات:", { reply_markup: REPLY_KB });
        await tg(env, "sendMessage", {
          chat_id: chatId,
          text: "یک مورد انتخاب کن:",
          reply_markup: {
            inline_keyboard: [
              [{ text: "🧃 محصول A", callback_data: "prod_a" }, { text: "🍫 محصول B", callback_data: "prod_b" }],
              [{ text: "⬅️ بازگشت", callback_data: "back_home" }]
            ]
          }
        });

      } else if (text === KB.account || cmd === "whoami") {
        await send(env, chatId, `👤 حساب شما:\nID: ${from.id}\nنام: ${(from.first_name||"") + " " + (from.last_name||"")}`.trim(), {
          reply_markup: REPLY_KB
        });

      } else if (text === KB.ping || cmd === "ping") {
        await send(env, chatId, "pong 🏓", { reply_markup: REPLY_KB });

      } else if (text === KB.time || cmd === "time") {
        await send(env, chatId, `⏰ ${new Date().toISOString()}`, { reply_markup: REPLY_KB });

      } else if (cmd === "echo") {
        // برای سازگاری؛ ترجیحاً کاربر از کیبورد استفاده کند. پیام آزاد هم در انتها echo می‌شود.
        await send(env, chatId, args.length ? args.join(" ") : "چیزی برای echo ندادید.", { reply_markup: REPLY_KB });

      } else if (cmd) {
        // اگر کاربر کامند ناشناس زد
        await send(env, chatId, "این مورد در کیبورد نیست. از دکمه‌های پایین استفاده کن یا " + KB.help + " را بزن.", {
          reply_markup: REPLY_KB
        });

      } else {
        // پیام آزاد → اکو (کیبورد همیشه نمایش داده می‌شود)
        await send(env, chatId, text || "پیام متنی نفرستادی 🙂", { reply_markup: REPLY_KB });
      }

      return new Response("ok");
    }

    return new Response("not found", { status: 404 });
  }
}
```0
