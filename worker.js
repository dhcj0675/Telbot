// worker.js — ربات تلگرام مینیمال (Fast ACK)

const KB = {
  startOk: "سلام! ربات فعّاله ✅",
};

async function tg(env, method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload || {})
  });
  // عمداً خطا نمی‌گیریم که ساده بماند
  return res.json().catch(()=> ({}));
}

async function handleUpdate(update, env) {
  const msg = update.message || update.edited_message;
  if (!msg) return;

  const chatId = msg.chat.id;
  const text = msg.text || "";

  if (text === "/start") {
    await tg(env, "sendMessage", { chat_id: chatId, text: KB.startOk });
    return;
  }

  // ساده‌ترین رفتار: اکو
  await tg(env, "sendMessage", { chat_id: chatId, text: `Echo: ${text}` });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // برای تست سلامت
    if (request.method === "GET" && url.pathname === "/")
      return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });

    // وبهوک تلگرام
    if (request.method === "POST" && url.pathname === `/webhook/${env.WH_SECRET}`) {
      // اگر TG_SECRET_TOKEN ست شده باشد، هدر باید مطابق باشد
      const hdr = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
      if (env.TG_SECRET_TOKEN && hdr !== env.TG_SECRET_TOKEN)
        return new Response("forbidden", { status: 403 });

      let update = null;
      try { update = await request.json(); } catch {}
      ctx.waitUntil(handleUpdate(update, env)); // پردازش در پس‌زمینه
      return new Response("ok");               // پاسخ فوری به تلگرام (جلوگیری از timeout)
    }

    return new Response("not found", { status: 404 });
  }
}
