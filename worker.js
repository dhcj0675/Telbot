// worker.js — Telegram bot on Cloudflare Workers
// Features: Reply Keyboard only, 3 products with prices, admin forward via ForceReply
// Vars (Workers → Settings → Variables):
//   BOT_TOKEN (Secret), WH_SECRET (Var or in wrangler.toml), optional TG_SECRET_TOKEN (Secret)

// ========= Admins =========
// ⬇️ آی‌دی عددی ادمین‌ها را اینجا بگذارید. ادمین باید یک‌بار به بات پیام بدهد.
const ADMINS = [6803856798];

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

// ========= Labels (Reply Keyboard) =========
const KB = {
  home: "🏠 خانه",
  help: "ℹ️ راهنما",
  products: "🛒 محصولات",
  account: "👤 حساب",
  ping: "🏓 پینگ",
  time: "⏰ زمان",
  whoami: "🆔 من کیم؟",
  contact: "📩 پیام به ادمین"
};
const REPLY_KB = {
  keyboard: [
    [{ text: KB.home }, { text: KB.help }],
    [{ text: KB.products }, { text: KB.account }],
    [{ text: KB.ping }, { text: KB.time }, { text: KB.whoami }],
    [{ text: KB.contact }]
  ],
  resize_keyboard: true,
  is_persistent: true,
  one_time_keyboard: false,
  input_field_placeholder: "از دکمه‌های پایین انتخاب کن…"
};

// Utility: parse /command (for group compatibility)
function parseCommand(text = "", botUsername = "") {
  if (!text || !text.startsWith("/")) return { cmd: null, args: [] };
  const [first, ...rest] = text.trim().split(/\s+/);
  const [raw, at] = first.split("@");
  if (at && botUsername && at.toLowerCase() !== botUsername.toLowerCase()) return { cmd: null, args: [] };
  return { cmd: raw.slice(1).toLowerCase(), args: rest };
}

// Forward message to all admins with context tag
async function notifyAdmins(env, from, text, tag = "") {
  if (!ADMINS.length) return;
  const who = `${from.first_name || ""} ${from.last_name || ""}`.trim() || "کاربر";
  const header = `📥 پیام جدید ${tag ? `(${tag}) ` : ""}از ${who}\nID: ${from.id}\n\n`;
  for (const adminId of ADMINS) {
    try { await send(env, adminId, header + text); }
    catch(e) { console.error("notify admin failed:", adminId, e); }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Health
    if (request.method === "GET" && url.pathname === "/") {
      return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
    }

    // Webhook
    if (request.method === "POST" && url.pathname === `/webhook/${env.WH_SECRET}`) {
      // Optional Telegram secret header
      const hdr = request.headers.get("X-TeleGRAM-BOT-API-SECRET-TOKEN") || request.headers.get("X-Telegram-Bot-Api-Secret-Token");
      if (env.TG_SECRET_TOKEN && hdr !== env.TG_SECRET_TOKEN) return new Response("forbidden", { status: 403 });

      let update; try { update = await request.json(); } catch { update = null; }

      // ===== Inline callbacks (Products submenu) =====
      if (update?.callback_query) {
        const cq = update.callback_query;
        const chatId = cq.message?.chat?.id;
        const data = cq.data || "";

        if (data === "prod_1") {
          await send(env, chatId, "🧃 محصول ۱ — قیمت: 100,000 تومان ✅", { reply_markup: REPLY_KB });
          // Ask for message to admin about product 1
          await send(env, chatId, "سوالی درباره «محصول ۱» داری؟ پاسخ بده تا برای ادمین ارسال شه. ##ADMIN:prod1##", {
            reply_markup: { force_reply: true, selective: true }
          });
        } else if (data === "prod_2") {
          await send(env, chatId, "🍫 محصول ۲ — قیمت: 175,000 تومان ✅", { reply_markup: REPLY_KB });
          await send(env, chatId, "سوالی درباره «محصول ۲» داری؟ پاسخ بده تا برای ادمین ارسال شه. ##ADMIN:prod2##", {
            reply_markup: { force_reply: true, selective: true }
          });
        } else if (data === "prod_3") {
          await send(env, chatId, "🎁 محصول ۳ — قیمت: 450,000 تومان ✅", { reply_markup: REPLY_KB });
          await send(env, chatId, "سوالی درباره «محصول ۳» داری؟ پاسخ بده تا برای ادمین ارسال شه. ##ADMIN:prod3##", {
            reply_markup: { force_reply: true, selective: true }
          });
        } else if (data === "back_home") {
          await send(env, chatId, "به خانه برگشتی 🏠", { reply_markup: REPLY_KB });
        } else {
          await send(env, chatId, `داده‌ی دکمه: ${data}`, { reply_markup: REPLY_KB });
        }
        await answerCallback(env, cq.id);
        return new Response("ok");
      }

      // ===== Normal messages =====
      const msg = update && (update.message || update.edited_message);
      if (!msg) return new Response("ok");

      const chatId = msg.chat.id;
      const from = msg.from || {};
      const text = msg.text || "";

      // If user replied to a ForceReply we sent, forward to admins with tag
      const repliedText = msg.reply_to_message?.text || "";
      if (repliedText && (repliedText.includes("##ADMIN##") || repliedText.includes("##ADMIN:"))) {
        let tag = "contact";
        const m = repliedText.match(/##ADMIN:([a-z0-9_]+)##?/i);
        if (m) tag = m[1];
        if (text.trim()) {
          await notifyAdmins(env, from, text.trim(), tag);
          await send(env, chatId, "پیام‌ت برای ادمین ارسال شد ✅", { reply_markup: REPLY_KB });
        } else {
          await send(env, chatId, "متن خالیه. دوباره بنویس.", { reply_markup: REPLY_KB });
        }
        return new Response("ok");
      }

      // Optional: support /cmd
      let me = { result: { username: "" } };
      try { me = await tg(env, "getMe", {}); } catch {}
      const { cmd, args } = parseCommand(text, me.result.username);

      // ===== Labels (Reply Keyboard) =====
      const KB = {
        home: "🏠 خانه",
        help: "ℹ️ راهنما",
        products: "🛒 محصولات",
        account: "👤 حساب",
        ping: "🏓 پینگ",
        time: "⏰ زمان",
        whoami: "🆔 من کیم؟",
        contact: "📩 پیام به ادمین"
      };

      if (text === KB.home || cmd === "start") {
        await send(env, chatId, "سلام! ✅ همه گزینه‌ها در کیبورد پایین هست.", { reply_markup: REPLY_KB });

      } else if (text === KB.help || cmd === "help") {
        await send(env, chatId,
          "راهنما:\n" +
          "• " + KB.products + " — دیدن محصولات و پرسیدن سؤال\n" +
          "• " + KB.contact + " — ارسال پیام آزاد به ادمین\n" +
          "• " + KB.account + " — نمایش حساب شما\n" +
          "• " + KB.ping + " — تست زنده بودن\n" +
          "• " + KB.time + " — زمان فعلی UTC\n" +
          "• " + KB.whoami + " — شناسه شما",
          { reply_markup: REPLY_KB }
        );

      } else if (text === KB.products) {
        await send(env, chatId, "لیست محصولات:", { reply_markup: REPLY_KB });
        await tg(env, "sendMessage", {
          chat_id: chatId,
          text: "یک مورد انتخاب کن:",
          reply_markup: {
            inline_keyboard: [
              [{ text: "🧃 محصول ۱ (100k)", callback_data: "prod_1" },
               { text: "🍫 محصول ۲ (175k)", callback_data: "prod_2" }],
              [{ text: "🎁 محصول ۳ (450k)", callback_data: "prod_3" }],
              [{ text: "⬅️ بازگشت", callback_data: "back_home" }]
            ]
          }
        });

      } else if (text === KB.contact) {
        // Free message to admins via ForceReply
        await send(env, chatId, "##ADMIN## لطفاً پیام خود را برای ادمین به‌صورت «پاسخ به همین پیام» ارسال کنید.", {
          reply_markup: { force_reply: true, selective: true }
        });

      } else if (text === KB.account || cmd === "whoami") {
        await send(env, chatId, `👤 حساب شما:\nID: ${from.id}\nنام: ${(from.first_name||"") + " " + (from.last_name||"")}`.trim(), { reply_markup: REPLY_KB });

      } else if (text === KB.ping || cmd === "ping") {
        await send(env, chatId, "pong 🏓", { reply_markup: REPLY_KB });

      } else if (text === KB.time || cmd === "time") {
        await send(env, chatId, `⏰ ${new Date().toISOString()}`, { reply_markup: REPLY_KB });

      } else if (text === KB.whoami) {
        await send(env, chatId, `ID: ${from.id}`, { reply_markup: REPLY_KB });

      } else if (cmd === "echo") {
        await send(env, chatId, args.length ? args.join(" ") : "چیزی برای echo ندادید.", { reply_markup: REPLY_KB });

      } else if (cmd) {
        await send(env, chatId, "این مورد در کیبورد نیست. از دکمه‌های پایین استفاده کن یا ℹ️ راهنما را بزن.", { reply_markup: REPLY_KB });

      } else {
        // Echo for free text; keep keyboard
        await send(env, chatId, text || "پیام متنی نفرستادی 🙂", { reply_markup: REPLY_KB });
      }

      return new Response("ok");
    }

    return new Response("not found", { status: 404 });
  }
}
