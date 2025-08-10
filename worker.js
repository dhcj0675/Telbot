// worker.js — Telegram bot on Cloudflare Workers (with /time command)
// Variables needed (Workers → Settings → Variables):
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

const reply = (env, chat_id, text, extra = {}) =>
  tgFetch(env, "sendMessage", { chat_id, text, ...extra });

const answerCallback = (env, callback_query_id, text = "", show_alert = false) =>
  tgFetch(env, "answerCallbackQuery", { callback_query_id, text, show_alert });

function parseCommand(text = "", botUsername = "") {
  if (!text || !text.startsWith("/")) return { command: null, args: [] };
  const [cmdWithAt, ...rest] = text.trim().split(/\s+/);
  const [cmd, at] = cmdWithAt.split("@");
  if (at && botUsername && at.toLowerCase() !== botUsername.toLowerCase()) {
    return { command: null, args: [] }; // command is for another bot (in groups)
  }
  return { command: cmd.slice(1).toLowerCase(), args: rest };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Health check
    if (request.method === "GET" && url.pathname === "/") {
      return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
    }

    // Telegram webhook endpoint
    if (request.method === "POST" && url.pathname === `/webhook/${env.WH_SECRET}`) {
      // Optional security header sent by Telegram when you set secret_token=...
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

      // (optional) support for /cmd@YourBot in groups
      let meUser = { result: { username: "" } };
      try { meUser = await tgFetch(env, "getMe", {}); } catch {}

      const { command, args } = parseCommand(text, meUser.result.username);

      // ————— Command router —————
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
        await reply(env, chatId, `ID شما: ${from.id}\nنام: ${(from.first_name || "") + " " + (from
