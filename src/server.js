require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const crypto = require("crypto");
const axios = require("axios");
const { rateLimit, ipKeyGenerator } = require("express-rate-limit");
const cron = require("node-cron");
const Brevo = require("@getbrevo/brevo");
const supabase = require("./config/supabase");

// -------------------------------------------------------------
// 1. STARTUP ENVIRONMENT VALIDATION
// -------------------------------------------------------------
const REQUIRED_ENV_VARS = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SQUADCO_SECRET_KEY",
  "BIGISUB_API_KEY",
  "BREVO_API_KEY",
  "SENDER_EMAIL",
  "SENDER_NAME",
  "SERVER_BASE_URL",
];

const missingVars = REQUIRED_ENV_VARS.filter((key) => !process.env[key]);
if (missingVars.length > 0) {
  console.error(`❌ CRITICAL ERROR: Missing required environment variables: ${missingVars.join(", ")}`);
  process.exit(1);
}

// -------------------------------------------------------------
// 2. BREVO API CLIENT INITIALIZATION (SDK V3 FIX)
// -------------------------------------------------------------
const defaultClient = Brevo.ApiClient.instance;
const apiKey = defaultClient.authentications['api-key'];
apiKey.apiKey = process.env.BREVO_API_KEY;

const brevoApi = new Brevo.TransactionalEmailsApi();

// -------------------------------------------------------------
// 3. PRE-FLIGHT DATABASE RPC VALIDATION
// -------------------------------------------------------------
const validateDatabaseRPCs = async () => {
  try {
    const dummyUuid = "00000000-0000-0000-0000-000000000000";
    const { error: debitErr } = await supabase.rpc("debit_user_wallet", {
      p_user_id: dummyUuid,
      p_amount: 0,
      p_order_id: "0",
      p_reference: "TEST",
    });
    const { error: creditErr } = await supabase.rpc("credit_user_wallet", {
      p_user_id: dummyUuid,
      p_amount: 0,
      p_reference: "TEST",
      p_description: "TEST",
    });
    const { error: refundErr } = await supabase.rpc("refund_user_wallet", {
      p_user_id: dummyUuid,
      p_amount: 0,
      p_order_id: "0",
      p_reference: "TEST",
    });
    const { error: depositErr } = await supabase.rpc("credit_deposit_atomically", {
      p_user_id: dummyUuid,
      p_amount: 0,
      p_reference: "TEST",
      p_description: "TEST",
    });

    if (
      debitErr?.code === "PGRST202" ||
      creditErr?.code === "PGRST202" ||
      refundErr?.code === "PGRST202" ||
      depositErr?.code === "PGRST202"
    ) {
      console.error("❌ CRITICAL ERROR: Missing RPC functions in Supabase!");
      process.exit(1);
    }
    console.log("✅ All PostgreSQL RPC functions verified successfully.");
  } catch (err) {
    console.error("❌ Pre-flight check failed:", err.message);
    process.exit(1);
  }
};
validateDatabaseRPCs();

// -------------------------------------------------------------
// 4. EXPRESS APP SETUP
// -------------------------------------------------------------
const app = express();
app.set("trust proxy", 1);
app.use(helmet());

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",")
  : ["http://localhost:3000", process.env.SERVER_BASE_URL].filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("CORS policy restriction: Origin not allowed"));
      }
    },
    credentials: true,
  })
);

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

// -------------------------------------------------------------
// 5. RATE LIMITERS
// -------------------------------------------------------------
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { success: false, error: { code: "RATE_LIMIT_EXCEEDED", message: "Too many requests." } },
});
app.use(globalLimiter);

const keyGenerator = (req) => req.user?.id || ipKeyGenerator(req);

const orderLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  keyGenerator,
  message: { success: false, error: { code: "TOO_MANY_ORDERS", message: "Too many purchase attempts." } },
});

const fundingLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 3,
  keyGenerator,
  message: { success: false, error: { code: "TOO_MANY_FUNDING_ATTEMPTS", message: "Too many deposit attempts." } },
});

const otpLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 2,
  keyGenerator,
  message: { success: false, error: { code: "OTP_LIMIT", message: "Wait a minute before requesting another OTP." } },
});

// -------------------------------------------------------------
// 6. CONSTANTS & MIDDLEWARE
// -------------------------------------------------------------
const BIGISUB_BASE_URL = "https://bigisub.ng/api";
const SERVER_BASE_URL = process.env.SERVER_BASE_URL;

const requireAuth = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ success: false, error: { code: "UNAUTHORIZED", message: "Missing header" } });
  }

  const token = authHeader.split(" ")[1];
  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) {
      return res.status(401).json({ success: false, error: { code: "UNAUTHORIZED", message: "Invalid session" } });
    }
    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ success: false, error: { code: "AUTH_ERROR", message: err.message } });
  }
};

// -------------------------------------------------------------
// 7. ROUTES
// -------------------------------------------------------------
app.get("/health", async (_req, res) => {
  try {
    const { error } = await supabase.from("orders").select("order_id").limit(1);
    if (error) throw error;
    res.json({ status: "OK", database: "connected", timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ status: "ERROR", database: "disconnected", details: err.message });
  }
});

app.post("/auth/send-otp", otpLimiter, async (req, res, next) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, error: { message: "Email is required" } });

    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();

    const sendSmtpEmail = new Brevo.SendSmtpEmail();
    sendSmtpEmail.subject = `${otpCode} is your Dreamhatcher Verification Code`;
    sendSmtpEmail.sender = { name: process.env.SENDER_NAME, email: process.env.SENDER_EMAIL };
    sendSmtpEmail.to = [{ email }];
    sendSmtpEmail.htmlContent = `
      <div style="font-family: Arial, sans-serif; padding: 20px;">
        <h2>Dreamhatcher VTU Verification</h2>
        <p>Your verification code is: <b style="font-size: 26px; color: #0A192F;">${otpCode}</b></p>
        <p>Expires in 10 minutes. Do not share this code with anyone.</p>
      </div>
    `;

    await brevoApi.sendTransacEmail(sendSmtpEmail);
    return res.json({ success: true, message: "OTP sent successfully" });
  } catch (err) {
    next(err);
  }
});

app.get("/services/variations", async (_req, res, next) => {
  try {
    const response = await axios.get(`${BIGISUB_BASE_URL}/data-plans`, {
      headers: { Authorization: `Token ${process.env.BIGISUB_API_KEY}` },
      timeout: 10000,
    });
    return res.json({ success: true, plans: response.data });
  } catch (err) {
    next(err);
  }
});

app.post("/wallet/initialize-funding", requireAuth, fundingLimiter, async (req, res, next) => {
  try {
    const userId = req.user.id;
    const userEmail = req.user.email;
    const { amount } = req.body;

    if (!amount || amount < 100) {
      return res.status(400).json({ success: false, error: { message: "Minimum deposit is 100 Naira" } });
    }

    const reference = `FUND-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;

    const { error: dbErr } = await supabase.from("wallet_deposits").insert([
      { user_id: userId, amount, reference, gateway: "squadco", status: "pending" },
    ]);

    if (dbErr) return res.status(500).json({ success: false, error: { message: "Could not log deposit" } });

    const squadResponse = await axios.post(
      "https://api-d.squadco.com/transaction/initiate",
      {
        email: userEmail,
        amount: Math.round(Number(amount) * 100),
        initiate_type: "inline",
        currency: "NGN",
        transaction_ref: reference,
        callback_url: `${SERVER_BASE_URL}/payment-callback`,
      },
      {
        headers: { Authorization: `Bearer ${process.env.SQUADCO_SECRET_KEY}` },
        timeout: 10000,
      }
    );

    if (squadResponse.data.status === 200) {
      return res.json({ success: true, checkoutUrl: squadResponse.data.data.checkout_url, reference });
    }

    return res.status(400).json({ success: false, error: { message: "Gateway error" } });
  } catch (err) {
    next(err);
  }
});

app.post("/orders", requireAuth, orderLimiter, async (req, res, next) => {
  const userId = req.user.id;
  const { networkId, planId, customerTarget, amount } = req.body;
  const idempotencyKey = req.headers["x-idempotency-key"];

  if (!idempotencyKey || !networkId || !planId || !customerTarget || !amount) {
    return res.status(400).json({ success: false, error: { message: "Missing required fields" } });
  }

  try {
    const { data: existingOrder } = await supabase
      .from("orders")
      .select("*")
      .eq("idempotency_key", idempotencyKey)
      .eq("user_id", userId)
      .maybeSingle();

    if (existingOrder) {
      return res.json({ success: true, orderId: existingOrder.order_id, status: existingOrder.status });
    }

    const { data: order, error: orderErr } = await supabase
      .from("orders")
      .insert([{ user_id: userId, service_type: "DATA", customer_target: customerTarget, amount, idempotency_key: idempotencyKey }])
      .select()
      .single();

    if (orderErr) throw new Error("Database error creating order");

    const requestId = order.order_id;

    const { data: debitSuccess, error: debitErr } = await supabase.rpc("debit_user_wallet", {
      p_user_id: userId,
      p_amount: amount,
      p_order_id: requestId,
      p_reference: `DEBIT-${requestId}`,
    });

    if (debitErr || !debitSuccess) {
      await supabase.from("orders").update({ status: "failed" }).eq("order_id", requestId);
      return res.status(400).json({ success: false, error: { message: "Insufficient balance" } });
    }

    try {
      const pspResponse = await axios.post(
        `${BIGISUB_BASE_URL}/data/`,
        { network: networkId, plan: planId, mobile_number: customerTarget, Ported_number: true },
        { headers: { Authorization: `Token ${process.env.BIGISUB_API_KEY}` }, timeout: 10000 }
      );

      const pspData = pspResponse.data;

      if (pspData.Status === "successful" || pspData.status === "true" || pspData.status === "successful") {
        await supabase.from("orders").update({ status: "success" }).eq("order_id", requestId);
        return res.json({ success: true, orderId: requestId, status: "success" });
      } else {
        await supabase.from("orders").update({ status: "failed" }).eq("order_id", requestId);
        await supabase.rpc("refund_user_wallet", {
          p_user_id: userId,
          p_amount: amount,
          p_order_id: requestId,
          p_reference: `REFUND-${requestId}`,
        });
        return res.status(400).json({ success: false, error: { message: "Provider rejected order. Refunded." } });
      }
    } catch (_apiErr) {
      return res.status(202).json({ success: true, orderId: requestId, status: "pending" });
    }
  } catch (err) {
    next(err);
  }
});

app.post("/webhooks/funding", async (req, res, next) => {
  try {
    const signature = req.headers["x-squad-encrypted-body"];
    const secret = process.env.SQUADCO_SECRET_KEY;

    if (!signature || !secret || !req.rawBody) {
      return res.status(401).json({ success: false, error: { message: "Unauthorized" } });
    }

    const expectedSignature = crypto.createHmac("sha512", secret).update(req.rawBody).digest("hex").toUpperCase();
    if (signature.toUpperCase() !== expectedSignature) {
      return res.status(401).json({ success: false, error: { message: "Invalid Signature" } });
    }

    const payload = req.body.Body || req.body.data || req.body;
    const eventName = req.body.Event || req.body.event;

    if (eventName === "charge_successful" || eventName === "charge.success") {
      const reference = payload.transaction_ref || payload.reference;
      const amountInNaira = Number(payload.amount) / 100;

      if (reference) {
        const { data: deposit } = await supabase.from("wallet_deposits").select("user_id").eq("reference", reference).maybeSingle();
        if (deposit) {
          await supabase.rpc("credit_deposit_atomically", {
            p_user_id: deposit.user_id,
            p_amount: amountInNaira,
            p_reference: reference,
            p_description: `Squadco Deposit (${reference})`,
          });
        }
      }
    }
    return res.status(200).send("OK");
  } catch (err) {
    next(err);
  }
});

const cronJob = cron.schedule("*/5 * * * *", () => {});

app.use((err, _req, res, _next) => {
  console.error("Error:", err.stack || err);
  res.status(500).json({ success: false, error: { message: err.message || "Internal error" } });
});

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Server active on port ${PORT}`));

process.on("SIGTERM", () => {
  cronJob.stop();
  server.close(() => process.exit(0));
});
