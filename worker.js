// worker.js — Phone Gate + Admin Stats + CSV + Health
// نسخه: v1.4.0
// نیازها: BOT_TOKEN (Secret) ، WH_SECRET (Var یا TOML)
// اختیاری: TG_SECRET_TOKEN (Secret) ، ADMIN_EXPORT_SECRET (Secret)
// برای CSV و Phone Gate: بایند KV با نام "KV" در wrangler.toml
//
// wrangler.toml نمونه برای KV:
// [[kv_namespaces]]
// binding = "KV"
// id = "YOUR_NAMESPACE_ID"
// preview_id = "YOUR_NAMESPACE_ID"

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
  stats: "آمار (ادمین)", // مخصوص ادمین
};

// ——— Keyboards
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
    [{ text: KB.stats }],
  ],
  resize_keyboard: true, is_persistent: true, one_time_keyboard: false,
  input_field_placeholder: "منوی ادمین",
};

// کیبورد مخصوص درخواست شماره (Phone Gate)
const REPLY_KB_CONTACT_ONLY = {
  keyboard: [[{ text: KB.sharePhone, request_contact: true }]],
  resize_keyboard: true,
  is_persistent: true,
  one_time_keyboard: false,
  input_field_placeholder: "برای شروع، دکمه «ارسال شماره من» را بزن…"
};

const isAdmin = (id) => ADMINS.includes(id);
const kbFor = (chatId) => (isAdmin(chatId) ? REPLY_KB_ADMIN : REPLY_KB_USER);

// نرمال‌سازی متن (حذف کاراکترهای نامرئی RTL/LRM)
const norm = (s = "") => s.replace(/[\u200f\u200e\u200d]/g, "").trim();

// ——— Telegram helpers
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

const notifyAdminsText = async (env, text) => { for (const a of ADMINS) await send(env, a, text); };
const notifyAdmins = async (env, from, text, tag = "") => {
  const who = `${from.first_name||""} ${from.last_name||""}`.trim() || "کاربر";
  const head = `📥 ${tag?`(${tag}) `:""}از ${who}${from.username?` (@${from.username})`:""}\nID: ${from.id}\n\n`;
  await notifyAdminsText(env, head + text);
};

// ——— KV helpers (users/phones/CSV)
async function trackUserOnce(env, from) {
  if (!env.KV) return;
  try {
    const k = `user:${from.id}`;
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
const savePhone = (env, id, phone) => env.KV?.put(`phone:${id}`, phone);
const hasPhone = async (env, id) => env.KV ? !!(await env.KV.get(`phone:${id}`)) : false;

const listUserKeys   = (env) => env.KV.list({ prefix: "user:" });
const listPhoneKeys  = (env) => env.KV.list({ prefix: "phone:" });
const getUserCount   = async (env) => env.KV ? (await listUserKeys(env)).keys.length : 0;
const getPhonesCount = async (env) => env.KV ? (await listPhoneKeys(env)).keys.length : 0;

async function getLastUsers(env, limit = 10) {
  if (!env.KV) return [];
  const l = await listUserKeys(env);
  const vals = await Promise.all(l.keys.map(k => env.KV.get(k.name)));
  const arr = vals.map(v => { try { return JSON.parse(v || "{}"); } catch { return null; } })
                  .filter(Boolean)
                  .sort((a,b) => (b.ts||0)-(a.ts||0))
                  .slice(0, limit);
  return arr;
}

function csvOfRows(rows) {
  return rows.map(r => r.map(x => `"${String(x ?? "").replace(/"/g,'""')}"`).join(",")).join("\n");
}
async function buildUsersCSV(env) {
  if (!env.KV) return "id,username,first_name,last_name,ts_iso\n";
  const l = await listUserKeys(env);
  const vals = await Promise.all(l.keys.map(k => env.KV.get(k.name)));
  const rows = [["id","username","first_name","last_name","ts_iso"]];
  for (const v of vals) {
    if (!v) continue;
    let o; try { o = JSON.parse(v); } catch { continue; }
    rows.push([o.id ?? "", o.username?`@${o.username}`:"", o.first_name||"", o.last_name||"", o.ts?new Date(o.ts).toISOString():""]);
  }
  return csvOfRows(rows);
}
async function buildPhonesCSV(env) {
  if (!env.KV) return "id,phone,username,first_name,last_name,ts_iso\n";
  const l = await listPhoneKeys(env);
  const rows = [["id","phone","username","first_name","last_name","ts_iso"]];
  for (const { name } of l.keys) {
    const id = name.replace("phone:","");
    const phone = await env.KV.get(name);
    let u = {}; try { u = JSON.parse((await env.KV.get(`user:${id}`)) || "{}"); } catch {}
    rows.push([id, phone||"", u.username?`@${u.username}`:"", u.first_name||"", u.last_name||"", u.ts?new Date(u.ts).toISOString():""]);
  }
  return csvOfRows(rows);
}

// ارسال CSV به‌صورت فایل تلگرامی
async function sendCSVDocument(env, chat_id, filename, csvText, caption = "") {
  const fd = new FormData();
  fd.append("chat_id", String(chat_id));
  fd.append("document", new Blob([csvText], { type: "text/csv; charset=utf-8" }), filename);
  if (caption) fd.append("caption", caption);
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendDocument`, { method: "POST", body: fd });
  if (!r.ok) throw new Error(`sendDocument ${r.status}: ${await r.text()}`);
}

// ——— Core handlers
async function handleMessage(update, env) {
  const msg = update.message || update.edited_message;
  if (!msg) return;

  const chatId = msg.chat.id;
  const from   = msg.from || {};
  const raw    = msg.text || "";
  const text   = norm(raw);

  // ثبت یک‌بار کاربر
  trackUserOnce(env, from);

  // ======= Phone Gate: غیرادمین‌ها تا شماره ندهند، منو ندارند =======
  if (!isAdmin(from.id) && env.KV) {
    // اگر همین الآن شماره فرستاد
    if (msg.contact && msg.contact.user_id === from.id) {
      const phone = msg.contact.phone_number;
      await savePhone(env, from.id, phone);
      await notifyAdmins(env, from, `شماره کاربر: ${phone}`, "phone");
      await send(env, chatId, "✅ شماره‌ات ثبت شد. خوش آمدی! منو فعال شد.", { reply_markup: kbFor(chatId) });
      return;
    }

    // اگر هنوز شماره ثبت نشده
    const ok = await hasPhone(env, from.id);
    if (!ok) {
      await send(env, chatId, "برای شروع کار با ربات، لطفاً با دکمه زیر شماره‌ات را بفرست.", { reply_markup: REPLY_KB_CONTACT_ONLY });
      return;
    }
  }
  // ======= پایان Phone Gate =======

  const kb = kbFor(chatId);

  // دریافت شماره (بعد از عبور از گیت هم بماند)
  if (msg.contact && msg.contact.user_id === from.id) {
    const phone = msg.contact.phone_number;
    await savePhone(env, from.id, phone);
    await notifyAdmins(env, from, `شماره کاربر: ${phone}`, "phone");
    await send(env, chatId, "شماره‌ات دریافت شد ✅", { reply_markup: kb });
    return;
  }

  // دستورات پایه
  if (text === "/start") {
    await send(env, chatId, "سلام! ربات فعّاله ✅", { reply_markup: kb });
    return;
  }
  if (text === "/menu") {
    await send(env, chatId, "منو باز شد ✅", { reply_markup: kb });
    return;
  }

  // آمار (ادمین)
  if (isAdmin(from.id) && (text === KB.stats || text === "/stats" || text.toLowerCase() === "stats" || text.startsWith("آمار"))) {
    if (!env.KV) {
      await send(env, chatId, "KV وصل نیست.", { reply_markup: kb });
    } else {
      const users  = await getUserCount(env);
      const phones = await getPhonesCount(env);
      const last   = await getLastUsers(env, 10);
      const lines  = last.map((u,i)=>{
        const name = `${u.first_name||""} ${u.last_name||""}`.trim() || "کاربر";
        const un   = u.username?` @${u.username}`:"";
        const t    = u.ts?new Date(u.ts).toISOString():"";
        return `${i+1}. ${name}${un} | ID: ${u.id} | ${t}`;
      }).join("\n") || "—";

      await send(env, chatId, `📊 آمار:\nکاربر یکتا: ${users}\nشماره ثبت‌شده: ${phones}\n\nآخرین ۱۰ کاربر:\n${lines}`, { reply_markup: kb });

      // ارسال CSV‌ها به‌صورت فایل
      try {
        const csvU = await buildUsersCSV(env);
        await sendCSVDocument(env, chatId, "users.csv", csvU, "CSV کاربران");
        const csvP = await buildPhonesCSV(env);
        await sendCSVDocument(env, chatId, "phones.csv", csvP, "CSV شماره‌ها");
      } catch (e) {
        console.error("CSV send error:", e);
        await send(env, chatId, "ارسال CSV با خطا مواجه شد.", { reply_markup: kb });
      }
    }
    return;
  }

  // منوها
  if (text === KB.home)   return send(env, chatId, "صفحهٔ اول.", { reply_markup: kb });
  if (text === KB.help)   return send(env, chatId, "راهنما:\n• محصولات\n• پیام به ادمین (Reply)\n• ارسال شماره من\n• /menu", { reply_markup: kb });
  if (text === KB.products) return send(env, chatId, "لیست محصولات به‌زودی…", { reply_markup: kb });
  if (text === KB.account || text === "/whoami")
    return send(env, chatId, `👤 حساب شما:\nID: ${from.id}\nنام: ${(from.first_name||"") + " " + (from.last_name||"")}`.trim(), { reply_markup: kb });
  if (text === KB.ping || text === "/ping") return send(env, chatId, "pong 🏓", { reply_markup: kb });
  if (text === KB.time || text === "/time") return send(env, chatId, `⏰ ${new Date().toISOString()}`, { reply_markup: kb });
  if (text === KB.whoami) return send(env, chatId, `ID: ${from.id}`, { reply_markup: kb });

  // پیام به ادمین (با Reply)
  if (text === KB.contact) {
    await send(env, chatId, "##ADMIN## لطفاً پیام‌تان را به صورت Reply به همین پیام بفرستید.", {
      reply_markup: { force_reply: true, selective: true }
    });
    return;
  }
  const repliedText = msg.reply_to_message?.text || "";
  if (repliedText && repliedText.includes("##ADMIN##")) {
    if (text) await notifyAdmins(env, from, text, "contact");
    await send(env, chatId, "پیامت ارسال شد ✅", { reply_markup: kb });
    return;
  }

  // پیش‌فرض: Echo
  await send(env, chatId, `Echo: ${raw}`, { reply_markup: kb });
}

async function handleUpdate(update, env) {
  try {
    if (update?.callback_query) {
      await answerCallback(env, update.callback_query.id);
      return;
    }
    return handleMessage(update, env);
  } catch (e) { console.error("handleUpdate error:", e); }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Health (نسخه روی / نشان داده می‌شود)
    if (request.method === "GET" && url.pathname === "/") {
      return new Response(JSON.stringify({ ok: true, ver: "v1.4.0" }), {
        headers: { "content-type": "application/json" }
      });
    }

    // CSV endpoints (اختیاری: اگر فقط لینک دانلود از بیرون هم می‌خواهی)
    const exportSecret = env.ADMIN_EXPORT_SECRET || env.WH_SECRET;
    if (request.method === "GET" && url.pathname === "/export/users.csv") {
      if (!exportSecret || url.searchParams.get("secret") !== exportSecret) return new Response("forbidden", { status: 403 });
      const csv = await buildUsersCSV(env);
      return new Response(csv, {
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": 'attachment; filename="users.csv"'
        }
      });
    }
    if (request.method === "GET" && url.pathname === "/export/phones.csv") {
      if (!exportSecret || url.searchParams.get("secret") !== exportSecret) return new Response("forbidden", { status: 403 });
      const csv = await buildPhonesCSV(env);
      return new Response(csv, {
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": 'attachment; filename="phones.csv"'
        }
      });
    }

    // Webhook (Fast ACK + Secret header)
    if (request.method === "POST" && url.pathname === `/webhook/${env.WH_SECRET}`) {
      const hdr =
        request.headers.get("X-Telegram-Bot-Api-Secret-Token") ||
        request.headers.get("X-Telegram-BOT-API-SECRET-TOKEN") || "";
      if (env.TG_SECRET_TOKEN && hdr !== env.TG_SECRET_TOKEN) return new Response("forbidden", { status: 403 });

      let update = null; try { update = await request.json(); } catch {}
      ctx.waitUntil(handleUpdate(update, env));
      return new Response("ok");
    }

    return new Response("not found", { status: 404 });
  }
};
