import os
import logging
from fastapi import FastAPI, Request
from telegram import Update
from telegram.ext import Application, CommandHandler, MessageHandler, filters, ContextTypes

logging.basicConfig(level=logging.INFO)

BOT_TOKEN = os.getenv("BOT_TOKEN")
WEBHOOK_SECRET = os.getenv("WH_SECRET", "secret123")

app = FastAPI()
# Disable the built-in Updater; we'll feed updates via our webhook route.
tg = Application.builder().token(BOT_TOKEN).updater(None).build()

async def start(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text("سلام از Render! ✅")

async def echo(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(update.message.text)

tg.add_handler(CommandHandler("start", start))
tg.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, echo))

@app.post(f"/webhook/{WEBHOOK_SECRET}")
async def telegram_webhook(req: Request):
    data = await req.json()
    update = Update.de_json(data, tg.bot)
    # Process the update immediately (since we're not using the Updater)
    await tg.process_update(update)
    return "ok"

@app.get("/")
def health():
    return {"ok": True}

@app.on_event("startup")
async def on_startup():
    if not BOT_TOKEN:
        raise RuntimeError("BOT_TOKEN تنظیم نشده است.")
    await tg.initialize()
    await tg.start()

@app.on_event("shutdown")
async def on_shutdown():
    await tg.stop()
    await tg.shutdown()

if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", "10000"))
    uvicorn.run("main:app", host="0.0.0.0", port=port)
