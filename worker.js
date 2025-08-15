// worker.js — KV Cursor Pagination (Newest-first) + Phone Gate + Admin Panel + CSV
// نسخه: v1.9.0
//
// Env Vars/Secrets لازم:
//   BOT_TOKEN (Secret) — الزامی
//   WH_SECRET (Text/vars) — الزامی
//   TG_SECRET_TOKEN (Secret) — اختیاری
//
// نیاز به KV با بایند "KV":
// [[kv_namespaces]]
// binding = "KV"
// id = "YOUR_NAMESPACE_ID"
// preview_id = "YOUR_NAMESPACE_ID"

const ADMINS = [6803856798];  // آیدی عددی ادمین‌ها
const PAGE_SIZE = 20;         // تعداد ردیف در هر صفحه

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

/************ KV keys ************/
const userKey   = (id) => `user:${id}`;
const phoneKey  = (id) => `phone:${id}`;
const wlKey     = (id) => `wl:${id}`;
// ایندکس زمانی برای صفحه‌خوانی: ui:<invTs>:<id>  (invTs = 9999999999999 - ts)
const uiKey     = (invTs, id) => `ui:${invTs}:${id}`;
const uiPrefix  = "ui:";

// استک cursor برای هر ادمین (برای برگشت به صفحه قبلی)
const stackKey  = (adminId) => `uistack:${adminId}`; // JSON array از cursorها با TTL

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
      // ایندکس بر اساس زمان (جدید به قدیم)
      const inv = (9999999999999 - now).toString().padStart(13, "0");
      await env.KV.put(uiKey(inv, from.id), "1");
    } else {
      // اگر خواستی ایندکس را به‌روزرسانی کنی (مثلاً هر بار /start)، می‌تونی حذف/ایجاد کنی.
      // برای سادگی، فقط اولین ثبت را ایندکس می‌کنیم.
    }
  } catch (e) { console.error("KV trackUserOnce", e); }
}

const savePhone       = (env, id, phone) => env.KV?.put(phoneKey(id), phone);
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

/************ Cursor stack per-admin (برای Prev) ************/
async function pushCursor(env, adminId, cursor) {
  if (!env.KV) return;
  const key = stackKey(adminId);
  let arr = [];
  try { arr = JSON.parse(await env.KV.get(key) || "[]"); } catch {}
  arr.push(cursor);
  // TTL کوتاه تا دیتای موقت بمونه
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

/************ صفحه‌خوانی ایندکس‌شده ************/
// برمی‌گرداند: { items: Array<{id, userObj|null}>, nextCursor, complete }
async function pageUsersByIndex(env, cursor = undefined, limit = PAGE_SIZE) {
  if (!env.KV) return { items: [], nextCursor: null, complete: true };
  const resp = await env.KV.list({ prefix: uiPrefix, cursor, limit });
  // هر key مثل ui:INVTS:ID → ID را بکش بیرون و user را بخوان
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

/************ CSV ************/
function csvOfRows(rows) {
  return rows.map(r => r.map(x => `"${String(x ?? "").replace(/"/g,'""')}"`).join(",")).join("\n");
}
async function buildUsersCSV(env) {
  if (!env.KV) return "id,username,first_name,last_name,ts_iso\n";
  // اگر دیتا زیاد است، بهتر است با cursor از ui: پیمایش کنیم
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
        [{ text: "📋 استارت‌زده‌ها بدون شماره", callback_data: "admin:pending" }],
        [{ text: "📝 لیست وایت‌لیست", callback_data: "admin:listwhite" }],
        [{ text: "➕ افزودن با آی‌دی", callback_data: "admin:add_prompt" },
         { text: "🗑️ حذف با آی‌دی",  callback_data: "admin:del_prompt" }],
      ],
    },
  });
}

async function renderStatsPage(env, adminId, chatId, cursor = undefined) {
  const { users, phones } = await getCounts(env);
  const { items, nextCursor, complete } = await pageUsersByIndex(env, cursor, PAGE_SIZE);

  const startIdx = await currentIndexFromStack(env, adminId); // فقط برای نمایش بازه
  const start = startIdx + 1;
  const end   = startIdx + items.length;

  const lines = items.map((it, i) => {
    const u = it.user || {};
    const idx = startIdx + i + 1;
    const name = `${u.first_name||""} ${u.last_name||""}`.trim() || "کاربر";
    const un = u.username ? ` @${u.username}` : "";
    const t = u.ts ? new Date(u.ts).toISOString() : "";
    return `${idx}. ${name}${un} | ID: ${u.id || it.id} | ${t}`;
  }).join("\n") || "—";

  // دکمه‌ها: قبلی/بعدی. برای قبلی از استک استفاده می‌کنیم، برای بعدی cursor جدید را push می‌کنیم.
  const buttons = [];
  const prevExists = await stackHasPrev(env, adminId);
  if (prevExists) buttons.push({ text: "« قبلی", callback_data: "admin:stats:prev" });
  buttons.push({ text: `${start}-${end}${complete ? "" : " …"}`, callback_data: "noop" });
  if (!complete && nextCursor) buttons.push({ text: "بعدی »", callback_data: "admin:stats:next" });

  // اگر nextCursor داریم، موقتاً نگه داریم تا روی "next" استفاده کنیم
  if (nextCursor) {
    await env.KV.put(`uinext:${adminId}`, nextCursor, { expirationTtl: 600 });
  } else {
    await env.KV.delete(`uinext:${adminId}`);
  }

  await tg(env, "sendMessage", {
    chat_id: chatId,
    text: `📊 آمار (جدیدترین‌ها):\nکاربر یکتا: ${users}\nشماره ثبت‌شده: ${phones}\n\n${lines}`,
    reply_markup: { inline_keyboard: [buttons, [{ text: "↩️ برگشت به پنل", callback_data: "admin:panel" }]] },
  });
}

// استک اندیس برای نمایش (هر صفحه PAGE_SIZE ردیف جلو می‌رویم)
async function currentIndexFromStack(env, adminId) {
  if (!env.KV) return 0;
  try {
    const arr = JSON.parse(await env.KV.get(stackKey(adminId)) || "[]");
    return Math.max(0, arr.length) * PAGE_SIZE;
  } catch { return 0; }
}
async function stackHasPrev(env, adminId) {
  if (!env.KV) return false;
  try {
    const arr = JSON.parse(await env.KV.get(stackKey(adminId)) || "[]");
    return arr.length > 0;
  } catch { return false; }
}

/************ Callbacks ************/
async function handleCallback(update, env) {
  const cq = update.callback_query;
  const chatId = cq.message?.chat?.id;
  const data = cq.data || "";

  if (!isAdmin(chatId)) { await answerCallback(env, cq.id, "فقط برای ادمین.", true); return; }

  // برگشت به پنل
  if (data === "admin:panel") {
    await answerCallback(env, cq.id);
    await showAdminPanel(env, chatId);
    return;
  }

  // آمار (صفحه‌بندی با cursor)
  if (data === "admin:stats:start") {
    await answerCallback(env, cq.id);
    await clearStack(env, chatId);                // شروع تازه
    await renderStatsPage(env, chatId, chatId);   // adminId = chatId (چت خصوصی ادمین)
    return;
  }
  if (data === "admin:stats:next") {
    await answerCallback(env, cq.id);
    const next = await env.KV.get(`uinext:${chatId}`);
    if (next) {
      await pushCursor(env, chatId, next);        // برای برگشت، این cursor را استک می‌کنیم
      await renderStatsPage(env, chatId, chatId, next);
    } else {
      await send(env, chatId, "صفحه بعدی موجود نیست.");
    }
    return;
  }
  if (data === "admin:stats:prev") {
    await answerCallback(env, cq.id);
    // برای prev: یک مرحله از استک برگردیم عقب
    const _discard = await popCursor(env, chatId); // صفحه فعلی را کنار بگذار
    const prev = await popCursor(env, chatId);     // cursor صفحه‌ی قبل
    if (prev) {
      // چون pop کردیم، باید دوباره prev را push کنیم تا در index درست بمانیم
      await pushCursor(env, chatId, prev);
      await renderStatsPage(env, chatId, chatId, prev);
    } else {
      await clearStack(env, chatId);
      await renderStatsPage(env, chatId, chatId, undefined); // برگرد به اول
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

  // Pending: آخرین استارت‌زده‌ها بدون شماره (۲۰ تا)
  if (data === "admin:pending") {
    await answerCallback(env, cq.id);
    if (!env.KV) { await send(env, chatId, "KV وصل نیست."); return; }
    const pending = [];
    // از ایندکس (جدید به قدیم) صفحه‌خوانی کوتاه
    let cursor = undefined;
    while (pending.length < 20) {
      const { items, nextCursor, complete } = await pageUsersByIndex(env, cursor, 100);
      for (const it of items) {
        const has = await env.KV.get(phoneKey(it.id));
        if (!has) pending.push(it.user || { id: it.id });
        if (pending.length >= 20) break;
      }
      if (pending.length >= 20 || complete || !nextCursor) break;
      cursor = nextCursor;
    }
    if (!pending.length) { await send(env, chatId, "🚀 کاربر بدون شماره در لیست اخیر نداریم."); return; }
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

  // لیست وایت‌لیست
  if (data === "admin:listwhite") {
    await answerCallback(env, cq.id);
    const l = await env.KV.list({ prefix: "wl:" });
    const ids = l.keys.map(k => k.name.slice(3));
    await send(env, chatId, ids.length ? `Whitelist:\n${ids.join("\n")}` : "وایت‌لیست خالی است.");
    return;
  }

  // افزودن/حذف با آی‌دی (Prompt)
  if (data === "admin:add_prompt") {
    await answerCallback(env, cq.id);
    await send(env, chatId, "##ADMIN:ADDWL##\nآی‌دی عددی کاربر را ریپلای کنید.", {
      reply_markup: { force_reply: true, selective: true },
    });
    return;
  }
  if (data === "admin:del_prompt") {
    await answerCallback(env, cq.id);
    await send(env, chatId, "##ADMIN:DELWL##\nآی‌دی عددی کاربر را ریپلای کنید.", {
      reply_markup: { force_reply: true, selective: true },
    });
    return;
  }

  // دکمه‌های WL
  if (data.startsWith("wl_add:")) {
    const uid = parseInt(data.split(":")[1], 10);
    if (uid) { await addWhitelistKV(env, uid); await answerCallback(env, cq.id, `Added WL: ${uid}`); await send(env, chatId, `✅ کاربر ${uid} به وایت‌لیست اضافه شد.`); }
    else { await answerCallback(env, cq.id, "ID نامعتبر", true); }
    return;
  }
  if (data.startsWith("wl_del:")) {
    const uid = parseInt(data.split(":")[1], 10);
    if (uid) { await delWhitelistKV(env, uid); await answerCallback(env, cq.id, `Removed WL: ${uid}`); await send(env, chatId, `🗑️ کاربر ${uid} از وایت‌لیست حذف شد.`); }
    else { await answerCallback(env, cq.id, "ID نامعتبر", true); }
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

  // ثبت یک‌بار کاربر + ایندکس
  await trackUserOnce(env, from);

  // دریافت شماره
  if (msg.contact && msg.contact.user_id === from.id) {
    const phone = msg.contact.phone_number;
    await savePhone(env, from.id, phone);
    await send(env, chatId, "✅ شماره‌ات ثبت شد. خوش آمدی!", { reply_markup: kb });
    return;
  }

  // Phone Gate
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

  // پاسخ به ریپلای‌های افزودن/حذف دستی WL
  const repliedText = msg.reply_to_message?.text || "";
  if (isAdmin(from.id) && repliedText.includes("##ADMIN:ADDWL##")) {
    const uid = parseInt(text, 10);
    if (!uid) { await send(env, chatId, "آی‌دی نامعتبر است. فقط عدد بفرست."); return; }
    await addWhitelistKV(env, uid);
    await send(env, chatId, `✅ کاربر ${uid} به وایت‌لیست اضافه شد.`);
    return;
  }
  if (isAdmin(from.id) && repliedText.includes("##ADMIN:DELWL##")) {
    const uid = parseInt(text, 10);
    if (!uid) { await send(env, chatId, "آی‌دی نامعتبر است. فقط عدد بفرست."); return; }
    await delWhitelistKV(env, uid);
    await send(env, chatId, `🗑️ کاربر ${uid} از وایت‌لیست حذف شد.`);
    return;
  }

  // پیام به ادمین
  if (text === KB.contact) {
    await send(env, chatId, "##ADMIN## لطفاً پیام‌تان را به صورت Reply به همین پیام بفرستید.", {
      reply_markup: { force_reply: true, selective: true },
    }); return;
  }
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
      return new Response(JSON.stringify({ ok: true, ver: "v1.9.0" }), {
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
