// worker.js — مینیمال و مطمئن

const ADMINS = [6803856798]; // آیدی عددی خودت (ادمین)

const KB = {
  home: "خانه",
  help: "راهنما",
  ping: "پینگ"
};

const REPLY_KB = {
  keyboard: [[{text: KB.home}, {text: KB.help}], [{text: KB.ping}]],
  resize_keyboard: true, is_persistent: true
};

const tg = async (env, method, payload) => {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: {"content-type":"application/json"},
    body: JSON.stringify(payload||{})
  });
  return r.json();
};

const send = (env, chat_id, text, extra={}) =>
  tg(env, "sendMessage", { chat_id, text, ...extra });

async function handleUpdate(update, env) {
  try {
    const msg = update.message || update.edited_message;
    if (!msg) return;
    const chatId = msg.chat.id;
    const text = msg.text || "";

    if (text === "/start") {
      await send(env, chatId, "سلام! ربات فعاله ✅", { reply_markup: REPLY_KB });
      return;
    }
    if (text === KB.help || text === "/help") {
      await send(env, chatId, "راهنما: با /start شروع کن. دکمه‌ها رو بزن.", { reply_markup: REPLY_KB });
      return;
    }
    if (text === KB.ping || text === "/ping") {
      await send(env, chatId, "pong 🏓", { reply_markup: REPLY_KB });
      return;
    }
    await send(env, chatId, "پیامت رسید ✅", { reply_markup: REPLY_KB });
  } catch (e) {
    console.error(e);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // سلامت
    if (request.method === "GET" && url.pathname === "/")
      return new Response(JSON.stringify({ok:true}), {headers:{"content-type":"application/json"}});

    // وبهوک
    if (request.method === "POST" && url.pathname === `/webhook/${env.WH_SECRET}`) {
      // اگر TG_SECRET_TOKEN ست شده، هدر باید بخوره
      const hdr = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
      if (env.TG_SECRET_TOKEN && hdr !== env.TG_SECRET_TOKEN)
        return new Response("forbidden", {status:403});

      let update=null; try { update = await request.json(); } catch {}
      ctx.waitUntil(handleUpdate(update, env));
      return new Response("ok");
    }

    return new Response("not found", {status:404});
  }
}
