// worker.js — Telegram bot on Cloudflare Workers (no 'hello world')
// Required Variables (Workers → Settings → Variables):
//   BOT_TOKEN (Secret) — Telegram bot token from BotFather
//   WH_SECRET (Var or in wrangler.toml) — your hidden path segment for the webhook
// Optional:
//   TG_SECRET_TOKEN (Secret) — if you pass &secret_token=... in setWebhook, we'll verify the header

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

const reply = (env, chat_id, text, extra = {}) =>
  tgFetch(env, "sendMessage", { chat_id, text, ...extra });

const answerCallback = (env, callback_query_id, text = "", show_alert = false) =>
  tgFetch(env, "answerCallbackQuery", { callback_query_id, text, show_alert });

function parseCommand(text = "", botUsername = "") {
  if (!text || !text.startsWith("/")) return { command: null, args: [] };
  const [cmdWithAt, ...rest] = text.trim().split(/\s+/);
  const [cmd, at] = cmdWithAt.split("@");
  if (at && botUsername && at.toLowerCase() !== botUsername.toLowerCase()) {
    return { command: null, args: [] }; // command addressed to another bot (group chats)
  }
  return { command: cmd.slice(1).toLowerCase(), args: rest };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Health check (so root doesn't say "hello world")
    if (request.method === "GET" && url.pathname === "/") {
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" }
      });
    }

    // Telegram Webhook endpoint: POST /webhook/<WH_SECRET>
    if (request.method === "POST" && url.pathname === `/webhook/${env.WH_SECRET}`) {
      // Optional header verification — only enforced if TG_SECRET_TOKEN is set
      const tgHeader = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
      if (env.TG_SECRET_TOKEN && tgHeader !== env.TG_SECRET_TOKEN) {
        return new Response("forbidden", { status: 403 });
      }

      let update;
      try { update = await request.json(); } catch { update = null; }

      // Handle inline keyboard callbacks
      if (update && update.callback_query) {
        const cq = update.callback_query;
        const chatId = cq.message?.chat?.id;
        const data = cq.data || "";
        if (data === "btn_ping") {
          await reply(env, chatId, "pong 🏓");
          await answerCallback(env, cq.id, "Pong!");
        } else {
          await reply(env, chatId, `داده‌ی دکمه: ${data}`);
          await answerCallback(env, cq.id);
        }
        return new Response("ok");
      }

      // Handle normal messages
      const msg = update && (update.message || update.edited_message);
      if (!msg) return new Response("ok");
      const chatId = msg.chat.id;
      const from = msg.from || {};
      const text = msg.text || "";

      // Support /cmd@YourBot in groups
      let meUser = { result: { username: "" } };
      try { meUser = await tgFetch(env, "getMe", {}); } catch {}

      const { command, args } = parseCommand(text, meUser.result.username);

      // Command router
      if (command === "start") {
        await reply(env, chatId, "سلام! ✅ دستورات: /help /ping /echo /menu /whoami /time");
      } else if (command === "help") {
        await reply(env, chatId, "راهنما:\n/start شروع\n/ping تست زنده بودن\n/echo متن — تکرار\n/menu منوی دکمه‌دار\n/whoami شناسه شما\n/time زمان به‌صورت UTC");
      } else if (command === "ping") {
        await reply(env, chatId, "pong 🏓");
      } else if (command === "echo") {
        const out = args.length ? args.join(" ") : "چیزی برای echo ندادید.";
        await reply(env, chatId, out);
      } else if (command === "whoami") {
        await reply(env, chatId, `ID شما: ${from.id}\nنام: ${(from.first_name || "") + " " + (from.last_name || "")}`.trim());
      } else if (command === "menu") {
        await tgFetch(env, "sendMessage", {
          chat_id: chatId,
          text: "منوی نمونه:",
          reply_markup: {
            inline_keyboard: [
              [{ text: "Ping", callback_data: "btn_ping" }],
              [{ text: "وب‌سایت تلگرام", url: "https://telegram.org" }]
            ]
          }
        });
      } else if (command === "time") {
        const now = new Date().toISOString();
        await reply(env, chatId, `⏰ ${now}`);
      } else if (command) {
        await reply(env, chatId, "این دستور رو نمی‌شناسم. /help");
      } else {
        // Free text → echo
        await reply(env, chatId, text || "پیام متنی نفرستادی 🙂");
      }
      return new Response("ok");
    }

    return new Response("not found", { status: 404 });
  }
}
