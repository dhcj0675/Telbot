// worker.js — Telegram bot on Cloudflare Workers
// v1.3.0 — admin stats + CSV export + RTL-safe comparisons

/************  تنظیمات  ************/
const ADMINS = [6803856798]; // آیدی عددی ادمین‌ها را اینجا بگذار

// لیبل‌ها
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

// کیبوردها
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

/************  هلسپرها  ************/
// حذف کاراکترهای نامرئی RTL/LRM و فاصله‌ها
const norm = (s = "") => s.replace(/[\u200f\u200e\u200d]/g, "").trim();

const isAdmin = (id) => ADMINS.includes(id);

// تماس با API تلگرام
const tg = async (env, method, payload) => {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
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
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendDocument`, {
    method: "POST",
    body: fd,
  });
  if (!r.ok) throw new Error(`sendDocument ${r.status}: ${await r.text()}`);
}

/************  KV هلسپرهای  ************/
async function trackUserOnce(env, from) {
  if (!env.KV) return { isNew: false };
  const k = `user:${from.id}`;
  const had = await env.KV.get(k);
  if (!had) {
    await env.KV.put(k, JSON.stringify({
      id: from.id,
      first_name: from.first_name || "",
      last_name: from.last_name || "",
      username: from.username || "",
      ts: Date.now(),
    }));
    return { isNew: true };
  }
  return { isNew: false };
}

const savePhone = (env, id, phone) => env.KV?.put(`phone:${id}`, phone);

const listUserKeys   = (env) => env.KV.list({ prefix: "user:" });
const listPhoneKeys  = (env) => env.KV.list({ prefix: "phone:" });
const getUserCount   = async (env) => (await listUserKeys(env)).keys.length;
const getPhonesCount = async (env) => (await listPhoneKeys(env)).keys.length;

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
  if (!env.KV) return "id,username,first_name,last_name,ts_iso\n";
  const l = await listUserKeys(env);
  const vals = await Promise.all(l.keys.map(k => env.KV.get(k.name)));
  const rows = [["id","username","first_name","last_name","ts_iso"]];
  for (const v of vals) {
    if (!v) continue;
    let o; try { o = JSON.parse(v); } catch { continue; }
    rows.push([
      o.id,
      o.username ? `@${o.username}` : "",
      o.first_name || "",
      o.last_name || "",
      o.ts ? new Date(o.ts).toISOString() : "",
    ]);
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
    let u = {};
    try { u = JSON.parse(await env.KV.get(`user:${id}`) || "{}"); } catch {}
    rows.push([
      id,
      phone || "",
      u.username ? `@${u.username}` : "",
      u.first_name || "",
      u.last_name || "",
      u.ts ? new Date(u.ts).toISOString() : "",
    ]);
  }
  return csvOfRows(rows);
}

/************  پردازش آپدیت  ************/
function parseCommand(text = "", botUsername = "") {
  if (!text || !text.startsWith("/")) return { cmd:null, args:[] };
  const [f, ...rest] = text.trim().split(/\s+/);
  const [raw, at] = f.split("@");
  if (at && botUsername && at.toLowerCase() !== botUsername.toLowerCase()) return { cmd:null, args:[] };
  return { cmd: raw.slice(1).toLowerCase(), args: rest };
}

async function notifyAdmins(env, from, text, tag = "") {
  const who = `${from.first_name||""} ${from.last_name||""}`.trim() || "کاربر";
  const head = `📥 ${tag?`(${tag}) `:""}از ${who}${from.username?` (@${from.username})`:""}\nID: ${from.id}\n\n`;
  for (const aid of ADMINS) { try { await send(env, aid, head + text); } catch(e){ console.error("notify", e);} }
}

async function handleUpdate(update, env) {
  try {
    // Callback queries (اگر داشتی)
    if (update?.callback_query) {
      const cq = update.callback_query;
      await answerCallback(env, cq.id);
      return;
    }

    // Messages
    const msg = update && (update.message || update.edited_message);
    if (!msg) return;

    const chatId = msg.chat.id;
    const from = msg.from || {};
    const text = msg.text || "";
    const ntext = norm(text); // متن نرمال‌شده برای مقایسه
    const kb = isAdmin(chatId) ? REPLY_KB_ADMIN : REPLY_KB_USER;

    // ثبت یکبارِ کاربر
    await trackUserOnce(env, from);

    // دریافت شماره (بدون اعلان به کاربر)
    if (msg.contact && msg.contact.user_id === from.id) {
      const phone = msg.contact.phone_number;
      await savePhone(env, from.id, phone);
      await notifyAdmins(env, from, `شماره کاربر: ${phone}`, "phone");
      return;
    }

    // getMe برای تشخیص /start@username
    let me = { result: { username: "" } };
    try { me = await tg(env, "getMe", {}); } catch {}
    const { cmd } = parseCommand(ntext, me.result.username);

    // /start
    if (cmd === "start") {
      await send(env, chatId, "سلام! به بات خوش آمدی. از دکمه‌های پایین استفاده کن.", { reply_markup: kb });
      return;
    }

    // منوها
    if (ntext === norm(KB.home)) {
      await send(env, chatId, "بازگشت به صفحه اول.", { reply_markup: kb });

    } else if (ntext === norm(KB.help) || cmd === "help") {
      await send(env, chatId,
        "راهنما:\n• محصولات\n• پیام به ادمین (با Reply)\n• ارسال شماره من\n• حساب/پینگ/زمان/من کیم\n" +
        (isAdmin(chatId) ? "• آمار (ادمین) و CSV" : ""), { reply_markup: kb });

    } else if (ntext === norm(KB.products)) {
      await send(env, chatId, "لیست محصولات به‌زودی…", { reply_markup: kb });

    } else if (ntext === norm(KB.account) || cmd === "whoami") {
      await send(env, chatId, `👤 حساب شما:\nID: ${from.id}\nنام: ${(from.first_name||"") + " " + (from.last_name||"")}`.trim(), { reply_markup: kb });

    } else if (ntext === norm(KB.ping) || cmd === "ping") {
      await send(env, chatId, "pong", { reply_markup: kb });

    } else if (ntext === norm(KB.time) || cmd === "time") {
      await send(env, chatId, `⏰ ${new Date().toISOString()}`, { reply_markup: kb });

    } else if (ntext === norm(KB.whoami)) {
      await send(env, chatId, `ID: ${from.id}`, { reply_markup: kb });

    } else if (
      // آمار: با دکمه، با تایپ "stats"، یا هر متنی که با «آمار» شروع شود
      (isAdmin(from.id)) &&
      (ntext === norm(KB.stats) || ntext.toLowerCase() === "stats" || cmd === "stats" || ntext.startsWith("آمار"))
    ) {
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

        await send(env, chatId,
          `📊 آمار:\nکاربر یکتا: ${users}\nشماره ثبت‌شده: ${phones}\n\nآخرین ۱۰ کاربر:\n${lines}`,
          { reply_markup: kb }
        );

        // ارسال CSV ها به‌صورت فایل
        try {
          const csvUsers  = await buildUsersCSV(env);
          await sendCSVDocument(env, chatId, "users.csv", csvUsers, "CSV کاربران");

          const csvPhones = await buildPhonesCSV(env);
          await sendCSVDocument(env, chatId, "phones.csv", csvPhones, "CSV شماره‌ها");
        } catch (e) {
          console.error("CSV send error:", e);
          await send(env, chatId, "ارسال CSV با خطا مواجه شد.", { reply_markup: kb });
        }
      }

    } else if (ntext === norm(KB.contact)) {
      // پیام به ادمین (بدون نمایش «ارسال شد» به کاربر)
      await send(env, chatId, "##ADMIN## لطفاً پیام‌تان را به‌صورت Reply به همین پیام بفرستید.", {
        reply_markup: { force_reply: true, selective: true },
      });

    } else {
      // اگر کاربر روی پیام راهنما Reply کرد، به ادمین فوروارد کن (بی‌صدا)
      const repliedText = msg.reply_to_message?.text || "";
      if (repliedText && (repliedText.includes("##ADMIN##") || repliedText.includes("##ADMIN:"))) {
        if (ntext) await notifyAdmins(env, from, ntext, "contact");
        return;
      }

      // eco
      await send(env, chatId, text || "پیام متنی نفرستادی 🙂", { reply_markup: kb });
    }
  } catch (e) {
    console.error("handleUpdate error:", e);
  }
}

/************  Worker  ************/
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // سلامت
    if (request.method === "GET" && url.pathname === "/") {
      return new Response(JSON.stringify({ ok: true, ver: "1.3.0" }), {
        headers: { "content-type": "application/json" },
      });
    }

    // وبهوک
    if (request.method === "POST" && url.pathname === `/webhook/${env.WH_SECRET}`) {
      // بررسی tg secret token اگر ست شده باشد
      const hdr = request.headers.get("X-Telegram-Bot-Api-Secret-Token")
              || request.headers.get("X-Telegram-BOT-API-SECRET-TOKEN");
      if (env.TG_SECRET_TOKEN && hdr !== env.TG_SECRET_TOKEN) {
        return new Response("forbidden", { status: 403 });
      }

      let update = null;
      try { update = await request.json(); } catch {}
      ctx.waitUntil(handleUpdate(update, env)); // پردازش پس‌زمینه
      return new Response("ok");               // ACK سریع
    }

    return new Response("not found", { status: 404 });
  },
};
