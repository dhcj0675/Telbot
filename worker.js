// worker.js — Telegram bot on Cloudflare Workers
// نیاز به Variables در Workers → Settings → Variables:
// BOT_TOKEN (Secret), WH_SECRET (Var یا داخل wrangler.toml)، اختیاری TG_SECRET_TOKEN (Secret)

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

function parseCommand(text = "", botUsername = "") {
  if (!text || !text.startsWith("/")) return { cmd: null, args: [] };
  const [first, ...rest] = text.trim().split(/\s+/);
  const [raw, at] = first.split("@");
  if (at && botUsername && at.toLowerCase() !== botUsername.toLowerCase()) {
    return { cmd: null, args: [] }; // کامند مال یه بات دیگه تو گروهه
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
      // اختیاری: هدر امنیتی تلگرام
      const hdr = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
      if (env.TG_SECRET_TOKEN && hdr !== env.TG_SECRET_TOKEN) return new Response("forbidden", { status: 403 });

      let update; try { update = await request.json(); } catch { update = null; }

      // دکمه‌های Inline
      if (update?.callback_query) {
        const cq = update.callback_query;
        const chatId = cq.message?.chat?.id;
        const data = cq.data || "";
        if (data === "btn_ping") await send(env, chatId, "pong 🏓");
        return new Response("ok");
      }

      const msg = update && (update.message || update.edited_message);
      if (!msg) return new Response("ok");
      const chatId = msg.chat.id;
      const from = msg.from || {};
      const text = msg.text || "";

      // برای پشتیبانی از /cmd@YourBot در گروه‌ها
      let me = { result: { username: "" } };
      try { me = await tg(env, "getMe", {}); } catch {}

      const { cmd, args } = parseCommand(text, me.result.username);

      // ————— روتر کامندها —————
      if (cmd === "start") {
        await send(env, chatId, "سلام! ✅ دستورات: /help /ping /echo /menu /whoami");
      } else if (cmd === "help") {
        await send(env, chatId, "راهنما:\n/start شروع\n/ping تست زنده بودن\n/echo متن — تکرار\n/menu منوی دکمه‌دار\n/whoami شناسه شما");
      } else if (cmd === "ping") {
        await send(env, chatId, "pong 🏓");
      } else if (cmd === "echo") {
        await send(env, chatId, args.length ? args.join(" ") : "چیزی برای echo ندادید.");
      } else if (cmd === "whoami") {
        await send(env, chatId, `ID: ${from.id}\nName: ${(from.first_name||"") + " " + (from.last_name||"")}`.trim());
      } else if (cmd === "menu") {
        await tg(env, "sendMessage", {
          chat_id: chatId,
          text: "منوی نمونه:",
          reply_markup: { inline_keyboard: [[{ text: "
