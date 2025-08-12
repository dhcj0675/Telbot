// worker.js — ربات ساده با منوی لیبلی، محصولات، پیام به ادمین (بدون KV)
// Fast ACK: پاسخ فوری به تلگرام و پردازش در پس‌زمینه

const ADMINS = [6803856798]; // آیدی عددی ادمین‌ها

// ——— Labels (دکمه‌ها)
const KB = {
  home: "خانه",
  help: "راهنما",
  products: "محصولات",
  account: "حساب",
  contact: "پیام به ادمین",
  ping: "پینگ",
  time: "زمان",
  whoami: "من کیم",
  sharePhone: "ارسال شماره من",
};

// ——— Reply Keyboard (نمایش پایین چت)
const REPLY_KB = {
  keyboard: [
    [{ text: KB.home }, { text: KB.help }],
    [{ text: KB.products }, { text: KB.account }],
    [{ text: KB.ping }, { text: KB.time }, { text: KB.whoami }],
    [{ text: KB.contact }, { text: KB.sharePhone, request_contact: true }],
  ],
  resize_keyboard: true,
  is_persistent: true,
  one_time_keyboard: false,
  input_field_placeholder: "از دکمه‌های پایین انتخاب کن…",
};

// ——— Telegram helpers
const tg = async (env, method, payload) => {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
  return r.json().catch(() => ({})); // ساده و مقاوم
};
const send = (env, chat_id, text, extra = {}) =>
  tg(env, "sendMessage", { chat_id, text, ...extra });
const answerCallback = (env, id, text = "", show_alert = false) =>
  tg(env, "answerCallbackQuery", { callback_query_id: id, text, show_alert });

// ——— محصولات (اینلاین‌باتن‌ها)
async function showProducts(env, chatId) {
  await tg(env, "sendMessage", {
    chat_id: chatId,
    text: "لیست محصولات:",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "محصول ۱ (100k)", callback_data: "prod_1" },
          { text: "محصول ۲ (175k)", callback_data: "prod_2" },
        ],
        [{ text: "محصول ۳ (450k)", callback_data: "prod_3" }],
        [{ text: "بازگشت", callback_data: "back_home" }],
      ],
    },
  });
}

async function handleCallback(update, env) {
  const cq = update.callback_query;
  const chatId = cq.message?.chat?.id;
  const data = cq.data || "";

  if (data === "prod_1") {
    await send(env, chatId, "محصول ۱ — قیمت: 100,000 تومان", { reply_markup: REPLY_KB });
  } else if (data === "prod_2") {
    await send(env, chatId, "محصول ۲ — قیمت: 175,000 تومان", { reply_markup: REPLY_KB });
  } else if (data === "prod_3") {
    await send(env, chatId, "محصول ۳ — قیمت: 450,000 تومان", { reply_markup: REPLY_KB });
  } else if (data === "back_home") {
    await send(env, chatId, "به خانه برگشتی.", { reply_markup: REPLY_KB });
  } else {
    await send(env, chatId, `داده دکمه: ${data}`, { reply_markup: REPLY_KB });
  }

  await answerCallback(env, cq.id);
}

async function handleMessage(update, env) {
  const msg = update.message || update.edited_message;
  if (!msg) return;

  const chatId = msg.chat.id;
  const from = msg.from || {};
  const text = msg.text || "";

  // دریافت شماره کاربر (به ادمین‌ها اطلاع می‌دهیم و به کاربر تأیید می‌دهیم)
  if (msg.contact && msg.contact.user_id === from.id) {
    const phone = msg.contact.phone_number;
    for (const admin of ADMINS) {
      await send(
        env,
        admin,
        `📥 شمارهٔ کاربر:\nID: ${from.id}\nنام: ${(from.first_name || "") + " " + (from.last_name || "")}\n` +
          (from.username ? `@${from.username}\n` : "") +
          `تلفن: ${phone}`
      );
    }
    await send(env, chatId, "شماره‌ات دریافت شد ✅", { reply_markup: REPLY_KB });
    return;
  }

  // /start → همیشه منو را نشان بده
  if (text === "/start") {
    await send(env, chatId, "سلام! ربات فعّاله ✅", { reply_markup: REPLY_KB });
    return;
  }

  // /menu → باز کردن مجدد منو
  if (text === "/menu") {
    await send(env, chatId, "منو باز شد ✅", { reply_markup: REPLY_KB });
    return;
  }

  // مسیرهای ساده
  if (text === KB.home) {
    await send(env, chatId, "صفحهٔ اول.", { reply_markup: REPLY_KB });
    return;
  }
  if (text === KB.help || text === "/help") {
    await send(
      env,
      chatId,
      "راهنما:\n• محصولات را ببین\n• پیام به ادمین را با Reply بفرست\n• ارسال شماره من برای اشتراک شماره\n• حساب/پینگ/زمان/من کیم هم آماده‌ست",
      { reply_markup: REPLY_KB }
    );
    return;
  }
  if (text === KB.products) {
    await showProducts(env, chatId);
    return;
  }
  if (text === KB.account || text === "/whoami") {
    await send(
      env,
      chatId,
      `👤 حساب شما:\nID: ${from.id}\nنام: ${(from.first_name || "") + " " + (from.last_name || "")}`.trim(),
      { reply_markup: REPLY_KB }
    );
    return;
  }
  if (text === KB.ping || text === "/ping") {
    await send(env, chatId, "pong 🏓", { reply_markup: REPLY_KB });
    return;
  }
  if (text === KB.time || text === "/time") {
    await send(env, chatId, `⏰ ${new Date().toISOString()}`, { reply_markup: REPLY_KB });
    return;
  }
  if (text === KB.whoami) {
    await send(env, chatId, `ID: ${from.id}`, { reply_markup: REPLY_KB });
    return;
  }

  // پیام به ادمین: کاربر باید روی پیام زیر Reply کند
  if (text === KB.contact) {
    await send(env, chatId, "##ADMIN## لطفاً پیام‌تان را به صورت Reply به همین پیام بفرستید.", {
      reply_markup: { force_reply: true, selective: true },
    });
    return;
  }
  const repliedText = msg.reply_to_message?.text || "";
  if (repliedText && repliedText.includes("##ADMIN##")) {
    // ارسال پیام کاربر برای ادمین‌ها + تأیید به خود کاربر
    for (const admin of ADMINS) {
      await send(
        env,
        admin,
        `📥 پیام کاربر برای ادمین:\nID: ${from.id}\n${from.username ? `@${from.username}\n` : ""}\n` +
          `متن:\n${text}`
      );
    }
    await send(env, chatId, "پیام‌تون برای ادمین ارسال شد ✅", { reply_markup: REPLY_KB });
    return;
  }

  // پیش‌فرض: اکو + نمایش منو
  await send(env, chatId, `Echo: ${text}`, { reply_markup: REPLY_KB });
}

async function handleUpdate(update, env) {
  try {
    if (update?.callback_query) return handleCallback(update, env);
    return handleMessage(update, env);
  } catch (e) {
    console.error("handleUpdate error:", e);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // سلامت
    if (request.method === "GET" && url.pathname === "/")
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      });

    // وبهوک تلگرام (Fast ACK)
    if (request.method === "POST" && url.pathname === `/webhook/${env.WH_SECRET}`) {
      const hdr = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
      if (env.TG_SECRET_TOKEN && hdr !== env.TG_SECRET_TOKEN)
        return new Response("forbidden", { status: 403 });

      let update = null;
      try { update = await request.json(); } catch {}
      ctx.waitUntil(handleUpdate(update, env)); // پس‌زمینه
      return new Response("ok");               // فوری
    }

    return new Response("not found", { status: 404 });
  },
};
