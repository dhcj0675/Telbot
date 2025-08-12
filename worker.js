// worker.js — منوی لیبلی + محصولات + سفارش با حالت مکالمه (نام/آدرس) + آمار ساده (بدون KV)
// Fast ACK

const ADMINS = [6803856798]; // آیدی عددی ادمین‌ها

// ——— Labels
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
  return r.json().catch(() => ({}));
};
const send = (env, chat_id, text, extra = {}) =>
  tg(env, "sendMessage", { chat_id, text, ...extra });
const answerCallback = (env, id, text = "", show_alert = false) =>
  tg(env, "answerCallbackQuery", { callback_query_id: id, text, show_alert });

// ——— محصولات
const PRODUCTS = {
  "1": { title: "محصول ۱", price: "100,000 تومان" },
  "2": { title: "محصول ۲", price: "175,000 تومان" },
  "3": { title: "محصول ۳", price: "450,000 تومان" },
};
const productText = (pid) => {
  const p = PRODUCTS[pid];
  return p ? `${p.title} — قیمت: ${p.price}` : "محصول نامعتبر";
};

// ——— حالت مکالمه سفارش (در حافظه موقتِ اجرا)
const ORDER_STATE = new Map(); // chatId -> { pid, step: 'ask_name'|'ask_address', data:{name,address} }
let MSG_COUNT = 0;
let ORDER_COUNT = 0;

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

async function showProduct(env, chatId, pid) {
  await tg(env, "sendMessage", {
    chat_id: chatId,
    text: productText(pid),
    reply_markup: {
      inline_keyboard: [
        [{ text: "🛒 سفارش این محصول", callback_data: `order_${pid}` }],
        [{ text: "بازگشت", callback_data: "back_home" }],
      ],
    },
  });
}

async function startOrderFlow(env, chatId, pid) {
  ORDER_STATE.set(chatId, { pid, step: "ask_name", data: {} });
  await send(
    env,
    chatId,
    `سفارش «${productText(pid)}»\n\nلطفاً *نام و نام خانوادگی* خود را ارسال کنید.\n(در هر لحظه با /cancel می‌تونی لغو کنی)`,
    { reply_markup: REPLY_KB, parse_mode: "Markdown" }
  );
}

async function handleCallback(update, env) {
  const cq = update.callback_query;
  const chatId = cq.message?.chat?.id;
  const data = cq.data || "";

  if (data.startsWith("prod_")) {
    const pid = data.split("_")[1];
    await showProduct(env, chatId, pid);
  } else if (data.startsWith("order_")) {
    const pid = data.split("_")[1];
    await startOrderFlow(env, chatId, pid);
  } else if (data === "back_home") {
    await send(env, chatId, "به خانه برگشتی.", { reply_markup: REPLY_KB });
  } else {
    await send(env, chatId, `داده دکمه: ${data}`, { reply_markup: REPLY_KB });
  }

  await answerCallback(env, cq.id);
}

async function notifyAdmins(env, text) {
  for (const admin of ADMINS) await send(env, admin, text);
}

async function handleOrderConversation(env, msg, from, chatId, text) {
  const st = ORDER_STATE.get(chatId);
  if (!st) return false;

  if (text === "/cancel") {
    ORDER_STATE.delete(chatId);
    await send(env, chatId, "سفارش لغو شد ❌", { reply_markup: REPLY_KB });
    return true;
  }

  if (st.step === "ask_name") {
    st.data.name = text.trim();
    st.step = "ask_address";
    ORDER_STATE.set(chatId, st);
    await send(env, chatId, "خیلی خوب! حالا *آدرس کامل* رو بفرست:", {
      reply_markup: REPLY_KB,
      parse_mode: "Markdown",
    });
    return true;
  }

  if (st.step === "ask_address") {
    st.data.address = text.trim();
    const pid = st.pid;
    const p = PRODUCTS[pid];
    ORDER_STATE.delete(chatId);
    ORDER_COUNT++;

    // ارسال خلاصه سفارش برای ادمین
    const summary =
      `🧾 سفارش جدید\n` +
      `محصول: ${p ? `${p.title} (${p.price})` : pid}\n\n` +
      `از:\nID: ${from.id}\n` +
      (from.username ? `@${from.username}\n` : "") +
      `نام: ${(from.first_name || "") + " " + (from.last_name || "")}\n\n` +
      `📌 نام مشتری: ${st.data.name}\n` +
      `📍 آدرس: ${st.data.address}`;

    await notifyAdmins(env, summary);
    await send(env, chatId, "سفارش‌ت ثبت شد و برای ادمین ارسال شد ✅", { reply_markup: REPLY_KB });
    return true;
  }

  return false;
}

async function handleMessage(update, env) {
  const msg = update.message || update.edited_message;
  if (!msg) return;

  const chatId = msg.chat.id;
  const from = msg.from || {};
  const text = (msg.text || "").trim();
  MSG_COUNT++;

  // شماره کاربر
  if (msg.contact && msg.contact.user_id === from.id) {
    const phone = msg.contact.phone_number;
    await notifyAdmins(
      env,
      `📥 شمارهٔ کاربر:\nID: ${from.id}\nنام: ${(from.first_name || "") + " " + (from.last_name || "")}\n` +
        (from.username ? `@${from.username}\n` : "") +
        `تلفن: ${phone}`
    );
    await send(env, chatId, "شماره‌ات دریافت شد ✅", { reply_markup: REPLY_KB });
    return;
  }

  // اگر در حالت سفارش هستیم، اول همون رو مدیریت کن
  if (await handleOrderConversation(env, msg, from, chatId, text)) return;

  // دستورات پایه
  if (text === "/start") {
    await send(env, chatId, "سلام! ربات فعّاله ✅", { reply_markup: REPLY_KB });
    return;
  }
  if (text === "/menu") {
    await send(env, chatId, "منو باز شد ✅", { reply_markup: REPLY_KB });
    return;
  }
  if (text === "/cancel") {
    ORDER_STATE.delete(chatId);
    await send(env, chatId, "اگر سفارشی در جریان بود، لغو شد.", { reply_markup: REPLY_KB });
    return;
  }

  // مسیرها
  if (text === KB.home) {
    await send(env, chatId, "صفحهٔ اول.", { reply_markup: REPLY_KB });
    return;
  }
  if (text === KB.help || text === "/help") {
    await send(
      env,
      chatId,
      "راهنما:\n• محصولات → سفارش با نام و آدرس\n• پیام به ادمین با Reply\n• ارسال شماره من\n• /menu برای نمایش منو\n• /cancel لغو سفارش جاری",
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

  // پیام به ادمین: Reply روی پیام خاص
  if (text === KB.contact) {
    await send(env, chatId, "##ADMIN## لطفاً پیام‌تان را به صورت Reply به همین پیام بفرستید.", {
      reply_markup: { force_reply: true, selective: true },
    });
    return;
  }
  const repliedText = msg.reply_to_message?.text || "";
  if (repliedText && repliedText.includes("##ADMIN##")) {
    await notifyAdmins(
      env,
      `📥 پیام کاربر برای ادمین:\nID: ${from.id}\n${from.username ? `@${from.username}\n` : ""}\n` +
        `متن:\n${text}`
    );
    await send(env, chatId, "پیام‌تون برای ادمین ارسال شد ✅", { reply_markup: REPLY_KB });
    return;
  }

  // پیش‌فرض: اکو
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

    // وبهوک تلگرام
    if (request.method === "POST" && url.pathname === `/webhook/${env.WH_SECRET}`) {
      const hdr = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
      if (env.TG_SECRET_TOKEN && hdr !== env.TG_SECRET_TOKEN)
        return new Response("forbidden", { status: 403 });

      let update = null; try { update = await request.json(); } catch {}
      ctx.waitUntil(handleUpdate(update, env)); // پس‌زمینه
      return new Response("ok");               // فوری
    }

    // آمار ساده (فقط برای ادمین — با query ?id=<admin_id>)
    if (request.method === "GET" && url.pathname === "/stats") {
      const id = Number(url.searchParams.get("id") || "0");
      if (!ADMINS.includes(id)) return new Response("forbidden", { status: 403 });
      const body = {
        ok: true,
        since: "since last deploy / hot start",
        messages: MSG_COUNT,
        orders: ORDER_COUNT,
        active_conversations: ORDER_STATE.size,
      };
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    }

    return new Response("not found", { status: 404 });
  },
};
