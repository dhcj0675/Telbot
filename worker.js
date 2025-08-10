// worker.js — Cloudflare Workers (No credit card)
// Set environment variables in Workers → Settings → Variables:
// BOT_TOKEN, WH_SECRET, (optional) TG_SECRET_TOKEN

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === `/webhook/${env.WH_SECRET}`) {
      // Optional Telegram secret header verification
      const tgHeader = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
      if (env.TG_SECRET_TOKEN && tgHeader !== env.TG_SECRET_TOKEN) {
        return new Response("forbidden", { status: 403 });
      }

      const update = await request.json();
      const message = update.message || update.edited_message || (update.callback_query && update.callback_query.message);
      if (!message) return new Response("ok");

      const chat_id = message.chat.id;
      const text = message.text || "";

      const reply = text.startsWith("/start") ? "سلام از Cloudflare Workers! ✅" : text;

      const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id, text: reply })
      });

      if (!res.ok) {
        const body = await res.text();
        return new Response(`tg error: ${res.status} ${body}`, { status: 500 });
      }
      return new Response("ok");
    }

    if (request.method === "GET" && url.pathname === "/") {
      return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
    }

    return new Response("not found", { status: 404 });
  }
}
