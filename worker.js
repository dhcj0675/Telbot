// worker.js — Telegram bot on Cloudflare Workers
// KV + Stats + CSV in Telegram + Custom Persian labels + Silent confirmations
// Vars (Settings → Variables):
//   BOT_TOKEN (Secret), WH_SECRET (Text), optional TG_SECRET_TOKEN (Secret), optional ADMIN_EXPORT_SECRET (Text)
// Bindings (Settings → Bindings):
//   KV  → KV Namespace  (Variable name must be exactly "KV")

const ADMINS = [6803856798]; // ID عددی ادمین‌ها

// ---------- Telegram helpers ----------
const tg = async (env, method, payload) => {
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const body = await res.text();
    console.error("Telegram API error:", res.status, body);
    throw new Error(`tg ${method} ${res.status}`);
  }
  return res.json();
};
const send = (env, chat_id, text, extra = {}) =>
  tg(env, "sendMessage", { chat_id, text, ...extra });
const answerCallback = (env, id, text = "", show_alert = false) =>
  tg(env, "answerCallbackQuery", { callback_query_id: id, text, show_alert });

// ارسال فایل CSV مستقیم داخل تلگرام
async function sendCSVDocument(env, chat_id, filename, csvText, caption = "") {
  const fd = new FormData();
  fd.append("chat_id", String(chat_id));
  fd.append("document", new Blob([csvText], { type: "text/csv; charset=utf-8" }), filename);
  if (caption) fd.append("caption", caption);
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendDocument`, {
    method: "POST",
    body: fd
  });
  if (!res.ok) {
    const body = await res.text();
    console.error("sendDocument error:", res.status, body);
    throw new Error(`sendDocument ${res.status}`);
  }
  return res.json();
}

const isAdmin = (id) => ADMINS.includes(id);

// ---------- Reply Keyboard (Custom Persian labels) ----------
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
    const data = {
      id: from.id,
      first_name: from.first_name || "",
      last_name: from.last_name || "",
      username: from.username || "",
      ts: Date.now()
    };
    await env.KV.put(key, JSON.stringify(data));
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
  return vals
    .map(v => { try { return JSON.parse(v || "{}"); } catch { return null; } })
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
    const ujson = await env.KV.get(`user:${id}`);
    let u = {}; try { u = JSON.parse(ujson || "{}"); } catch {}
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

// ---------- Admin notify ----------
async function notifyAdmins(env, from, text, tag = "") {
  if (!ADMINS.length) return;
  const who = `${from.first_name || ""} ${from.last_name || ""}`.trim() || "کاربر";
  const header =
    `📥 پیام جدید ${tag ? `(${tag}) ` : ""}از ${who}` +
    (from.username ? ` (@${from.username})` : "") +
    `\nID: ${from.id}\n\n`;
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
    const base = url.origin;
    const exportSecret = env.ADMIN_EXPORT_SECRET || env.WH_SECRET;

    // Health
    if (request.method === "GET" && url.pathname === "/") {
      return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
    }

    // (اختیاری) لینک دانلود CSV با secret
    if (request.method === "GET" && url.pathname === "/export/users.csv") {
      if (!env.KV) return new Response("KV not configured", { status: 500 });
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
      if (!env.KV) return new Response("KV not configured", { status: 500 });
      if (!exportSecret || url.searchParams.get("secret") !== exportSecret) return new Response("forbidden", { status: 403 });
      const csv = await buildPhonesCSV(env);
      return new Response(csv, {
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": 'attachment; filename="phones.csv"'
        }
      });
    }

    // Webhook (dynamic secret via env.WH_SECRET)
    if (request.method === "POST" && url.pathname === `/webhook/${env.WH_SECRET}`) {
      const hdr = request.headers.get("X-Telegram-Bot-Api-Secret-Token")
              || request.headers.get("X-Telegram-BOT-API-SECRET-TOKEN");
      if (env.TG_SECRET_TOKEN && hdr !== env.TG_SECRET_TOKEN) {
        return new Response("forbidden", { status: 403 });
      }

      let update; try { update = await request.json(); } catch { update = null; }

      // Inline callbacks (CSV, Products, Back)
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

      // Normal messages
      const msg = update && (update.message || update.edited_message);
      if (!msg) return new Response("ok");

      const chatId = msg.chat.id;
      const from = msg.from || {};
      const text = msg.text || "";
      const keyboard = isAdmin(chatId) ? REPLY_KB_ADMIN : REPLY_KB_USER;

      // Contact share → save + notify (SILENT to user)
      if (msg.contact && msg.contact.user_id === from.id) {
        const phone = msg.contact.phone_number;
        await savePhone(env, from.id, phone);
        // هیچ پیام تأییدی به کاربر نشان نمی‌دهیم
        await notifyAdmins(env, from, `شماره کاربر: ${phone}`, "phone");
        return new Response("ok");
      }

      // Support /cmd
      let me = { result: { username: "" } };
      try { me = await tg(env, "getMe", {}); } catch {}
      const { cmd, args } = parseCommand(text, me.result.username);

      // FIRST /start → welcome + notify admin once (SILENT to user about admin notify)
      if (cmd === "start") {
        const { isNew } = await trackUserOnce(env, from);
        await send(env, chatId,
          "سلام! به بات خوش آمدید. از دکمه‌های پایین استفاده کنید.",
          { reply_markup: keyboard }
        );
        if (isNew) await notifyAdmins(env, from, "اولین بار ربات را استارت کرد.", "new_user");
        return new Response("ok");
      }

      // ForceReply reply to admin prompt (SILENT confirmation)
      const repliedText = msg.reply_to_message?.text || "";
      if (repliedText && (repliedText.includes("##ADMIN##") || repliedText.includes("##ADMIN:"))) {
        if (text && text.trim()) {
          await notifyAdmins(env, from, text.trim(), "contact");
          // هیچ پیام تأییدی به کاربر نمی‌دهیم
        }
        return new Response("ok");
      }

      // Router (labels in Persian)
      if (text === KB.home) {
        await send(env, chatId, "بازگشت به صفحه‌ی اول بات.", { reply_markup: keyboard });

      } else if (text === KB.help || cmd === "help") {
        await send(env, chatId,
          "راهنما:\n" +
          "• " + KB.products + " — دیدن محصولات و پرسیدن سؤال\n" +
          "• " + KB.contact + " — ارسال پیام به ادمین (Reply کنید)\n" +
          "• " + KB.sharePhone + " — با رضایت شما، شماره‌تان ثبت می‌شود\n" +
          "• " + KB.account + " — نمایش حساب شما\n" +
          "• " + KB.ping + " — تست زنده بودن\n" +
          "• " + KB.time + " — زمان UTC\n" +
          "• " + KB.whoami + " — شناسه شما" +
          (isAdmin(chatId) ? "\n• " + KB.stats + " — آمار کاربران (ادمین)" : ""),
          { reply_markup: keyboard }
        );

      } else if (text === KB.products) {
        await send(env, chatId, "لیست محصولات:", { reply_markup: keyboard });
        await tg(env, "SendMessage", { // حروف کوچک-بزرگ مهم است؛ اما sendMessage درست است
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
        }).catch(async () => {
          // در صورت خطای تایپی متد بالا، نسخه صحیح:
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
            reply_markup: {
              inline_keyboard: [
                [{ text: "CSV کاربران", callback_data: "csv_users" },
                 { text: "CSV شماره‌ها", callback_data: "csv_phones" }]
              ]
            }
          });
        }

      } else {
        // fallback echo
        await send(env, chatId, text || "پیام متنی نفرستادی 🙂", { reply_markup: keyboard });
      }

      return new Response("ok");
    }

    return new Response("not found", { status: 404 });
  }
}
