// worker.js — Phone Gate + Whitelist (managed in-bot) + Pending list + Health
// نسخه: v1.5.0

/************ تنظیمات ************/
const ADMINS = [6803856798]; // آی‌دی عددی ادمین‌ها

/************ لیبل‌ها و کیبوردها ************/
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

const REPLY_KB_USER = {
  keyboard: [
    [{ text: KB.home }, { text: KB.help }],
    [{ text: KB.products }, { text: KB.account }],
    [{ text: KB.ping }, { text: KB.time }, { text: KB.whoami }],
    [{ text: KB.contact }, { text: KB.sharePhone, request_contact: true }],
  ],
  resize_keyboard: true, is_persistent: true, one_time_keyboard: false,
  input_field_placeholder: "از دکمه‌های پایین انتخاب کن…",
};

const REPLY_KB_ADMIN = {
  keyboard: [
    [{ text: KB.home }, { text: KB.help }],
    [{ text: KB.products }, { text: KB.account }],
    [{ text: KB.ping }, { text: KB.time }, { text: KB.whoami }],
    [{ text: KB.contact }, { text: KB.sharePhone, request_contact: true }],
    // ابزارهای ادمین با کامند هستند (دکمه لیبلی لازم نیست)
  ],
  resize_keyboard: true, is_persistent: true, one_time_keyboard: false,
  input_field_placeholder: "منوی ادمین",
};

const REPLY_KB_CONTACT_ONLY = {
  keyboard: [[{ text: KB.sharePhone, request_contact: true }]],
  resize_keyboard: true, is_persistent: true, one_time_keyboard: false,
  input_field_placeholder: "برای شروع، دکمه «ارسال شماره من» را بزن…",
};

const isAdmin = (id) => ADMINS.includes(id);
const kbFor = (chatId) => (isAdmin(chatId) ? REPLY_KB_ADMIN : REPLY_KB_USER);

// نرمال‌سازی (حذف کاراکترهای نامرئی RTL/LRM)
const norm = (s = "") => s.replace(/[\u200f\u200e\u200d]/g, "").trim();

/************ Telegram helpers ************/
const tg = async (env, method, payload) => {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    console.error("TG", method, r.status, t);
  }
  return r.json().catch(() => ({}));
};
const send = (env, chat_id, text, extra = {}) => tg(env, "sendMessage", { chat_id, text, ...extra });
const answerCallback = (env, id, text = "", show_alert = false) =>
  tg(env, "answerCallbackQuery", { callback_query_id: id, text, show_alert });

/************ KV helpers (users/phones/whitelist) ************/
const userKey       = (id) => `user:${id}`;
const phoneKey      = (id) => `phone:${id}`;
const wlKey         = (id) => `wl:${id}`;
const promptedKey   = (id) => `phone_prompted:${id}`; // اگر خواستی محدودیت یادآوری بذاری

async function trackUserOnce(env, from) {
  if (!env.KV) return;
  try {
    const k = userKey(from.id);
    const had = await env.KV.get(k);
    if (!had) {
      await env.KV.put(k, JSON.stringify({
        id: from.id,
        username: from.username || "",
        first_name: from.first_name || "",
        last_name: from.last_name || "",
        ts: Date.now(),
      }));
    }
  } catch (e) { console.error("KV trackUserOnce", e); }
}

const savePhone        = (env, id, phone) => env.KV?.put(phoneKey(id), phone);
const hasPhone         = async (env, id) => env.KV ? !!(await env.KV.get(phoneKey(id))) : false;

const isWhitelistedKV  = async (env, id) => env.KV ? !!(await env.KV.get(wlKey(id))) : false;
const addWhitelistKV   = (env, id) => env.KV?.put(wlKey(id), "1");
const delWhitelistKV   = (env, id) => env.KV?.delete(wlKey(id));

async function listWhitelistIds(env, limit = 200) {
  if (!env.KV) return [];
  const l = await env.KV.list({ prefix: "wl:" });
  return l.keys.slice(0, limit).map(k => k.name.slice(3));
}

async function listRecentUsers(env, limit = 50) {
  if (!env.KV) return [];
  const l = await env.KV.list({ prefix: "user:" });
  const vals = await Promise.all(l.keys.map(k => env.KV.get(k.name)));
  return vals
    .map(v => { try { return JSON.parse(v || "{}"); } catch { return null; } })
    .filter(Boolean)
    .sort((a,b) => (b.ts||0) - (a.ts||0))
    .slice(0, limit);
}

/************ Admin notify (اختیاری برای دیباگ) ************/
async function notifyAdmins(env, from, text, tag = "") {
  const who = `${from.first_name||""} ${from.last_name||""}`.trim() || "کاربر";
  const head = `📥 ${tag?`(${tag}) `:""}از ${who}${from.username?` (@${from.username})`:""}\nID: ${from.id}\n\n`;
  for (const aid of ADMINS) { try { await send(env, aid, head + text); } catch(e){ console.error("notify", e);} }
}

/************ Callbacks (inline buttons) ************/
async function handleCallback(update, env) {
  const cq = update.callback_query;
  const chatId = cq.message?.chat?.id;
  const data = cq.data || "";

  if (!isAdmin(chatId)) {
    await answerCallback(env, cq.id, "فقط برای ادمین.", true);
    return;
  }

  if (data.startsWith("wl_add:")) {
    const uid = parseInt(data.split(":")[1], 10);
    if (uid) {
      await addWhitelistKV(env, uid);
      await answerCallback(env, cq.id, `Added WL: ${uid}`);
      await send(env, chatId, `✅ کاربر ${uid} به وایت‌لیست اضافه شد.`);
    } else {
      await answerCallback(env, cq.id, "ID نامعتبر", true);
    }
    return;
  }

  if (data.startsWith("wl_del:")) {
    const uid = parseInt(data.split(":")[1], 10);
    if (uid) {
      await delWhitelistKV(env, uid);
      await answerCallback(env, cq.id, `Removed WL: ${uid}`);
      await send(env, chatId, `🗑️ کاربر ${uid} از وایت‌لیست حذف شد.`);
    } else {
      await answerCallback(env, cq.id, "ID نامعتبر", true);
    }
    return;
  }

  await answerCallback(env, cq.id);
}

/************ Messages ************/
async function handleMessage(update, env) {
  const msg = update.message || update.edited_message;
  if (!msg) return;

  const chatId = msg.chat.id;
  const from   = msg.from || {};
  const raw    = msg.text || "";
  const text   = norm(raw);
  const kb     = kbFor(chatId);

  // ثبت کاربر
  trackUserOnce(env, from);

  // دریافت شماره (در هر حالت)
  if (msg.contact && msg.contact.user_id === from.id) {
    const phone = msg.contact.phone_number;
    await savePhone(env, from.id, phone);
    await notifyAdmins(env, from, `شماره کاربر: ${phone}`, "phone");
    await send(env, chatId, "✅ شماره‌ات ثبت شد. خوش آمدی!", { reply_markup: kb });
    return;
  }

  // Phone Gate: تا شماره نداده، مگر اینکه در وایت‌لیست باشد
  if (!isAdmin(from.id) && env.KV) {
    const white = await isWhitelistedKV(env, from.id);
    if (!white) {
      const ok = await hasPhone(env, from.id);
      if (!ok) {
        await send(env, chatId, "برای شروع کار با ربات، لطفاً با دکمه زیر شماره‌ات را بفرست.", { reply_markup: REPLY_KB_CONTACT_ONLY });
        return;
      }
    }
  }

  // ——— Commands پایه
  if (text === "/start") {
    await send(env, chatId, "سلام! ربات فعّاله ✅", { reply_markup: kb });
    return;
  }
  if (text === "/menu") {
    await send(env, chatId, "منو باز شد ✅", { reply_markup: kb });
    return;
  }
  if (text === "/ping" || text === KB.ping) {
    await send(env, chatId, "pong 🏓", { reply_markup: kb });
    return;
  }
  if (text === "/time" || text === KB.time) {
    await send(env, chatId, `⏰ ${new Date().toISOString()}`, { reply_markup: kb });
    return;
  }
  if (text === KB.whoami || text === "/whoami") {
    await send(env, chatId, `👤 ID: ${from.id}`, { reply_markup: kb });
    return;
  }
  if (text === KB.help || text === "/help") {
    await send(env, chatId,
      "راهنما:\n• ارسال شماره من\n• پیام به ادمین (Reply)\n• /menu برای نمایش منو\n• ادمین: /pending , /addwhite , /delwhite , /listwhite",
      { reply_markup: kb }
    );
    return;
  }

  // ——— Admin tools (مدیریت وایت‌لیست)
  if (isAdmin(from.id) && text === "/listwhite") {
    const ids = await listWhitelistIds(env, 200);
    await send(env, chatId, ids.length ? `Whitelist:\n${ids.join("\n")}` : "وایت‌لیست خالی است.");
    return;
  }

  if (isAdmin(from.id) && text.startsWith("/addwhite ")) {
    const uid = parseInt(text.split(/\s+/)[1], 10);
    if (!uid) { await send(env, chatId, "استفاده: /addwhite <user_id>", { reply_markup: kb }); return; }
    await addWhitelistKV(env, uid);
    await send(env, chatId, `✅ کاربر ${uid} به وایت‌لیست اضافه شد.`, { reply_markup: kb });
    return;
  }

  if (isAdmin(from.id) && text.startsWith("/delwhite ")) {
    const uid = parseInt(text.split(/\s+/)[1], 10);
    if (!uid) { await send(env, chatId, "استفاده: /delwhite <user_id>", { reply_markup: kb }); return; }
    await delWhitelistKV(env, uid);
    await send(env, chatId, `🗑️ کاربر ${uid} از وایت‌لیست حذف شد.`, { reply_markup: kb });
    return;
  }

  if (isAdmin(from.id) && text === "/pending") {
    if (!env.KV) { await send(env, chatId, "KV وصل نیست."); return; }
    // آخرین 50 کاربر → فیلتر به کسانی که شماره ندارند (تا 20 مورد)
    const recent = await listRecentUsers(env, 50);
    const pending = [];
    for (const u of recent) {
      const has = await env.KV.get(phoneKey(u.id));
      if (!has) pending.push(u);
      if (pending.length >= 20) break;
    }
    if (!pending.length) {
      await send(env, chatId, "🚀 کاربر بدون شماره در لیست اخیر نداریم.");
      return;
    }
    const lines = pending.map((u,i)=>{
      const name = `${u.first_name||""} ${u.last_name||""}`.trim() || "کاربر";
      const un = u.username ? ` @${u.username}` : "";
      return `${i+1}. ${name}${un} | ID: ${u.id}`;
    }).join("\n");
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: `آخرین استارت‌زده‌ها بدون شماره:\n\n${lines}\n\nروی دکمه‌ها کلیک کن:`,
      reply_markup: {
        inline_keyboard: pending.map(u => ([
          { text: `➕ WL ${u.id}`, callback_data: `wl_add:${u.id}` }
        ]))
      }
    });
    return;
  }

  // ——— پیام به ادمین
  if (text === KB.contact) {
    await send(env, chatId, "##ADMIN## لطفاً پیام‌تان را به صورت Reply به همین پیام بفرستید.", {
      reply_markup: { force_reply: true, selective: true },
    });
    return;
  }
  const repliedText = msg.reply_to_message?.text || "";
  if (repliedText && repliedText.includes("##ADMIN##")) {
    if (text) await notifyAdmins(env, from, text, "contact");
    await send(env, chatId, "پیامت ارسال شد ✅", { reply_markup: kb });
    return;
  }

  // ——— پیش‌فرض: Echo
  await send(env, chatId, `Echo: ${raw}`, { reply_markup: kb });
}

/************ Router ************/
async function handleUpdate(update, env) {
  try {
    if (update?.callback_query) return handleCallback(update, env);
    return handleMessage(update, env);
  } catch (e) { console.error("handleUpdate error:", e); }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Health + Version روی روت
    if (request.method === "GET" && url.pathname === "/") {
      return new Response(JSON.stringify({ ok: true, ver: "v1.5.0" }), {
        headers: { "content-type": "application/json" },
      });
    }

    // Webhook (Fast ACK + optional TG secret token)
    if (request.method === "POST" && url.pathname === `/webhook/${env.WH_SECRET}`) {
      const hdr =
        request.headers.get("X-Telegram-Bot-Api-Secret-Token") ||
        request.headers.get("X-Telegram-BOT-API-SECRET-TOKEN") || "";
      if (env.TG_SECRET_TOKEN && hdr !== env.TG_SECRET_TOKEN)
        return new Response("forbidden", { status: 403 });

      let update = null; try { update = await request.json(); } catch {}
      ctx.waitUntil(handleUpdate(update, env));
      return new Response("ok");
    }

    return new Response("not found", { status: 404 });
  },
};
