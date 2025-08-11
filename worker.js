// worker.js — Telegram bot on Cloudflare Workers (Fast ACK)

const ADMINS = [6803856798]; // آیدی عددی ادمین‌ها

// --- Anti-flood ---
const RATE_LIMIT = 8;   // 4 پیام
const WINDOW_TTL = 10;  // در 10 ثانیه
const BLOCK_TTL  = 10;  // بلاک 60 ثانیه

// --- Labels ---
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

// ----- Helpers: Telegram -----
const tg = async (env, method, payload) => {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!r.ok) {
    const t = await r.text();
    console.error("TG error", method, r.status, t);
    throw new Error(`tg ${method} ${r.status}`);
  }
  return r.json();
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
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendDocument`, { method: "POST", body: fd });
  if (!r.ok) throw new Error(`sendDocument ${r.status}: ${await r.text()}`);
}
const isAdmin = (id) => ADMINS.includes(id);

// ----- Helpers: KV -----
async function trackUserOnce(env, from) {
  if (!env.KV) return { isNew: false };
  const k = `user:${from.id}`;
  const had = await env.KV.get(k);
  if (!had) {
    await env.KV.put(k, JSON.stringify({
      id: from.id, first_name: from.first_name || "", last_name: from.last_name || "",
      username: from.username || "", ts: Date.now()
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
  const l = await listUserKeys(env);
  const vals = await Promise.all(l.keys.map(k => env.KV.get(k.name)));
  const rows = [["id","username","first_name","last_name","ts_iso"]];
  for (const v of vals) {
    if (!v) continue;
    let o; try { o = JSON.parse(v); } catch { continue; }
    rows.push([o.id, o.username?`@${o.username}`:"", o.first_name||"", o.last_name||"", o.ts?new Date(o.ts).toISOString():""]);
  }
  return csvOfRows(rows);
}
async function buildPhonesCSV(env) {
  const l = await listPhoneKeys(env);
  const rows = [["id","phone","username","first_name","last_name","ts_iso"]];
  for (const { name } of l.keys) {
    const id = name.replace("phone:",""); const phone = await env.KV.get(name);
    let u={}; try { u = JSON.parse(await env.KV.get(`user:${id}`) || "{}"); } catch {}
    rows.push([id, phone||"", u.username?`@${u.username}`:"", u.first_name||"", u.last_name||"", u.ts?new Date(u.ts).toISOString():""]);
  }
  return csvOfRows(rows);
}

// ----- Rate limit -----
async function rateLimitExceeded(env, userId) {
  if (!env.KV) return false;
  if (isAdmin(userId)) return false;
  const bKey = `rl:b:${userId}`;
  const cKey = `rl:c:${userId}`;
  if (await env.KV.get(bKey)) return true;
  const cRaw = await env.KV.get(cKey);
  const c = cRaw ? parseInt(cRaw, 10) : 0;
  if (c + 1 > RATE_LIMIT) {
    await env.KV.put(bKey, "1", { expirationTtl: BLOCK_TTL });
    return true;
  }
  await env.KV.put(cKey, String(c + 1), { expirationTtl: WINDOW_TTL });
  return false;
}

// ----- Admin notify -----
async function notifyAdmins(env, from, text, tag = "") {
  const who = `${from.first_name||""} ${from.last_name||""}`.trim() || "کاربر";
  const head = `📥 ${tag?`(${tag}) `:""}از ${who}${from.username?` (@${from.username})`:""}\nID: ${from.id}\n\n`;
  for (const aid of ADMINS) { try { await send(env, aid, head + text); } catch(e){ console.error("notify", e);} }
}

// ----- Command parse -----
function parseCommand(text = "", botUsername = "") {
  if (!text || !text.startsWith("/")) return { cmd:null, args:[] };
  const [f, ...rest] = text.trim().split(/\s+/);
  const [raw, at] = f.split("@");
  if (at && botUsername && at.toLowerCase() !== botUsername.toLowerCase()) return { cmd:null, args:[] };
  return { cmd: raw.slice(1).toLowerCase(), args: rest };
}

// ----- Main background handler -----
async function handleUpdate(update, env) {
  try {
    const actorId = update?.message?.from?.id
                 || update?.edited_message?.from?.id
                 || update?.callback_query?.from?.id
                 || null;
    if (actorId && await rateLimitExceeded(env, actorId)) return;

    // callbacks
    if (update?.callback_query) {
      const cq = update.callback_query;
      const userId = cq.from?.id || cq.message?.chat?.id; // ← اصلاح: تشخیص ادمین بر اساس from.id
      const chatId = cq.message?.chat?.id;
      const data = cq.data || "";
      const kb = isAdmin(userId) ? REPLY_KB_ADMIN : REPLY_KB_USER;

      if (!isAdmin(userId) && (data === "csv_users" || data === "csv_phones")) {
        await answerCallback(env, cq.id, "فقط ادمین.", true); return;
      }
      if (data === "csv_users") {
        const csv = await buildUsersCSV(env); await sendCSVDocument(env, chatId, "users.csv", csv, "CSV کاربران");
      } else if (data === "csv_phones") {
        const csv = await buildPhonesCSV(env); await sendCSVDocument(env, chatId, "phones.csv", csv, "CSV شماره‌ها");
      } else if (data === "prod_1") {
        await send(env, chatId, "محصول ۱ — قیمت: 100,000 تومان", { reply_markup: kb });
        await send(env, chatId, "##ADMIN:prod1## اگر سوالی داری همین پیام را Reply کن.");
      } else if (data === "prod_2") {
        await send(env, chatId, "محصول 2 — قیمت: 175,000 تومان", { reply_markup: kb });
        await send(env, chatId, "##ADMIN:prod2## اگر سوالی داری همین پیام را Reply کن.");
      } else if (data === "prod_3") {
        await send(env, chatId, "محصول ۳ — قیمت: 450,000 تومان", { reply_markup: kb });
        await send(env, chatId, "##ADMIN:prod3## اگر سوالی داری همین پیام را Reply کن.");
      } else if (data === "back_home") {
        await send(env, chatId, "به خانه برگشتی", { reply_markup: kb });
      } else {
        await send(env, chatId, `دادهٔ دکمه: ${data}`, { reply_markup: kb });
      }
      await answerCallback(env, cq.id);
      return;
    }

    // messages
    const msg = update && (update.message || update.edited_message);
    if (!msg) return;

    const chatId = msg.chat.id;
    const from = msg.from || {};
    const text = msg.text || "";
    const kb = isAdmin(chatId) ? REPLY_KB_ADMIN : REPLY_KB_USER;

    // contact (silent)
    if (msg.contact && msg.contact.user_id === from.id) {
      const phone = msg.contact.phone_number;
      await savePhone(env, from.id, phone);
      await notifyAdmins(env, from, `شماره کاربر: ${phone}`, "phone");
      return;
    }

    let me = { result: { username: "" } };
    try { me = await tg(env, "getMe", {}); } catch {}
    const { cmd } = parseCommand(text, me.result.username);

    if (cmd === "start") {
      const { isNew } = await trackUserOnce(env, from);
      await send(env, chatId, "سلام! به بات خوش آمدی. از دکمه‌های پایین استفاده کن.", { reply_markup: kb });
      if (isNew) await notifyAdmins(env, from, "اولین‌بار ربات را استارت کرد.", "new_user");
      return;
    }

    const repliedText = msg.reply_to_message?.text || "";
    if (repliedText && (repliedText.includes("##ADMIN##") || repliedText.includes("##ADMIN:"))) {
      if (text && text.trim()) await notifyAdmins(env, from, text.trim(), "contact");
      return;
    }

    // router
    if (text === KB.home) {
      await send(env, chatId, "بازگشت به صفحه اول.", { reply_markup: kb });

    } else if (text === KB.help || cmd === "help") {
      await send(env, chatId,
        "راهنما:\n• محصولات\n• پیام به ادمین (با Reply)\n• ارسال شماره من\n• حساب/پینگ/زمان/من کیم\n" +
        (isAdmin(chatId) ? "• آمار (ادمین) و CSV" : ""), { reply_markup: kb });

    } else if (text === KB.products) {
      await send(env, chatId, "لیست محصولات:", { reply_markup: kb });
      await tg(env, "sendMessage", {
        chat_id: chatId, text: "یک مورد انتخاب کن:",
        reply_markup: { inline_keyboard: [
          [{ text: "محصول ۱ (100k)", callback_data: "prod_1" },
           { text: "محصول ۲ (175k)", callback_data: "prod_2" }],
          [{ text: "محصول ۳ (450k)", callback_data: "prod_3" }],
          [{ text: "بازگشت", callback_data: "back_home" }]
        ] }
      });

    } else if (text === KB.contact) {
      await send(env, chatId, "##ADMIN## لطفاً پیام‌تان را به صورت Reply به همین پیام بفرستید.", {
        reply_markup: { force_reply: true, selective: true }
      });

    } else if (text === KB.account || cmd === "whoami") {
      await send(env, chatId, `👤 حساب شما:\nID: ${from.id}\nنام: ${(from.first_name||"") + " " + (from.last_name||"")}`.trim(), { reply_markup: kb });

    } else if (text === KB.ping || cmd === "ping") {
      await send(env, chatId, "pong", { reply_markup: kb });

    } else if (text === KB.time || cmd === "time") {
      await send(env, chatId, `⏰ ${new Date().toISOString()}`, { reply_markup: kb });

    } else if (text === KB.whoami) {
      await send(env, chatId, `ID: ${from.id}`, { reply_markup: kb });

    } else if (text === KB.stats || cmd === "stats") {
      if (!isAdmin(from.id)) {
        await send(env, chatId, "این بخش فقط برای ادمین است.", { reply_markup: kb });
      } else if (!env.KV) {
        await send(env, chatId, "KV وصل نیست.", { reply_markup: kb });
      } else {
        const users = await getUserCount(env);
        const phones = await getPhonesCount(env);
        const last = await getLastUsers(env, 10);
        const lines = last.map((u,i)=>{
          const name = `${u.first_name||""} ${u.last_name||""}`.trim() || "کاربر";
          const un = u.username?` @${u.username}`:"";
          const t = u.ts?new Date(u.ts).toISOString():"";
          return `${i+1}. ${name}${un} | ID: ${u.id} | ${t}`;
        }).join("\n") || "—";
        await tg(env, "sendMessage", {
          chat_id: chatId,
          text: `📊 آمار:\nکاربر یکتا: ${users}\nشماره ثبت‌شده: ${phones}\n\nآخرین ۱۰ کاربر:\n${lines}`,
          reply_markup: { inline_keyboard: [[
            { text: "CSV کاربران", callback_data: "csv_users" },
            { text: "CSV شماره‌ها", callback_data: "csv_phones" }
          ]]}
        });
      }
    } else {
      await send(env, chatId, text || "پیام متنی نفرستادی 🙂", { reply_markup: kb });
    }
  } catch (e) {
    console.error("handleUpdate error:", e);
  }
}

// ----- Worker -----
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Health
    if (request.method === "GET" && url.pathname === "/") {
      return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
    }

    // CSV (با secret)
    const exportSecret = env.ADMIN_EXPORT_SECRET || env.WH_SECRET;
    if (request.method === "GET" && url.pathname === "/export/users.csv") {
      if (!env.KV) return new Response("KV not configured", { status: 500 });
      if (!exportSecret || url.searchParams.get("secret") !== exportSecret) return new Response("forbidden", { status: 403 });
      const csv = await buildUsersCSV(env);
      return new Response(csv, { headers: { "content-type":"text/csv; charset=utf-8","content-disposition":'attachment; filename="users.csv"' } });
    }
    if (request.method === "GET" && url.pathname === "/export/phones.csv") {
      if (!env.KV) return new Response("KV not configured", { status: 500 });
      if (!exportSecret || url.searchParams.get("secret") !== exportSecret) return new Response("forbidden", { status: 403 });
      const csv = await buildPhonesCSV(env);
      return new Response(csv, { headers: { "content-type":"text/csv; charset=utf-8","content-disposition":'attachment; filename="phones.csv"' } });
    }

    // Webhook: ACK سریع
    if (request.method === "POST" && url.pathname === `/webhook/${env.WH_SECRET}`) {
      const hdr = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || request.headers.get("X-Telegram-BOT-API-SECRET-TOKEN");
      if (env.TG_SECRET_TOKEN && hdr !== env.TG_SECRET_TOKEN) return new Response("forbidden", { status: 403 });

      let update = null; try { update = await request.json(); } catch {}
      ctx.waitUntil(handleUpdate(update, env));  // پردازش در پس‌زمینه
      return new Response("ok");                 // پاسخ فوری به تلگرام
    }

    return new Response("not found", { status: 404 });
  }
};
