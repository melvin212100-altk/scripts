# WhatsApp OTP Bot (Railway)

Personal WhatsApp account that sends OTPs during registration on the main
website. Uses [Baileys](https://github.com/WhiskeySockets/Baileys) with
**pairing-code** login — no QR scanning.

## Deploy to Railway

1. Push the `railway-bot/` folder to a new GitHub repo (or use Railway's
   "Deploy from GitHub" with this subfolder as the root).
2. In Railway: **New Project → Deploy from Repo**. Set the **Root Directory**
   to `railway-bot` if it lives in a monorepo.
3. Add a **Persistent Volume** mounted at `/app/auth_session` so the WhatsApp
   session survives restarts. (Without it you'll have to re-pair on every deploy.)
4. Set environment variables:
   - `SHARED_SECRET` — long random string, must match the value set in the
     main website's Lovable secrets as `BOT_SHARED_SECRET`.
   - `PHONE_NUMBER` — your personal WhatsApp number in E.164 **without** the
     leading `+`, e.g. `254712345678`.
   - (Railway sets `PORT` automatically.)
5. Deploy. Open the **Logs** tab.

## Pair your phone

After deploy, the logs will print something like:

```
==================================================
 WhatsApp Pairing Code: ABCD-EF12
 Phone:                 +254712345678
 Open WhatsApp on your phone:
  Settings -> Linked Devices -> Link a device
  -> Link with phone number instead -> enter this code
==================================================
```

On your phone:
**WhatsApp → Settings → Linked Devices → Link a device →
"Link with phone number instead" → enter the 8-character code.**

Once paired, the logs show `[CONN] Connected as ...` and `GET /status`
returns `connected: true`. The bot will auto-reconnect on disconnects.

## Connect the main website

In your Lovable project, set these two secrets:

- `BOT_BASE_URL` — your Railway public URL (e.g. `https://otp-bot.up.railway.app`)
- `BOT_SHARED_SECRET` — same value as `SHARED_SECRET` above

The website talks to the bot via:

- `GET  {BOT_BASE_URL}/status`
- `POST {BOT_BASE_URL}/send-otp` body `{ phone, code }`

with header `x-bot-secret: <BOT_SHARED_SECRET>`.

## Local test

```bash
cd railway-bot
npm install
SHARED_SECRET=devsecret PHONE_NUMBER=254712345678 npm start
```
