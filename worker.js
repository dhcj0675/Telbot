// worker.js — Bot + CSV + /version  (بدون Termux)
// - Reply Keyboard + محصولات + پیام به ادمین + ارسال شماره
// - CSV: /export/users.csv و /export/phones.csv با secret
// - /version برای تست دیپلوی
// نیازها: BOT_TOKEN (Secret) ، WH_SECRET (vars یا TOML)
// اختیاری: TG_SECRET_TOKEN (Secret)، ADMIN_EXPORT_SECRET (Secret)
// اختیاری برای CSV: KV بایند با نام دقیقاً "KV"

const ADMINS = [6803856798]; // آیدی عددی ادمین‌ها (تو می‌تونی تغییر بدی)
const VERSION = "csv-enabled-1";

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
  // لاگِ خطای تلگرام برای دیباگ
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    console.error("TG", method, r.status, t);
  }
  return r.json().catch(() => ({}));
};
const send = (env, chat_id, text, extra = {}) =>
  tg(env, "sendMessage", { chat_id, text, ...extra });
const answerCallback = (env, id, text = "", show_alert = false) =>
  tg(env, "answerCallbackQuery", { callback_query_id: id, text, show_alert });

const notifyAdmins = async (env, text) => {
  for (const admin of ADMINS) await send(env, admin, text);
};

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
async function startOrder(env, chatId, pid) {
  // سفارش با Reply (بدون state/KV)
  await send(
    env,
    chatId,
    `##ORDER:${pid}##\nبرای ثبت سفارش، نام و توضیحاتت رو روی همین پیام **Reply** کن.\n` +
      `می‌تونی دکمه «${KB.sharePhone}» رو هم بزنی تا شماره‌ات به ادمین برسه.`,
    { reply_markup: REPLY_KB, parse_mode: "Markdown" }
  );
}

// ——— KV helpers برای CSV (ایمن: اگر KV نبود، خطا نمی‌ده)
const hasKV = (env) => !!env.KV;

async function trackUserOnce(env, from) {
  if (!hasKV(env)) return;
  try {
    const key = `user:${from.id}`;
    const had = await env.KV.get(key);
    if (!had) {
      await env.KV.put(
        key,
        JSON.stringify({
          id: from.id,
          username: from.username || "",
          first_name: from.first_name || "",
          last_name: from.last_name || "",
          ts: Date.now(),
        })
      );
    }
  } catch (e) {
    console.error("KV trackUserOnce", e);
  }
}
async function savePhone(env, id, phone) {
  if (!hasKV(env)) return;
  try {
    await env.KV.put(`phone:${id}`, phone);
  } catch (e) {
    console.error("KV savePhone", e);
  }
}
async function buildUsersCSV(env) {
  if (!hasKV(env)) return "id,username,first_name,last_name,ts_iso\n";
  const list = await env.KV.list({ prefix: "user:" });
  const rows = [["id", "username", "first_name", "last_name", "ts_iso"]];
  for (const { name } of list.keys) {
    const v = await env.KV.get(name);
    if (!v) continue;
    let o; try { o = JSON.parse(v); } catch { continue; }
    rows.push([
      o.id ?? "",
      o.username ? `@${o.username}` : "",
      o.first_name ?? "",
      o.last_name ?? "",
      o.ts ? new Date(o.ts).toISOString() : "",
    ]);
  }
  return rows.map(r => r.map(x => `"${String(x).replace(/"/g,'""')}"`).join(",")).join("\n");
}
async function buildPhonesCSV(env) {
  if (!hasKV(env)) return "id,phone,username,first_name,last_name,ts_iso\n";
  const list = await env.KV.list({ prefix: "phone:" });
  const rows = [["id", "phone", "username", "first_name", "last_name", "ts_iso"]];
  for (const { name } of list.keys) {
    const id = name.replace("phone:", "");
    const phone = await env.KV.get(name);
    let u = {};
    try { u = JSON.parse((await env.KV.get(`user:${id}`)) || "{}"); } catch {}
    rows.push([
      id,
      phone ?? "",
      u.username ? `@${u.username}` : "",
      u.first_name ?? "",
      u.last_name ?? "",
      u.ts ? new Date(u.ts).toISOString() : "",
    ]);
  }
  return rows.map(r => r.map(x => `"${String(x).replace(/"/g,'""')}"`).join(",")).join("\n");
}

// ——— Callbacks
async function handleCallback(update, env) {
  const cq = update.callback_query;
  const chatId = cq.message?.chat?.id;
  const data = cq.data || "";

  if (data.startsWith("prod_")) {
    const pid = data.split("_")[1];
    await showProduct(env, chatId, pid);
  } else if (data.startsWith("order_")) {
    const pid = data.split("_")[1];
    await startOrder(env, chatId, pid);
  } else if (data === "back_home") {
    await send(env, chatId, "به خانه برگشتی.", { reply_markup: REPLY_KB });
  } else {
    await send(env, chatId, `داده دکمه: ${data}`, { reply_markup: REPLY_KB });
  }

  await answerCallback(env, cq.id);
}

// ——— Messages
async function handleMessage(update, env) {
  const msg = update.message || update.edited_message;
  if (!msg) return;

  const chatId = msg.chat.id;
  const from = msg.from || {};
  const text = (msg.text || "").trim();

  // ثبت کاربر برای CSV (یک‌بار)
  if (from?.id) trackUserOnce(env, from);

  // دریافت شماره
  if (msg.contact && msg.contact.user_id === from.id) {
    const phone = msg.contact.phone_number;
    await savePhone(env, from.id, phone);
    await notifyAdmins(
      env,
      `📥 شمارهٔ کاربر:\nID: ${from.id}\nنام: ${(from.first_name || "") + " " + (from.last_name || "")}\n` +
      (from.username ? `@${from.username}\n` : "") +
      `تلفن: ${phone}`
    );
    await send(env, chatId, "شماره‌ات دریافت شد ✅", { reply_markup: REPLY_KB });
    return;
  }

  // پایه
  if (text === "/start") {
    await send(env, chatId, "سلام! ربات فعّاله ✅", { reply_markup: REPLY_KB });
    return;
  }
  if (text === "/menu") {
    await send(env, chatId, "منو باز شد ✅", { reply_markup: REPLY_KB });
    return;
  }

  // مسیرها
  if (text === KB.home) return send(env, chatId, "صفحهٔ اول.", { reply_markup: REPLY_KB });
  if (text === KB.help || text === "/help")
    return send(
      env,
      chatId,
      "راهنما:\n• محصولات → سفارش با Reply\n• پیام به ادمین با Reply\n• ارسال شماره من\n• /menu برای نمایش منو",
      { reply_markup: REPLY_KB }
    );
  if (text === KB.products) return showProducts(env, chatId);
  if (text === KB.account || text === "/whoami")
    return send(
      env,
      chatId,
      `👤 حساب شما:\nID: ${from.id}\nنام: ${(from.first_name || "") + " " + (from.last_name || "")}`.trim(),
      { reply_markup: REPLY_KB }
    );
  if (text === KB.ping || text === "/ping") return send(env, chatId, "pong 🏓", { reply_markup: REPLY_KB });
  if (text === KB.time || text === "/time") return send(env, chatId, `⏰ ${new Date().toISOString()}`, { reply_markup: REPLY_KB });
  if (text === KB.whoami) return send(env, chatId, `ID: ${from.id}`, { reply_markup: REPLY_KB });

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
  if (repliedText && repliedText.includes("##ORDER:")) {
    const m = repliedText.match(/##ORDER:(\d+)##/);
    const pid = m?.[1] || "?";
    const p = PRODUCTS[pid] ? `${PRODUCTS[pid].title} (${PRODUCTS[pid].price})` : `محصول ${pid}`;
    await notifyAdmins(
      env,
      `🧾 سفارش جدید:\nمحصول: ${p}\n\nاز:\nID: ${from.id}\n` +
      (from.username ? `@${from.username}\n` : "") +
      `نام: ${(from.first_name || "") + " " + (from.last_name || "")}\n\n` +
      `متن کاربر:\n${text}`
    );
    await send(env, chatId, "سفارش‌ت ثبت و برای ادمین ارسال شد ✅", { reply_markup: REPLY_KB });
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

    // ——— /version برای تست سریع
    if (request.method === "GET" && url.pathname === "/version") {
      return new Response(JSON.stringify({ ok: true, version: VERSION }), {
        headers: { "content-type": "application/json" },
      });
    }

    // ——— CSV endpoints (قبل از not found)
    const exportSecret = env.ADMIN_EXPORT_SECRET || env.WH_SECRET;

    if (request.method === "GET" && url.pathname === "/export/users.csv") {
      if (!exportSecret || url.searchParams.get("secret") !== exportSecret)
        return new Response("forbidden", { status: 403 });
      const csv = await buildUsersCSV(env);
      return new Response(csv, {
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": 'attachment; filename="users.csv"',
        },
      });
    }

    if (request.method === "GET" && url.pathname === "/export/phones.csv") {
      if (!exportSecret || url.searchParams.get("secret") !== exportSecret)
        return new Response("forbidden", { status: 403 });
      const csv = await buildPhonesCSV(env);
      return new Response(csv, {
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": 'attachment; filename="phones.csv"',
        },
      });
    }

    // ——— Webhook تلگرام (Fast ACK)
    if (request.method === "POST" && url.pathname === `/webhook/${env.WH_SECRET}`) {
      // اگر TG_SECRET_TOKEN ست شده، هدر باید بخوره
      const hdr =
        request.headers.get("X-Telegram-Bot-Api-Secret-Token") ||
        request.headers.get("X-Telegram-BOT-API-SECRET-TOKEN") ||
        "";
      if (env.TG_SECRET_TOKEN && hdr !== env.TG_SECRET_TOKEN)
        return new Response("forbidden", { status: 403 });

      let update = null; try { update = await request.json(); } catch {}
      ctx.waitUntil(handleUpdate(update, env)); // پردازش در پس‌زمینه
      return new Response("ok");               // پاسخ فوری
    }

    // ——— Health (اختیاری)
    if (request.method === "GET" && url.pathname === "/") {
      return new Response(JSON.stringify({ ok: true, version: VERSION }), {
        headers: { "content-type": "application/json" },
      });
    }

    // ——— سایر مسیرها
    return new Response("not found", { status: 404 });
  },
};
