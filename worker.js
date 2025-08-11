// worker.js — Persian Telegram bot on Cloudflare Workers
// Features:
// - Reply keyboard با لیبل‌های سفارشی
// - ذخیره اولین /start هر کاربر در KV + اطلاع به ادمین (فقط بار اول)
// - دریافت شماره با دکمه «ارسال شماره من» و ذخیره در KV + ارسال به ادمین (سایلنت برای کاربر)
// - دکمه آمار (فقط ادمین): تعداد کاربران/شماره‌ها + ۱۰ کاربر آخر + CSV داخل تلگرام
// - CSV دانلودی با secret (ADMIN_EXPORT_SECRET یا WH_SECRET)
// - Anti-flood: هر کاربر حداکثر 4 پیام در 10 ثانیه؛ نقض → بلاک 60s (ادمین‌ها معاف)
//
// Env Vars (Settings → Variables):
//   BOT_TOKEN (Secret)               ← توکن بات
//   WH_SECRET (Text)                 ← سکرت مسیر وبهوک
//   TG_SECRET_TOKEN (Secret)         ← اختیاری؛ اگر در setWebhook هم می‌دهی
//   ADMIN_EXPORT_SECRET (Text)       ← اختیاری؛ برای لینک CSV
//
// Bindings (Settings → Bindings):
//   KV  → KV Namespace  (Variable name must be exactly "KV")

const ADMINS = [6803856798]; // آیدی عددی ادمین‌ها

// --- Anti-flood config ---
const RATE_LIMIT = 4;   // 4 پیام/کلیک
const WINDOW_TTL = 10;  // در 10 ثانیه
const BLOCK_TTL  = 60;  // بلاک 60 ثانیه

// ---------- Telegram helpers ----------
const tg = async (env, method, payload) => {
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const body = await res.text();
    console.error("Telegram API error:", method, res.status, body);
    throw new Error(`tg ${method} ${res.status}`);
  }
  return res.json();
};
const send = (env, chat_id, text, extra = {}) =>
  tg(env, "sendMessage", { chat_id, text, ...extra });
const answerCallback = (env, id, text = "", show_alert = false) =>
  tg(env, "answerCallbackQuery", { callback_query_id: id, text, show_alert });

async function sendCSVDocument(env, chat_id, filename, csvText, caption = "") {
  const fd = new FormData();
  fd.append("chat_id", String(chat_id));
  fd.append("document", new Blob([csvText], { type: "text/csv; charset=utf-8" }), filename);
  if (caption) fd.append("caption", caption);
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendDocument`, { method: "POST", body: fd });
  if (!res.ok) {
    const body = await res.text();
    console.error("sendDocument error:", res.status, body);
    throw new Error(`sendDocument ${res.status}`);
  }
  return res.json();
}
const isAdmin = (id) => ADMINS.includes(id);

// ---------- Labels ----------
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
  stats: "آمار (ادمین)"
};
const REPLY_KB_USER = {
  keyboard: [
    [{ text: KB.home }, { text: KB.help }],
    [{ text: KB.products }, { text: KB.account }],
    [{ text: KB.ping }, { text: KB.time }, { text: KB.whoami }],
    [{ text: KB.contact }, { text: KB.sharePhone, request_contact: true }]
  ],
  resize_keyboard: true, is_persistent: true, one_time_keyboard: false,
  input_field_placeholder: "از دکمه‌های پایین انتخاب کن…"
};
const REPLY_KB_ADMIN = {
  keyboard: [
    [{ text: KB.home }, { text: KB.help }],
    [{ text: KB.products }, { text: KB.account }],
    [{ text: KB.ping }, { text: KB.time }, { text: KB.whoami }],
    [{ text: KB.contact }, { text: KB.sharePhone, request_contact: true }],
    [{ text: KB.stats }]
  ],
  resize_keyboard: true, is_persistent: true, one_time_keyboard: false,
  input_field_placeholder: "منوی ادمین"
};

// ---------- KV helpers ----------
async function trackUserOnce(env, from) {
  if (!env.KV) return { isNew: false };
  const key = `user:${from.id}`;
  const had = await env.KV.get(key);
  if (!had) {
    await env.KV.put(key, JSON.stringify({
      id: from.id,
      first_name: from.first_name || "",
      last_name: from.last_name || "",
      username: from.username || "",
      ts: Date.now()
    }));
    return { isNew: true };
  }
  return { isNew: false };
}
const savePhone = (env, id, phone) => env.KV?.put(`phone:${id}`, phone);

const listUserKeys  = (env) => env.KV.list({ prefix: "user:" });
const listPhoneKeys = (env) => env.KV.list({ prefix: "phone:" });
const getUserCount  = async (env) => (await listUserKeys(env)).keys.length;
const getPhonesCount= async (env) => (await listPhoneKeys(env)).keys.length;

async function getLastUsers(env, limit = 10) {
  const l = await listUserKeys(env);
  const vals = await Promise.all(l.keys.map(k => env.KV.get(k.name)));
  return vals.map(v => { try { return JSON.parse(v || "{}"); } catch { return null; } })
             .filter(Boolean)
             .sort((a,b) => (b.ts||0) - (a.ts||0))
             .slice(0, limit);
}
async function buildUsersCSV(env) {
  const l = await listUserKeys(env);
  const vals = await Promise.all(l.keys.map(k => env.KV.get(k.name)));
  const rows = [["id","username","first_name","last_name","ts_iso"]];
  for (const v of vals) {
    if (!v) continue;
    let o; try { o = JSON.parse(v); } catch { continue; }
    rows.push([
      o.id ?? "",
      o.username ? `@${o.username}` : "",
      o.first_name ?? "",
      o.last_name ?? "",
      o.ts ? new Date(o.ts).toISOString() : ""
    ]);
  }
  return rows.map(r => r.map(x => `"${String(x).replace(/"/g,'""')}"`).join(",")).join("\n");
}
async function buildPhonesCSV(env) {
  const l = await listPhoneKeys(env);
  const rows = [["id","phone","username","first_name","last_name","ts_iso"]];
  for (const { name } of l.keys) {
    const id = name.replace("phone:","");
    const phone = await env.KV.get(name);
    const ujson = await env.KV.get(`user:${id}`); let u = {};
    try { u = JSON.parse(ujson || "{}"); } catch {}
    rows.push([
      id,
      phone || "",
      u.username ? `@${u.username}` : "",
      u.first_name || "",
      u.last_name || "",
      u.ts ? new Date(u.ts).toISOString() : ""
    ]);
  }
  return rows.map(r => r.map(x => `"${String(x).replace(/"/g,'""')}"`).join(",")).join("\n");
}

// ---------- Anti-flood with KV ----------
async function rateLimitExceeded(env, userId) {
  if (!env.KV) return false;         // اگر KV وصل نیست، محدودکننده غیرفعال
  if (isAdmin(userId)) return false; // ادمین‌ها معاف

  const blockKey = `rl:b:${userId}`;
  const countKey = `rl:c:${userId}`;

  // اگر در بلاک است
  if (await env.KV.get(blockKey)) return true;

  // شمارنده فعلی
  const raw = await env.KV.get(countKey);
  const count = raw ? parseInt(raw, 10) : 0;

  // نقض سقف → بلاک 60 ثانیه
  if (count + 1 > RATE_LIMIT) {
    await env.KV.put(blockKey, "1", { expirationTtl: BLOCK_TTL });
    // شمارنده خودکار در 10s منقضی می‌شود
    return true;
  }

  // افزایش شمارنده با TTL پنجره (sliding window)
  await env.KV.put(countKey, String(count + 1), { expirationTtl: WINDOW_TTL });
  return false;
}

// ---------- Admin notify ----------
async function notifyAdmins(env, from, text, tag = "") {
  if (!ADMINS.length) return;
  const who = `${from.first_name || ""} ${from.last_name || ""}`.trim() || "کاربر";
  const header = `📥 ${tag ? `(${tag}) ` : ""}از ${who}` + (from.username ? ` (@${from.username})` : "") + `\nID: ${from.id}\n\n`;
  for (const adminId of ADMINS) {
    try { await send(env, adminId, header + text); }
    catch (e) { console.error("notify admin failed:", adminId, e); }
  }
}

// ---------- Command parser ----------
function parseCommand(text = "", botUsername = "") {
  if (!text || !text.startsWith("/")) return { cmd: null, args: [] };
  const [first, ...rest] = text.trim().split(/\s+/);
  const [raw, at] = first.split("@");
  if (at && botUsername && at.toLowerCase() !== botUsername.toLowerCase()) return { cmd: null, args: [] };
  return { cmd: raw.slice(1).toLowerCase(), args: rest };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // لاگ حداقلی برای دیباگ
    console.log("REQ", request.method, url.pathname);

    // Health
    if (request.method === "GET" && url.pathname === "/") {
      return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
    }

    // CSV با secret (اختیاری)
    const exportSecret = env.ADMIN_EXPORT_SECRET || env.WH_SECRET;
    if (request.method === "GET" && url.pathname === "/export/users.csv") {
      if (!env.KV) return new Response("KV not configured", { status: 500 });
      if (!exportSecret || url.searchParams.get("secret") !== exportSecret) return new Response("forbidden", { status: 403 });
      const csv = await buildUsersCSV(env);
      return new Response(csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="users.csv"' } });
    }
    if (request.method === "GET" && url.pathname === "/export/phones.csv") {
      if (!env.KV) return new Response("KV not configured", { status: 500 });
      if (!exportSecret || url.searchParams.get("secret") !== exportSecret) return new Response("forbidden", { status: 403 });
      const csv = await buildPhonesCSV(env);
      return new Response(csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="phones.csv"' } });
    }

    // Webhook (از WH_SECRET داینامیک می‌خوانیم)
    if (request.method === "POST" && url.pathname === `/webhook/${env.WH_SECRET}`) {
      const hdr = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || request.headers.get("X-Telegram-BOT-API-SECRET-TOKEN");
      if (env.TG_SECRET_TOKEN && hdr !== env.TG_SECRET_TOKEN) {
        return new Response("forbidden", { status: 403 });
      }

      let update; try { update = await request.json(); } catch { update = null; }

      // استخراج actor برای ریت‌لیمیت
      const actorId = update?.message?.from?.id
                   || update?.edited_message?.from?.id
                   || update?.callback_query?.from?.id
                   || null;
      if (actorId && await rateLimitExceeded(env, actorId)) {
        // سایلنت: هیچ پیامی نده
        return new Response("ok");
      }

      // --- Callbacks (CSV/Products/Back) ---
      if (update?.callback_query) {
        const cq = update.callback_query;
        const chatId = cq.message?.chat?.id;
        const data = cq.data || "";
        const keyboard = isAdmin(chatId) ? REPLY_KB_ADMIN : REPLY_KB_USER;

        if (!isAdmin(chatId) && (data === "csv_users" || data === "csv_phones")) {
          await answerCallback(env, cq.id, "فقط ادمین.", true);
          return new Response("ok");
        }
        if (data === "csv_users") {
          const csv = await buildUsersCSV(env);
          await sendCSVDocument(env, chatId, "users.csv", csv, "📄 CSV کاربران");
        } else if (data === "csv_phones") {
          const csv = await buildPhonesCSV(env);
          await sendCSVDocument(env, chatId, "phones.csv", csv, "📄 CSV شماره‌ها");
        } else if (data === "prod_1") {
          await send(env, chatId, "محصول ۱ — قیمت: 100,000 تومان", { reply_markup: keyboard });
          await send(env, chatId, "##ADMIN:prod1## اگر سوالی داری همین پیام را Reply کن.");
        } else if (data === "prod_2") {
          await send(env, chatId, "محصول ۲ — قیمت: 175,000 تومان", { reply_markup: keyboard });
          await send(env, chatId, "##ADMIN:prod2## اگر سوالی داری همین پیام را Reply کن.");
        } else if (data === "prod_3") {
          await send(env, chatId, "محصول ۳ — قیمت: 450,000 تومان", { reply_markup: keyboard });
          await send(env, chatId, "##ADMIN:prod3## اگر سوالی داری همین پیام را Reply کن.");
        } else if (data === "back_home") {
          await send(env, chatId, "به خانه برگشتی", { reply_markup: keyboard });
        } else {
          await send(env, chatId, `داده‌ی دکمه: ${data}`, { reply_markup: keyboard });
        }
        await answerCallback(env, cq.id);
        return new Response("ok");
      }

      // --- Messages ---
      const msg = update && (update.message || update.edited_message);
      if (!msg) return new Response("ok");

      const chatId = msg.chat.id;
      const from = msg.from || {};
      const text = msg.text || "";
      const keyboard = isAdmin(chatId) ? REPLY_KB_ADMIN : REPLY_KB_USER;

      // Contact (سایلنت برای کاربر)
      if (msg.contact && msg.contact.user_id === from.id) {
        const phone = msg.contact.phone_number;
        await savePhone(env, from.id, phone);
        await notifyAdmins(env, from, `شماره کاربر: ${phone}`, "phone");
        return new Response("ok");
      }

      // پشتیبانی از /cmd
      let me = { result: { username: "" } };
      try { me = await tg(env, "getMe", {}); } catch {}
      const { cmd, args } = parseCommand(text, me.result.username);

      // /start (اولین‌بار → اطلاع به ادمین؛ سایلنت برای کاربر)
      if (cmd === "start") {
        const { isNew } = await trackUserOnce(env, from);
        await send(env, chatId, "سلام! به بات خوش آمدید. از دکمه‌های پایین استفاده کنید.", { reply_markup: keyboard });
        if (isNew) await notifyAdmins(env, from, "اولین بار ربات را استارت کرد.", "new_user");
        return new Response("ok");
      }

      // Reply به پیام راهنمای ادمین (سایلنت برای کاربر)
      const repliedText = msg.reply_to_message?.text || "";
      if (repliedText && (repliedText.includes("##ADMIN##") || repliedText.includes("##ADMIN:"))) {
        if (text && text.trim()) await notifyAdmins(env, from, text.trim(), "contact");
        return new Response("ok");
      }

      // Router
      if (text === KB.home) {
        await send(env, chatId, "بازگشت به صفحه‌ی اول بات.", { reply_markup: keyboard });

      } else if (text === KB.help || cmd === "help") {
        await send(env, chatId,
          "راهنما:\n" +
          "• محصولات — دیدن محصولات\n" +
          "• پیام به ادمین — با Reply پیام بده\n" +
          "• ارسال شماره من — با رضایت شما ذخیره می‌شود\n" +
          "• حساب/پینگ/زمان/من کیم\n" +
          (isAdmin(chatId) ? "• آمار (ادمین) — آمار و CSV" : ""),
          { reply_markup: keyboard }
        );

      } else if (text === KB.products) {
        await send(env, chatId, "لیست محصولات:", { reply_markup: keyboard });
        await tg(env, "sendMessage", {
          chat_id: chatId,
          text: "یک مورد انتخاب کن:",
          reply_markup: {
            inline_keyboard: [
              [{ text: "محصول ۱ (100k)", callback_data: "prod_1" },
               { text: "محصول ۲ (175k)", callback_data: "prod_2" }],
              [{ text: "محصول ۳ (450k)", callback_data: "prod_3" }],
              [{ text: "بازگشت", callback_data: "back_home" }]
            ]
          }
        });

      } else if (text === KB.contact) {
        await send(env, chatId, "##ADMIN## لطفاً پیام خود را برای ادمین به‌صورت «پاسخ به همین پیام» ارسال کنید.", {
          reply_markup: { force_reply: true, selective: true }
        });

      } else if (text === KB.account || cmd === "whoami") {
        await send(env, chatId, `👤 حساب شما:\nID: ${from.id}\nنام: ${(from.first_name||"") + " " + (from.last_name||"")}`.trim(), { reply_markup: keyboard });

      } else if (text === KB.ping || cmd === "ping") {
        await send(env, chatId, "pong", { reply_markup: keyboard });

      } else if (text === KB.time || cmd === "time") {
        await send(env, chatId, `⏰ ${new Date().toISOString()}`, { reply_markup: keyboard });

      } else if (text === KB.whoami) {
        await send(env, chatId, `ID: ${from.id}`, { reply_markup: keyboard });

      } else if (text === KB.stats || cmd === "stats") {
        if (!isAdmin(from.id)) {
          await send(env, chatId, "این بخش فقط برای ادمین است.", { reply_markup: keyboard });
        } else if (!env.KV) {
          await send(env, chatId, "KV وصل نیست.", { reply_markup: keyboard });
        } else {
          const users = await getUserCount(env);
          const phones = await getPhonesCount(env);
          const last = await getLastUsers(env, 10);
          const lines = last.map((u, i) => {
            const name = `${u.first_name||""} ${u.last_name||""}`.trim() || "کاربر";
            const uname = u.username ? ` @${u.username}` : "";
            const t = u.ts ? new Date(u.ts).toISOString() : "";
            return `${i+1}. ${name}${uname} | ID: ${u.id} | ${t}`;
          }).join("\n") || "—";

          await tg(env, "sendMessage", {
            chat_id: chatId,
            text: `📊 آمار:\nکاربر یکتا: ${users}\nشمارهٔ ثبت‌شده: ${phones}\n\nآخرین ۱۰ کاربر:\n${lines}`,
            reply_markup: { inline_keyboard: [[
              { text: "CSV کاربران", callback_data: "csv_users" },
              { text: "CSV شماره‌ها", callback_data: "csv_phones" }
            ]] }
          });
        }

      } else {
        // fallback
        await send(env, chatId, text || "پیام متنی نفرستادی 🙂", { reply_markup: keyboard });
      }

      return new Response("ok");
    }

    return new Response("not found", { status: 404 });
  }
}
```0
