// worker.js — Telegram bot on Cloudflare Workers (Reply Keyboard enabled)
// Variables (Workers → Settings → Variables):
// BOT_TOKEN (Secret), WH_SECRET (Var or in wrangler.toml), optional TG_SECRET_TOKEN (Secret)

const tgFetch = async (env, method, payload) => {
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
  tgFetch(env, "sendMessage", { chat_id, text, ...extra });
const answerCallback = (env, callback_query_id, text = "", show_alert = false) =>
  tgFetch(env, "answerCallbackQuery", { callback_query_id, text, show_alert });

// ====== Reply Keyboard layout (می‌تونی برچسب‌ها رو تغییر بدی) ======
const KB = {
  home: "🏠 خانه",
  help: "ℹ️ راهنما",
  products: "🛒 محصولات",
  account: "👤 حساب"
};
const REPLY_KB = {
  keyboard: [
    [{ text: KB.home }, { text: KB.help }],
    [{ text: KB.products }, { text: KB.account }]
  ],
  resize_keyboard: true,       // اندازه مناسب موبایل
  is_persistent: true,         // بعداً هم باقی بمونه
  one_time_keyboard: false,    // یکبار مصرف نباشه
  input_field_placeholder: "یک گزینه انتخاب کن…"
};
const REMOVE_KB = { remove_keyboard: true };

// Parse /command and args (supports /cmd@YourBot in groups)
function parseCommand(text = "", botUsername = "") {
  if (!text || !text.startsWith("/")) return { cmd: null, args: [] };
  const [first, ...rest] = text.trim().split(/\s+/);
  const [raw, at] = first.split("@");
  if (at && botUsername && at.toLowerCase() !== botUsername.toLowerCase()) {
    return { cmd: null, args: [] };
  }
  return { cmd: raw.slice(1).toLowerCase(), args: rest };
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
      // Optional Telegram secret header check
      const hdr = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
      if (env.TG_SECRET_TOKEN && hdr !== env.TG_SECRET_TOKEN) return new Response("forbidden", { status: 403 });

      let update; try { update = await request.json(); } catch { update = null; }

      // Inline keyboard callbacks (نمونه)
      if (update?.callback_query) {
        const cq = update.callback_query;
        const chatId = cq.message?.chat?.id;
        const data = cq.data || "";
        if (data === "btn_ping") {
          await send(env, chatId, "pong 🏓");
          await answerCallback(env, cq.id, "Pong!");
        } else {
          await send(env, chatId, `داده‌ی دکمه: ${data}`);
          await answerCallback(env, cq.id);
        }
        return new Response("ok");
      }

      // Normal messages
      const msg = update && (update.message || update.edited_message);
      if (!msg) return new Response("ok");
      const chatId = msg.chat.id;
      const from = msg.from || {};
      const text = msg.text || "";

      // get bot username (optional, for /cmd@YourBot)
      let me = { result: { username: "" } };
      try { me = await tgFetch(env, "getMe", {}); } catch {}
      const { cmd, args } = parseCommand(text, me.result.username);

      // ====== Command router ======
      if (cmd === "start") {
        await send(env, chatId,
          "سلام! ✅ از دکمه‌های پایین استفاده کن یا دستورات: /help /ping /echo /menu /whoami /time /show /hide",
          { reply_markup: REPLY_KB }
        );
      } else if (cmd === "help") {
        await send(env, chatId,
          "راهنما:\n" +
          "/start شروع + نمایش کیبورد\n" +
          "/show نمایش کیبورد\n" +
          "/hide بستن کیبورد\n" +
          "/ping تست زنده بودن\n" +
          "/echo متن — تکرار\n" +
          "/menu منوی دکمه‌دار (Inline)\n" +
          "/whoami شناسه شما\n" +
          "/time زمان UTC"
        );
      } else if (cmd === "show") {
        await send(env, chatId, "کیبورد روشن شد ✅", { reply_markup: REPLY_KB });
      } else if (cmd === "hide") {
        await send(env, chatId, "کیبورد بسته شد ❌", { reply_markup: REMOVE_KB });
      } else if (cmd === "ping") {
        await send(env, chatId, "pong 🏓");
      } else if (cmd === "echo") {
        await send(env, chatId, args.length ? args.join(" ") : "چیزی برای echo ندادید.");
      } else if (cmd === "whoami") {
        await send(env, chatId, `ID شما: ${from.id}\nنام: ${(from.first_name||"") + " " + (from.last_name||"")}`.trim());
      } else if (cmd === "menu") {
        await tgFetch(env, "sendMessage", {
          chat_id: chatId,
          text: "منوی نمونه (Inline):",
          reply_markup: { inline_keyboard: [[{ text: "Ping", callback_data: "btn_ping" }]] }
        });
      } else if (cmd === "time") {
        const now = new Date().toISOString();
        await send(env, chatId, `⏰ ${now}`);
      } else if (cmd) {
        await send(env, chatId, "این دستور رو نمی‌شناسم. /help");
      } else {
        // ====== Reply Keyboard buttons handling ======
        if (text === KB.home) {
          await send(env, chatId, "به خانه خوش اومدی 🏠", { reply_markup: REPLY_KB });
        } else if (text === KB.help) {
          await send(env, chatId, "این یک ربات نمونه‌ست؛ از دکمه‌ها یا دستورات استفاده کن.", { reply_markup: REPLY_KB });
        } else if (text === KB.products) {
          await send(env, chatId, "لیست محصولات فعلاً نمونه است. 🛒", { reply_markup: REPLY_KB });
        } else if (text === KB.account) {
          await send(env, chatId, `حساب کاربری: ${from.first_name || "کاربر"} 👤`, { reply_markup: REPLY_KB });
        } else {
          // پیام عادی → اکو (کیبورد رو نگه می‌داریم)
          await send(env, chatId, text || "پیام متنی نفرستادی 🙂", { reply_markup: REPLY_KB });
        }
      }
      return new Response("ok");
    }

    return new Response("not found", { status: 404 });
  }
}
