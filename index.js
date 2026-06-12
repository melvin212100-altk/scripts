/**
 * Personal WhatsApp OTP Bot (Baileys, pairing-code login).
 *
 * Designed for Railway. ONE personal WhatsApp account sends OTPs to users
 * during registration on the main website.
 *
 * Env vars (set in Railway):
 *   PORT                 (Railway provides this)
 *   SHARED_SECRET        shared secret with the website (any long random string)
 *   PHONE_NUMBER         your personal WhatsApp number in E.164 WITHOUT '+' (e.g. 254712345678)
 *                        If unset, you'll be prompted in logs to set it and redeploy.
 *
 * Endpoints (all require header `x-bot-secret: <SHARED_SECRET>`):
 *   GET  /status                -> { connected, user, pairingCode }
 *   GET  /pairing-code          -> { pairingCode } (latest one issued)
 *   POST /send-otp { phone, code }  -> { ok: true }
 *
 * Pairing flow:
 *   1) Deploy with PHONE_NUMBER set.
 *   2) Open Railway logs. An 8-character pairing code will be printed.
 *   3) On your phone: WhatsApp -> Settings -> Linked Devices -> Link a device
 *      -> "Link with phone number instead" -> type the code from the logs.
 *   4) /status will then show connected:true and the bot is ready.
 */

const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  Browsers,
} = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const express = require("express");
const pino = require("pino");
const path = require("path");
const fs = require("fs");

const PORT = process.env.PORT || 3000;
const SHARED_SECRET = process.env.SHARED_SECRET || "";
const PHONE_NUMBER = (process.env.PHONE_NUMBER || "").replace(/[^\d]/g, "");

if (!SHARED_SECRET) {
  console.error("[FATAL] SHARED_SECRET env var is required.");
  process.exit(1);
}

const AUTH_DIR = process.env.AUTH_DIR || path.join(__dirname, "auth_session");
fs.mkdirSync(AUTH_DIR, { recursive: true });

const logger = pino({ level: process.env.LOG_LEVEL || "info" });

let sock = null;
let isConnected = false;
let currentUser = null;
let latestPairingCode = null;
let connecting = false;

async function startBot() {
  if (connecting) return;
  connecting = true;
  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      logger,
      printQRInTerminal: false, // pairing code only, no QR
      auth: state,
      browser: Browsers.ubuntu("OTP-Bot"),
      markOnlineOnConnect: false,
    });

    // Request pairing code if not yet registered
    if (!sock.authState.creds.registered) {
      if (!PHONE_NUMBER) {
        console.error(
          "[PAIRING] PHONE_NUMBER env var not set. Set it (E.164 without '+', e.g. 254712345678) and redeploy."
        );
      } else {
        // small delay required before requesting pairing code
        setTimeout(async () => {
          try {
            const code = await sock.requestPairingCode(PHONE_NUMBER);
            const pretty = code?.match(/.{1,4}/g)?.join("-") || code;
            latestPairingCode = pretty;
            console.log("\n==================================================");
            console.log(" WhatsApp Pairing Code: " + pretty);
            console.log(" Phone:                 +" + PHONE_NUMBER);
            console.log(" Open WhatsApp on your phone:");
            console.log("  Settings -> Linked Devices -> Link a device");
            console.log("  -> Link with phone number instead -> enter this code");
            console.log("==================================================\n");
          } catch (err) {
            console.error("[PAIRING] Failed to request pairing code:", err);
          }
        }, 3000);
      }
    }

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect } = update;
      if (connection === "open") {
        isConnected = true;
        currentUser = sock.user;
        latestPairingCode = null;
        console.log("[CONN] Connected as", sock.user?.id);
      } else if (connection === "close") {
        isConnected = false;
        const statusCode =
          new Boom(lastDisconnect?.error)?.output?.statusCode || 0;
        const loggedOut = statusCode === DisconnectReason.loggedOut;
        console.log(
          "[CONN] Closed. statusCode=" + statusCode + " loggedOut=" + loggedOut
        );
        if (loggedOut) {
          // clear creds so next start asks for a fresh pairing code
          try {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
            fs.mkdirSync(AUTH_DIR, { recursive: true });
          } catch (_) {}
        }
        connecting = false;
        setTimeout(() => startBot().catch(console.error), 2500);
      }
    });
  } catch (err) {
    console.error("[START] Error:", err);
    connecting = false;
    setTimeout(() => startBot().catch(console.error), 5000);
  }
}

startBot().catch(console.error);

// -------- HTTP API --------
const app = express();
app.use(express.json());

function auth(req, res, next) {
  if (req.header("x-bot-secret") !== SHARED_SECRET) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

app.get("/", (_req, res) => {
  res.json({ ok: true, service: "whatsapp-otp-bot", connected: isConnected });
});

app.get("/status", auth, (_req, res) => {
  res.json({
    connected: isConnected,
    user: currentUser?.id || null,
    pairingCode: latestPairingCode,
    phone: PHONE_NUMBER || null,
  });
});

app.get("/pairing-code", auth, (_req, res) => {
  res.json({ pairingCode: latestPairingCode, connected: isConnected });
});

async function sendText(phone, text, { checkExists = false } = {}) {
  if (!isConnected || !sock) {
    const err = new Error("whatsapp not connected");
    err.status = 503;
    throw err;
  }
  const digits = String(phone || "").replace(/[^\d]/g, "");
  if (digits.length < 8) {
    const err = new Error("invalid phone");
    err.status = 400;
    throw err;
  }
  if (checkExists) {
    try {
      const [exists] = await sock.onWhatsApp(digits);
      if (!exists?.exists) {
        const err = new Error("number not on whatsapp");
        err.status = 400;
        throw err;
      }
    } catch (e) {
      if (e.status) throw e;
      // network blip — continue
    }
  }
  const jid = digits + "@s.whatsapp.net";
  await sock.sendMessage(jid, { text });
}

app.post("/send-otp", auth, async (req, res) => {
  try {
    const { phone, code } = req.body || {};
    if (!phone || !code) return res.status(400).json({ error: "phone and code required" });
    const text =
      "Your verification code is: *" + code +
      "*\n\nIt expires in 5 minutes. Do not share this code with anyone.";
    await sendText(phone, text, { checkExists: true });
    res.json({ ok: true });
  } catch (err) {
    console.error("[SEND-OTP]", err);
    res.status(err.status || 500).json({ error: err.message || "failed to send" });
  }
});

// Generic message sender used by login greetings + transaction notifications.
app.post("/send-message", auth, async (req, res) => {
  try {
    const { phone, text } = req.body || {};
    if (!phone || !text) return res.status(400).json({ error: "phone and text required" });
    await sendText(phone, String(text));
    res.json({ ok: true });
  } catch (err) {
    console.error("[SEND-MESSAGE]", err);
    res.status(err.status || 500).json({ error: err.message || "failed to send" });
  }
});

app.listen(PORT, () => {
  console.log("[HTTP] listening on :" + PORT);
});
