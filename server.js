require("dotenv").config();
const express        = require("express");
const cors           = require("cors");
const cron           = require("node-cron");
const admin          = require("firebase-admin");
const nodemailer     = require("nodemailer");
const AfricasTalking = require("africastalking");

// ─── FIREBASE ADMIN ───────────────────────────────────────────────────────────
admin.initializeApp({
  credential: admin.credential.cert({
    projectId:   process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
  }),
});
const db = admin.firestore();

// ─── AFRICA'S TALKING (SMS) ───────────────────────────────────────────────────
const AT  = AfricasTalking({ apiKey: process.env.AT_API_KEY, username: process.env.AT_USERNAME });
const sms = AT.SMS;

// ─── NODEMAILER (EMAIL) ───────────────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  host:   process.env.SMTP_HOST || "smtp.gmail.com",
  port:   parseInt(process.env.SMTP_PORT) || 587,
  secure: false,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

// ─── EXPRESS ──────────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

function requireSecret(req, res, next) {
  if (req.headers["x-admin-secret"] !== process.env.ADMIN_SECRET)
    return res.status(401).json({ error: "Unauthorized" });
  next();
}

// ─── INTERNATIONAL PHONE FORMATTER ────────────────────────────────────────────
// Handles numbers from any country using the stored dialCode.
// Examples:
//   { phone: "0712345678", dialCode: "+254" }  → +254712345678
//   { phone: "07911123456", dialCode: "+44" }  → +447911123456
//   { phone: "2125551234", dialCode: "+1" }    → +12125551234
//   { phone: "+254712345678", dialCode: any }  → +254712345678  (already E.164)

function formatPhone(phone, dialCode) {
  if (!phone) return null;
  const p = String(phone).replace(/[\s\-().]/g, "");

  // Already E.164
  if (p.startsWith("+")) return p;

  const code = (dialCode || "").replace(/\s/g, "");
  if (!code.startsWith("+")) return null; // unknown dial code

  const digits = code.replace("+", ""); // e.g. "254", "44", "1"

  // Already includes country code without +
  if (p.startsWith(digits)) return "+" + p;

  // Strip leading 0 (common in many countries: 07xx → strip 0, prepend +254)
  const stripped = p.startsWith("0") ? p.slice(1) : p;
  return code + stripped;
}

// ─── SEND SMS ─────────────────────────────────────────────────────────────────
async function sendSMS(phone, dialCode, message) {
  const formatted = formatPhone(phone, dialCode);
  if (!formatted) return { skipped: true, reason: "no valid phone" };
  try {
    const result    = await sms.send({ to: [formatted], message, from: process.env.AT_SENDER_ID || undefined });
    const recipient = result.SMSMessageData?.Recipients?.[0];
    return { success: recipient?.status === "Success", status: recipient?.status, cost: recipient?.cost, phone: formatted };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ─── SEND EMAIL ───────────────────────────────────────────────────────────────
async function sendEmail(to, subject, html) {
  if (!to) return { skipped: true, reason: "no email" };
  try {
    await transporter.sendMail({
      from: `"${process.env.EMAIL_FROM_NAME || "GO OS SaaS"}" <${process.env.EMAIL_FROM_ADDR}>`,
      to, subject, html,
    });
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ─── SMS TEMPLATE ─────────────────────────────────────────────────────────────
function smsTemplate(clientName, productName, daysLeft, expiryDate) {
  if (daysLeft <= 0)
    return `Dear ${clientName}, your GO OS subscription for ${productName} has EXPIRED. Please renew immediately to restore access.`;
  return `Dear ${clientName}, your GO OS subscription for ${productName} expires in ${daysLeft} day(s) on ${expiryDate}. Renew now to avoid interruption.`;
}

// ─── EMAIL TEMPLATE ───────────────────────────────────────────────────────────
function emailTemplate(clientName, productName, daysLeft, expiryDate, tenantName, currency, amount) {
  const urgencyColor = daysLeft <= 1 ? "#e53e3e" : daysLeft <= 3 ? "#dd6b20" : "#d69e2e";
  const urgencyLabel = daysLeft <= 0 ? "EXPIRED" : daysLeft === 1 ? "EXPIRES TOMORROW" : `${daysLeft} DAYS LEFT`;

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f0f2f7;font-family:Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f2f7;padding:40px 20px">
<tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.1)">
  <tr><td style="background:linear-gradient(135deg,#1a1a2e,#0f3460);padding:28px 32px">
    <table width="100%"><tr>
      <td><span style="background:linear-gradient(135deg,#4a6cf7,#7c3aed);color:#fff;font-weight:800;font-size:18px;padding:6px 14px;border-radius:8px;letter-spacing:1px">GO OS</span></td>
      <td align="right" style="color:#a0aec0;font-size:13px">${tenantName || "SaaS Platform"}</td>
    </tr></table>
  </td></tr>
  <tr><td><div style="background:${urgencyColor};color:#fff;text-align:center;padding:12px;font-size:14px;font-weight:700;letter-spacing:1px">⚠ SUBSCRIPTION ${urgencyLabel}</div></td></tr>
  <tr><td style="padding:32px">
    <p style="font-size:16px;color:#2d3748;margin:0 0 16px">Dear <strong>${clientName}</strong>,</p>
    <p style="font-size:15px;color:#4a5568;margin:0 0 24px;line-height:1.6">
      ${daysLeft <= 0
        ? `Your subscription for <strong>${productName}</strong> has <strong style="color:${urgencyColor}">expired</strong>. Access has been suspended.`
        : `Your subscription for <strong>${productName}</strong> expires on <strong>${expiryDate}</strong> — in <strong style="color:${urgencyColor}">${daysLeft} day(s)</strong>.`}
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f7f9fc;border-radius:8px;border:1px solid #e2e8f0;margin-bottom:24px">
      <tr><td style="padding:16px 20px">
        <table width="100%">
          <tr><td style="font-size:13px;color:#718096;padding-bottom:8px">Product</td><td align="right" style="font-size:13px;font-weight:600;color:#2d3748;padding-bottom:8px">${productName}</td></tr>
          <tr><td style="font-size:13px;color:#718096;padding-bottom:8px">Expiry Date</td><td align="right" style="font-size:13px;font-weight:600;color:${urgencyColor}">${expiryDate}</td></tr>
          ${amount ? `<tr><td style="font-size:13px;color:#718096;padding-bottom:8px">Renewal Amount</td><td align="right" style="font-size:13px;font-weight:600;color:#2d3748">${currency || ""} ${Number(amount).toLocaleString()}</td></tr>` : ""}
          <tr><td style="font-size:13px;color:#718096">Status</td><td align="right" style="font-size:13px;font-weight:700;color:${urgencyColor}">${daysLeft <= 0 ? "EXPIRED" : "EXPIRING SOON"}</td></tr>
        </table>
      </td></tr>
    </table>
    <p style="font-size:14px;color:#718096;margin:0 0 24px;line-height:1.6">Contact your GO OS administrator immediately to renew and restore uninterrupted access.</p>
    <div style="background:#ebf8ff;border-left:4px solid #4a6cf7;padding:12px 16px;border-radius:0 8px 8px 0;font-size:13px;color:#2b6cb0">
      💡 Renewing before expiry ensures zero downtime for your operations.
    </div>
  </td></tr>
  <tr><td style="background:#f7f9fc;padding:20px 32px;border-top:1px solid #e2e8f0;text-align:center">
    <p style="font-size:12px;color:#a0aec0;margin:0">Automated notification from GO OS SaaS Platform. Do not reply to this email.</p>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}

// ─── NOTIFICATION ENGINE ──────────────────────────────────────────────────────
const NOTIFY_DAYS = [7, 3, 1];

async function runNotificationScan(triggeredBy = "cron") {
  console.log(`[${new Date().toISOString()}] 🔔 Notification scan — trigger: ${triggeredBy}`);
  const results = { scanned: 0, notified: 0, skipped: 0, errors: 0, details: [] };

  try {
    const tenantsSnap = await db.collection("tenants").get();

    for (const tenantDoc of tenantsSnap.docs) {
      const tenantId   = tenantDoc.id;
      const tenantData = tenantDoc.data();

      const subsSnap = await db.collection("tenants").doc(tenantId).collection("subscriptions").get();

      for (const subDoc of subsSnap.docs) {
        const sub    = subDoc.data();
        const expiry = sub.expiry?.toDate?.();
        if (!expiry) continue;

        results.scanned++;
        const daysLeft = Math.ceil((expiry - new Date()) / 86400000);
        if (!NOTIFY_DAYS.includes(daysLeft)) continue;

        // Dedup key
        const notifKey = `${subDoc.id}_${daysLeft}d_${expiry.toISOString().slice(0,10)}`;
        const logRef   = db.collection("tenants").doc(tenantId).collection("notification_log").doc(notifKey);
        if ((await logRef.get()).exists) { results.skipped++; continue; }

        // Get client — includes phone, dialCode, email, country
        const clientSnap = await db.collection("tenants").doc(tenantId).collection("clients").doc(sub.clientId).get();
        const client     = clientSnap.exists ? clientSnap.data() : {};

        const clientName  = sub.clientName  || client.name     || "Valued Client";
        const clientPhone = client.phone    || null;
        const dialCode    = client.dialCode || "+254";          // fallback Kenya
        const clientEmail = client.email    || null;
        const currency    = client.currency || tenantData.currency || "";
        const expiryStr   = expiry.toLocaleDateString("en-GB",  { day:"2-digit", month:"short", year:"numeric" });

        const smsMsg    = smsTemplate(clientName, sub.productName, daysLeft, expiryStr);
        const emailHtml = emailTemplate(clientName, sub.productName, daysLeft, expiryStr, tenantData.name, currency, sub.renewalAmount);
        const subject   = daysLeft <= 0
          ? `🔴 Subscription Expired — ${sub.productName}`
          : `⚠ Subscription Expiring in ${daysLeft} Day(s) — ${sub.productName}`;

        const [smsResult, emailResult] = await Promise.all([
          clientPhone ? sendSMS(clientPhone, dialCode, smsMsg) : Promise.resolve({ skipped: true, reason: "no phone" }),
          clientEmail ? sendEmail(clientEmail, subject, emailHtml) : Promise.resolve({ skipped: true, reason: "no email" }),
        ]);

        await logRef.set({
          subId: subDoc.id, tenantId,
          clientName, clientEmail: clientEmail||"", clientPhone: clientPhone||"",
          dialCode, productName: sub.productName,
          daysLeft, expiryDate: expiryStr, triggeredBy,
          sms: smsResult, email: emailResult,
          sentAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        results.notified++;
        results.details.push({
          client: clientName, product: sub.productName, daysLeft,
          sms:   smsResult.success   ? "✅ sent"  : smsResult.skipped   ? "⏭ no phone"  : `❌ ${smsResult.error||"failed"}`,
          email: emailResult.success ? "✅ sent"  : emailResult.skipped ? "⏭ no email"  : `❌ ${emailResult.error||"failed"}`,
        });
        console.log(`  → ${clientName} | ${sub.productName} | ${daysLeft}d | SMS: ${JSON.stringify(smsResult)} | Email: ${JSON.stringify(emailResult)}`);
      }
    }
  } catch (err) {
    results.errors++;
    console.error("Scan error:", err.message);
  }

  console.log(`[DONE] Scanned:${results.scanned} Notified:${results.notified} Skipped:${results.skipped} Errors:${results.errors}`);
  return results;
}

// ─── CRON — 08:00 AM EAT daily ───────────────────────────────────────────────
cron.schedule("0 5 * * *", () => runNotificationScan("cron_daily"), { timezone: "Africa/Nairobi" });
console.log("⏰ Daily cron: 08:00 AM EAT");

// ─── ROUTES ───────────────────────────────────────────────────────────────────
app.get("/health", (req, res) => res.json({ status: "ok", time: new Date().toISOString() }));

app.post("/api/notifications/run", requireSecret, async (req, res) => {
  try { res.json({ success: true, results: await runNotificationScan("manual") }); }
  catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get("/api/notifications/preview/:tenantId", requireSecret, async (req, res) => {
  try {
    const snap    = await db.collection("tenants").doc(req.params.tenantId).collection("subscriptions").get();
    const preview = [];
    for (const d of snap.docs) {
      const sub      = d.data();
      const expiry   = sub.expiry?.toDate?.();
      if (!expiry) continue;
      const daysLeft = Math.ceil((expiry - new Date()) / 86400000);
      if (!NOTIFY_DAYS.includes(daysLeft)) continue;
      const notifKey = `${d.id}_${daysLeft}d_${expiry.toISOString().slice(0,10)}`;
      const sent     = (await db.collection("tenants").doc(req.params.tenantId).collection("notification_log").doc(notifKey).get()).exists;

      // Get contact info
      const clientSnap = await db.collection("tenants").doc(req.params.tenantId).collection("clients").doc(sub.clientId).get();
      const client     = clientSnap.exists ? clientSnap.data() : {};
      preview.push({
        client: sub.clientName, product: sub.productName, daysLeft,
        expiry: expiry.toISOString().slice(0,10),
        hasPhone: !!client.phone, hasEmail: !!client.email,
        alreadySent: sent,
      });
    }
    res.json({ success: true, preview });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get("/api/notifications/log/:tenantId", requireSecret, async (req, res) => {
  try {
    const snap = await db.collection("tenants").doc(req.params.tenantId)
      .collection("notification_log").orderBy("sentAt","desc").limit(50).get();
    res.json({ success: true, logs: snap.docs.map(d => ({ id: d.id, ...d.data() })) });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ─── ACCESS CHECK API ─────────────────────────────────────────────────────────
// This is the endpoint EVERY one of your apps calls before granting access.
// No admin secret required here — apps call this directly, so it's public,
// but it only ever returns a yes/no + expiry date, nothing sensitive.

const TENANT_ID = "softica-it-solutions"; // matches the frontend's fixed tenant

// Simple in-memory cache so repeated checks (e.g. every page load) don't
// hammer Firestore. Cache for 60 seconds per client+product combo.
const accessCache = new Map();
const CACHE_TTL_MS = 60 * 1000;

app.get("/api/access/check", async (req, res) => {
  try {
    const { clientId, productKey } = req.query;
    if (!clientId || !productKey) {
      return res.status(400).json({ error: "clientId and productKey are required" });
    }

    const cacheKey = `${clientId}__${productKey}`;
    const cached = accessCache.get(cacheKey);
    if (cached && (Date.now() - cached.ts) < CACHE_TTL_MS) {
      return res.json(cached.data);
    }

    // Resolve the GO OS clientId — the incoming `clientId` param might be
    // either the actual GO OS client doc ID, OR an externalId (e.g. a
    // Merkaz POS businessId) that was linked when the client was created.
    let resolvedClientId = clientId;

    const directDoc = await db.collection("tenants").doc(TENANT_ID)
      .collection("clients").doc(clientId).get();

    if (!directDoc.exists) {
      // Not a direct GO OS clientId — search by externalId field instead
      const byExternal = await db.collection("tenants").doc(TENANT_ID)
        .collection("clients").where("externalId", "==", clientId).limit(1).get();
      if (!byExternal.empty) {
        resolvedClientId = byExternal.docs[0].id;
      } else {
        const data = { access: false, reason: "client_not_found" };
        accessCache.set(cacheKey, { data, ts: Date.now() });
        return res.json(data);
      }
    }

    // Find the product by slug
    // e.g. "merkaz-pos", "dalada-tracker" — must match exactly what's in Firestore)
    const productsSnap = await db.collection("tenants").doc(TENANT_ID)
      .collection("products").where("slug", "==", productKey).get();

    if (productsSnap.empty) {
      const data = { access: false, reason: "product_not_found" };
      accessCache.set(cacheKey, { data, ts: Date.now() });
      return res.json(data);
    }
    const productId = productsSnap.docs[0].id;

    // Find active subscription for this client + product
    const subsSnap = await db.collection("tenants").doc(TENANT_ID)
      .collection("subscriptions")
      .where("clientId", "==", resolvedClientId)
      .where("productId", "==", productId)
      .get();

    if (subsSnap.empty) {
      const data = { access: false, reason: "no_subscription" };
      accessCache.set(cacheKey, { data, ts: Date.now() });
      return res.json(data);
    }

    // Get the most recent / furthest expiry if multiple subs exist
    let latestExpiry = null;
    subsSnap.docs.forEach(d => {
      const exp = d.data().expiry?.toDate?.();
      if (exp && (!latestExpiry || exp > latestExpiry)) latestExpiry = exp;
    });

    const now    = new Date();
    const active = latestExpiry && latestExpiry > now;
    const daysLeft = latestExpiry ? Math.ceil((latestExpiry - now) / 86400000) : null;

    const data = {
      access:   active,
      reason:   active ? "active" : "expired",
      expiry:   latestExpiry ? latestExpiry.toISOString() : null,
      daysLeft,
    };
    accessCache.set(cacheKey, { data, ts: Date.now() });
    res.json(data);

  } catch (err) {
    console.error("[access check error]", err);
    // Fail OPEN or CLOSED? For revenue protection, fail CLOSED (deny access)
    // on errors — but this means a server outage blocks all your clients.
    // Adjust based on your risk tolerance.
    res.status(500).json({ access: false, reason: "server_error", error: err.message });
  }
});

// Clear the access cache for one client+product — call this right after
// confirming a Till payment so they get instant access without waiting 60s
app.post("/api/access/clear-cache", requireSecret, (req, res) => {
  const { clientId, productKey } = req.body;
  if (clientId && productKey) {
    accessCache.delete(`${clientId}__${productKey}`);
  } else {
    accessCache.clear();
  }
  res.json({ success: true });
});

// ─── FLUTTERWAVE WEBHOOK ──────────────────────────────────────────────────────
app.post("/webhook/flutterwave", async (req, res) => {
  if (req.headers["verif-hash"] !== process.env.FLW_SECRET_HASH)
    return res.status(401).json({ error: "Invalid signature" });

  const { event, data } = req.body;
  console.log("[FLW WEBHOOK]", event, data?.tx_ref);

  if (event === "charge.completed" && data?.status === "successful") {
    const tenantsSnap = await db.collection("tenants").get();
    for (const tenantDoc of tenantsSnap.docs) {
      const paySnap = await db.collection("tenants").doc(tenantDoc.id)
        .collection("payments").where("txRef","==",data.tx_ref).get();
      if (!paySnap.empty) {
        await paySnap.docs[0].ref.update({
          status: "paid", flwRef: data.flw_ref,
          amount: data.amount, paidAt: admin.firestore.FieldValue.serverTimestamp(), webhook: true,
        });
        console.log(`[FLW] Confirmed: ${data.tx_ref}`);
        break;
      }
    }
  }
  res.json({ status: "received" });
});

// ─── START ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n🚀 GO OS Server on port ${PORT}`);
  console.log(`   Health:        GET  /health`);
  console.log(`   Run notifs:    POST /api/notifications/run`);
  console.log(`   Preview:       GET  /api/notifications/preview/:tenantId`);
  console.log(`   FLW Webhook:   POST /webhook/flutterwave\n`);
});
