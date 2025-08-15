// worker.js — KV Cursor Pagination + Pretty Admin Stats (+ phone) + Admin Panel + Phone Gate (ساده)
// نسخه: v2.0.0

/************ تنظیمات ************/
const ADMINS = [6803856798];   // آی‌دی عددی ادمین‌ها
const PAGE_SIZE = 50;          // تعداد ردیف در هر صفحه آمار

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
  adminPanel: "مدیریت ادمین",
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
    [{ text: KB.adminPanel }],
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
const editMessage = (env, chat_id, message_id, text, extra = {}) =>
  tg(env, "editMessageText", { chat_id, message_id, text, ...extra });

/************ KV keys ************/
const userKey   = (id) => `user:${id}`;
const phoneKey  = (id) => `phone:${id}`;
const wlKey     = (id) => `wl:${id}`;
// ایندکس زمانی: ui:<invTs>:<id>  (invTs = 9999999999999 - ts) → مرتب جدیدترین→قدیمی‌ترین
const uiKey     = (invTs, id) => `ui:${invTs}:${id}`;
const uiPrefix  = "ui:";

// استک cursor برای هر ادمین (برای Prev)
const stackKey  = (adminId) => `uistack:${adminId}`; // JSON array از cursorها
const nextKey   = (adminId) => `uinext:${adminId}`;   // آخرین nextCursor

/************ KV helpers (users/phones/whitelist/index) ************/
async function trackUserOnce(env, from) {
  if (!env.KV) return;
  try {
    const k = userKey(from.id);
    const had = await env.KV.get(k);
    const now = Date.now();
    if (!had) {
      await env.KV.put(k, JSON.stringify({
        id: from.id,
        username: from.username || "",
        first_name: from.first_name || "",
        last_name: from.last_name || "",
        ts: now,
      }));
      const inv = (9999999999999 - now).toString().padStart(13, "0");
      await env.KV.put(uiKey(inv, from.id), "1");
    }
  } catch (e) { console.error("KV trackUserOnce", e); }
}

const savePhone       = (env, id, phone) => env.KV?.put(phoneKey(id), phone);
const getPhone        = (env, id) => env.KV ? env.KV.get(phoneKey(id)) : Promise.resolve(null);
const hasPhone        = async (env, id) => env.KV ? !!(await env.KV.get(phoneKey(id))) : false;

const isWhitelistedKV = async (env, id) => env.KV ? !!(await env.KV.get(wlKey(id))) : false;
const addWhitelistKV  = (env, id) => env.KV?.put(wlKey(id), "1");
const delWhitelistKV  = (env, id) => env.KV?.delete(wlKey(id));

async function getCounts(env) {
  if (!env.KV) return { users: 0, phones: 0 };
  const usersList  = await env.KV.list({ prefix: "user:" });
  const phonesList = await env.KV.list({ prefix: "phone:" });
  return { users: usersList.keys.length, phones: phonesList.keys.length };
}

/************ Cursor stack per-admin ************/
async function pushCursor(env, adminId, cursor) {
  if (!env.KV) return;
  const key = stackKey(adminId);
  let arr = [];
  try { arr = JSON.parse(await env.KV.get(key) || "[]"); } catch {}
  arr.push(cursor);
  await env.KV.put(key, JSON.stringify(arr.slice(-50)), { expirationTtl: 3600 });
}
async function popCursor(env, adminId) {
  if (!env.KV) return null;
  const key = stackKey(adminId);
  let arr = [];
  try { arr = JSON.parse(await env.KV.get(key) || "[]"); } catch {}
  const cur = arr.pop() || null;
  await env.KV.put(key, JSON.stringify(arr), { expirationTtl: 3600 });
  return cur;
}
async function clearStack(env, adminId) {
  if (!env.KV) return;
  await env.KV.delete(stackKey(adminId));
}
async function currentIndexFromStack(env, adminId) {
  if (!env.KV) return 0;
  try { const arr = JSON.parse(await env.KV.get(stackKey(adminId)) || "[]"); return Math.max(0, arr.length) * PAGE_SIZE; }
  catch { return 0; }
}
async function stackHasPrev(env, adminId) {
  if (!env.KV) return false;
  try { const arr = JSON.parse(await env.KV.get(stackKey(adminId)) || "[]"); return arr.length > 0; }
  catch { return false; }
}

/************ صفحه‌خوانی ایندکس‌شده ************/
async function pageUsersByIndex(env, cursor = undefined, limit = PAGE_SIZE) {
  if (!env.KV) return { items: [], nextCursor: null, complete: true };
  const resp = await env.KV.list({ prefix: uiPrefix, cursor, limit });
  const items = [];
  for (const k of resp.keys) {
    const parts = k.name.split(":"); // ["ui", invTs, id]
    const id = parts[2];
    let u = null;
    try { u = JSON.parse(await env.KV.get(userKey(id)) || "null"); } catch {}
    items.push({ id, user: u });
  }
  return { items, nextCursor: resp.cursor || null, complete: !!resp.list_complete };
}

/************ CSV (همانند قبل) ************/
function csvOfRows(rows) {
  return rows.map(r => r.map(x => `"${String(x ?? "").replace(/"/g,'""')}"`).join(",")).join("\n");
}
async function buildUsersCSV(env) {
  if (!env.KV) return "id,username,first_name,last_name,ts_iso\n";
  let cursor = undefined;
  const rows = [["id","username","first_name","last_name","ts_iso"]];
  while (true) {
    const { items, nextCursor, complete } = await pageUsersByIndex(env, cursor, 500);
    for (const it of items) {
      const o = it.user || {};
      rows.push([
        o.id ?? it.id ?? "",
        o.username ? `@${o.username}` : "",
        o.first_name || "",
        o.last_name || "",
        o.ts ? new Date(o.ts).toISOString() : "",
      ]);
    }
    if (complete || !nextCursor) break;
    cursor = nextCursor;
  }
  return csvOfRows(rows);
}
async function buildPhonesCSV(env) {
  if (!env.KV) return "id,phone,username,first_name,last_name,ts_iso\n";
  const l = await env.KV.list({ prefix: "phone:" });
  const rows = [["id","phone","username","first_name","last_name","ts_iso"]];
  for (const { name } of l.keys) {
    const id = name.replace("phone:","");
    const phone = await env.KV.get(name);
    let u = {}; try { u = JSON.parse((await env.KV.get(userKey(id))) || "{}"); } catch {}
    rows.push([id, phone||"", u.username?`@${u.username}`:"", u.first_name||"", u.last_name||"", u.ts?new Date(u.ts).toISOString():""]);
  }
  return csvOfRows(rows);
}
async function sendCSVDocument(env, chat_id, filename, csvText, caption = "") {
  const fd = new FormData();
  fd.append("chat_id", String(chat_id));
  fd.append("document", new Blob([csvText], { type: "text/csv; charset=utf-8" }), filename);
  if (caption) fd.append("caption", caption);
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendDocument`, { method: "POST", body: fd });
  if (!r.ok) throw new Error(`sendDocument ${r.status}: ${await r.text()}`);
}

/************ Admin UI ************/
async function showAdminPanel(env, chatId) {
  return tg(env, "sendMessage", {
    chat_id: chatId,
    text: "مدیریت ادمین — یک گزینه را انتخاب کن:",
    reply_markup: {
      inline_keyboard: [
        [{ text: "📊 آمار (صفحه‌بندی)", callback_data: "admin:stats:start" }],
        [{ text: "⬇️ CSV کاربران", callback_data: "admin:csv_users" },
         { text: "⬇️ CSV شماره‌ها", callback_data: "admin:csv_phones" }],
      ],
    },
  });
}

/************ Formatting helpers ************/
const escapeHTML = (s = "") =>
  String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
const pad = (s, len) => {
  s = String(s ?? "");
  if (s.length >= len) return s.slice(0, len);
  return s + " ".repeat(len - s.length);
};

/************ رندر صفحه آمار (جدول زیبا + cursor) ************/
async function renderStatsPage(env, adminId, chatId, cursor = undefined) {
  const { users, phones } = await getCounts(env);
  const { items, nextCursor, complete } = await pageUsersByIndex(env, cursor, PAGE_SIZE);

  const startIdx = await currentIndexFromStack(env, adminId);
  const start = startIdx + 1;
  const end   = startIdx + items.length;

  const header =
    pad("#", 4) + " | " +
    pad("ID", 11) + " | " +
    pad("Name", 22) + " | " +
    pad("@user", 18) + " | " +
    pad("📞 Phone", 16) + " | " +
    pad("Time(ISO)", 20);

  const lines = [header, "-".repeat(header.length)];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const u  = it.user || {};
    const uid = u.id || it.id;
    const idx = startIdx + i + 1;
    const name = `${u.first_name||""} ${u.last_name||""}`.trim() || "کاربر";
    const un   = u.username ? `@${u.username}` : "";
    const ts   = u.ts ? new Date(u.ts).toISOString() : "";
    const ph   = await getPhone(env, uid) || "";

    const row =
      pad(idx, 4) + " | " +
      pad(uid, 11) + " | " +
      pad(name, 22) + " | " +
      pad(un, 18) + " | " +
      pad(ph || "—", 16) + " | " +
      pad(ts, 20);
    lines.push(row);
  }

  const table  = `<pre>${escapeHTML(lines.join("\n"))}</pre>`;
  const footer = `نمایش ${start}-${end}${complete ? "" : " …"} | کل کاربران: ${users} | شماره‌ها: ${phones}`;

  const buttons = [];
  const prevExists = await stackHasPrev(env, adminId);
  if (prevExists) buttons.push({ text: "« قبلی", callback_data: "admin:stats:prev" });
  buttons.push({ text: `${start}-${end}`, callback_data: "noop" });
  if (!complete && nextCursor) buttons.push({ text: "بعدی »", callback_data: "admin:stats:next" });

  // ذخیرهٔ nextCursor برای next
  if (nextCursor) await env.KV.put(nextKey(adminId), nextCursor, { expirationTtl: 600 });
  else await env.KV.delete(nextKey(adminId));

  await tg(env, "sendMessage", {
    chat_id: chatId,
    text: `${table}\n<b>${escapeHTML(footer)}</b>`,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: [buttons, [{ text: "↩️ برگشت به پنل", callback_data: "admin:panel" }]] },
  });
}

/************ Callbacks ************/
async function handleCallback(update, env) {
  const cq = update.callback_query;
  const chatId = cq.message?.chat?.id;
  const data = cq.data || "";

  if (!isAdmin(chatId)) { await answerCallback(env, cq.id, "فقط برای ادمین.", true); return; }

  if (data === "admin:panel") {
    await answerCallback(env, cq.id);
    await showAdminPanel(env, chatId);
    return;
  }

  // آمار: شروع
  if (data === "admin:stats:start") {
    await answerCallback(env, cq.id);
    await clearStack(env, chatId);
    // صفحه اول: cursor undefined
    await renderStatsPage(env, chatId, chatId, undefined);
    return;
  }

  // آمار: بعدی
  if (data === "admin:stats:next") {
    await answerCallback(env, cq.id);
    const next = await env.KV.get(nextKey(chatId));
    if (next) {
      await pushCursor(env, chatId, next);
      await renderStatsPage(env, chatId, chatId, next);
    } else {
      await send(env, chatId, "صفحه بعدی موجود نیست.");
    }
    return;
  }

  // آمار: قبلی
  if (data === "admin:stats:prev") {
    await answerCallback(env, cq.id);
    // صفحه فعلی را کنار بگذار، برگرد به قبل‌تر
    const _discard = await popCursor(env, chatId);
    const prev = await popCursor(env, chatId);
    if (prev) {
      // چون یکی اضافه برداشتیم، prev را دوباره push کنیم تا شاخص درست بماند
      await pushCursor(env, chatId, prev);
      await renderStatsPage(env, chatId, chatId, prev);
    } else {
      await clearStack(env, chatId);
      await renderStatsPage(env, chatId, chatId, undefined);
    }
    return;
  }

  // CSV
  if (data === "admin:csv_users") {
    await answerCallback(env, cq.id);
    try { const csv = await buildUsersCSV(env); await sendCSVDocument(env, chatId, "users.csv", csv, "CSV کاربران"); }
    catch(e){ console.error("csv users", e); await send(env, chatId, "ارسال CSV کاربران با خطا مواجه شد."); }
    return;
  }
  if (data === "admin:csv_phones") {
    await answerCallback(env, cq.id);
    try { const csv = await buildPhonesCSV(env); await sendCSVDocument(env, chatId, "phones.csv", csv, "CSV شماره‌ها"); }
    catch(e){ console.error("csv phones", e); await send(env, chatId, "ارسال CSV شماره‌ها با خطا مواجه شد."); }
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

  // ثبت کاربر + ایندکس
  await trackUserOnce(env, from);

  // دریافت شماره
  if (msg.contact && msg.contact.user_id === from.id) {
    const phone = msg.contact.phone_number;
    await savePhone(env, from.id, phone);
    await send(env, chatId, "✅ شماره‌ات ثبت شد. خوش آمدی!", { reply_markup: kb });
    return;
  }

  // Phone Gate (ساده: اینجا می‌تونی وایت‌لیست هم اضافه کنی اگر خواستی)
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

  // پایه
  if (text === "/start") { await send(env, chatId, "سلام! ربات فعّاله ✅", { reply_markup: kb }); return; }
  if (text === "/menu")  { await send(env, chatId, "منو باز شد ✅", { reply_markup: kb }); return; }
  if (text === KB.ping || text === "/ping") { await send(env, chatId, "pong 🏓", { reply_markup: kb }); return; }
  if (text === KB.time || text === "/time") { await send(env, chatId, `⏰ ${new Date().toISOString()}`, { reply_markup: kb }); return; }
  if (text === KB.whoami || text === "/whoami") { await send(env, chatId, `👤 ID: ${from.id}`, { reply_markup: kb }); return; }
  if (text === KB.help  || text === "/help") {
    await send(env, chatId,
      "راهنما:\n• ارسال شماره من\n• پیام به ادمین (Reply)\n• /menu برای نمایش منو\n• ادمین: دکمه «مدیریت ادمین»",
      { reply_markup: kb }
    ); return;
  }

  // پنل ادمین
  if (isAdmin(from.id) && text === KB.adminPanel) {
    await showAdminPanel(env, chatId);
    return;
  }

  // پیام به ادمین (ساده)
  if (text === KB.contact) {
    await send(env, chatId, "##ADMIN## لطفاً پیام‌تان را به صورت Reply به همین پیام بفرستید.", {
      reply_markup: { force_reply: true, selective: true },
    }); return;
  }
  const repliedText = msg.reply_to_message?.text || "";
  if (repliedText && repliedText.includes("##ADMIN##")) {
    if (text) await send(env, ADMINS[0], `پیام کاربر ${from.id}:\n${text}`);
    await send(env, chatId, "پیامت ارسال شد ✅", { reply_markup: kb });
    return;
  }

  // پیش‌فرض
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

    // Health + Version
    if (request.method === "GET" && url.pathname === "/") {
      return new Response(JSON.stringify({ ok: true, ver: "v2.0.0" }), {
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
