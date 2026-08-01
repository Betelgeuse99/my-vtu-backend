require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const crypto = require("crypto");
const axios = require("axios");
const rateLimit = require("express-rate-limit");
const cron = require("node-cron");
const supabase = require("./config/supabase");

// -------------------------------------------------------------
// STRUCTURED LOGGING HELPER
// -------------------------------------------------------------
const log = {
  info: (msg, meta = {}) => console.log(JSON.stringify({ level: "info", timestamp: new Date().toISOString(), message: msg, ...meta })),
  warn: (msg, meta = {}) => console.warn(JSON.stringify({ level: "warn", timestamp: new Date().toISOString(), message: msg, ...meta })),
  error: (msg, meta = {}) => console.error(JSON.stringify({ level: "error", timestamp: new Date().toISOString(), message: msg, ...meta }))
};

// -------------------------------------------------------------
// 1. STARTUP ENVIRONMENT VALIDATION
// -------------------------------------------------------------
const REQUIRED_ENV_VARS = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SQUADCO_SECRET_KEY",
  "VTPASS_API_KEY",
  "VTPASS_SECRET_KEY",
  "VTPASS_PUBLIC_KEY"
];

const missingVars = REQUIRED_ENV_VARS.filter((key) => !process.env[key]);
if (missingVars.length > 0) {
  log.error("Missing required environment variables", { missingVars });
  process.exit(1);
}

// -------------------------------------------------------------
// 2. PRE-FLIGHT DATABASE RPC VALIDATION
// -------------------------------------------------------------
const validateDatabaseRPCs = async () => {
  try {
    const dummyUuid = "00000000-0000-0000-0000-000000000000";
    const { error: debitErr } = await supabase.rpc("debit_user_wallet", {
      p_user_id: dummyUuid, p_amount: 0, p_order_id: "0", p_reference: "TEST"
    });
    const { error: creditErr } = await supabase.rpc("credit_user_wallet", {
      p_user_id: dummyUuid, p_amount: 0, p_reference: "TEST", p_description: "TEST"
    });
    const { error: refundErr } = await supabase.rpc("refund_user_wallet", {
      p_user_id: dummyUuid, p_amount: 0, p_order_id: "0", p_reference: "TEST"
    });
    const { error: depositErr } = await supabase.rpc("credit_deposit_atomically", {
      p_user_id: dummyUuid, p_amount: 0, p_reference: "TEST", p_description: "TEST"
    });

    if (
      debitErr?.code === "PGRST202" || 
      creditErr?.code === "PGRST202" || 
      refundErr?.code === "PGRST202" ||
      depositErr?.code === "PGRST202"
    ) {
      log.error("One or more PostgreSQL RPC functions are missing in Supabase!");
      process.exit(1);
    }
    log.info("All PostgreSQL RPC functions verified successfully.");
  } catch (err) {
    log.error("Pre-flight database check failed", { error: err.message });
  }
};
validateDatabaseRPCs();

const app = express();

app.set("trust proxy", 1);
app.use(helmet());

const allowedOrigins = process.env.ALLOWED_ORIGINS 
  ? process.env.ALLOWED_ORIGINS.split(",") 
  : ["http://localhost:3000", process.env.SERVER_BASE_URL].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error("CORS policy restriction: Origin not allowed"));
    }
  },
  credentials: true
}));

app.use(express.json({
  verify: (req, _res, buf) => {
    req.rawBody = buf;
  }
}));

// -------------------------------------------------------------
// RATE LIMITERS
// -------------------------------------------------------------
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { success: false, error: { code: "RATE_LIMIT_EXCEEDED", message: "Too many requests. Please try again later." } }
});
app.use(globalLimiter);

const orderLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  keyGenerator: (req) => req.user?.id || req.ip,
  message: { success: false, error: { code: "TOO_MANY_ORDERS", message: "Too many purchase attempts. Please wait a minute." } }
});

// Dedicated limiter for external payment gateway initialization
const fundingLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 3,
  keyGenerator: (req) => req.user?.id || req.ip,
  message: { success: false, error: { code: "TOO_MANY_FUNDING_ATTEMPTS", message: "Too many deposit attempts. Please wait 1 minute before trying again." } }
});

const VTPASS_BASE_URL = process.env.VTPASS_ENV === "production" 
  ? "https://vtpass.com/api" 
  : "https://sandbox.vtpass.com/api";

const SERVER_BASE_URL = process.env.SERVER_BASE_URL || "https://your-render-app.onrender.com";
const FRONTEND_APP_URL = process.env.FRONTEND_APP_URL || "https://your-app-domain.com";

const VTPASS_TERMINAL_FAILURES = ["011", "016", "084", "010", "012", "013", "014", "015", "017", "018", "019", "021", "022", "023", "024", "025", "026", "027"];

// -------------------------------------------------------------
// AUTHENTICATION MIDDLEWARE
// -------------------------------------------------------------
const requireAuth = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ success: false, error: { code: "UNAUTHORIZED", message: "Missing authorization header" } });
  }

  const token = authHeader.split(" ")[1];

  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) {
      return res.status(401).json({ success: false, error: { code: "UNAUTHORIZED", message: "Invalid or expired session token" } });
    }
    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ success: false, error: { code: "AUTH_ERROR", message: err.message } });
  }
};

const requireAdminSecret = (req, res, next) => {
  const apiKey = req.headers["x-api-key"];
  const secretKey = process.env.CRON_SECRET_KEY || process.env.SQUADCO_SECRET_KEY;
  if (!apiKey || apiKey !== secretKey) {
    return res.status(403).json({ success: false, error: { code: "FORBIDDEN", message: "Forbidden: Invalid system key" } });
  }
  next();
};

// Lightweight zero-overhead DB ping
app.get("/health", async (_req, res) => {
  try {
    const { error } = await supabase.rpc("version"); // Extremely lightweight built-in PG ping
    if (error) {
      // Fallback query if RPC disabled
      const { error: pingErr } = await supabase.from("wallets").select("user_id").limit(1);
      if (pingErr) throw pingErr;
    }
    res.json({ status: "OK", database: "connected", timestamp: new Date().toISOString() });
  } catch (err) {
    log.error("Health check failed", { error: err.message });
    res.status(500).json({ status: "ERROR", database: "disconnected", details: err.message });
  }
});

// -------------------------------------------------------------
// PAYMENT CALLBACK ROUTE (REDIRECT TO APP / SPA)
// -------------------------------------------------------------
app.get("/payment-callback", (req, res) => {
  const { reference } = req.query;
  // Deep-link or redirect back to client application route
  const targetUrl = `${FRONTEND_APP_URL}/dashboard?payment_status=complete&ref=${encodeURIComponent(reference || "")}`;
  res.redirect(302, targetUrl);
});

// -------------------------------------------------------------
// 1. SERVICE VALIDATION & VARIATIONS
// -------------------------------------------------------------
app.post("/services/verify", requireAuth, async (req, res, next) => {
  try {
    const { billCode, customerTarget, type } = req.body; 
    if (!billCode || !customerTarget) {
      return res.status(400).json({ success: false, error: { code: "INVALID_INPUT", message: "billCode and customerTarget are required" } });
    }

    const payload = { serviceID: billCode, billersCode: customerTarget };
    if (type) payload.type = type;

    const response = await axios.post(`${VTPASS_BASE_URL}/merchant-verify`, payload, {
      headers: {
        "api-key": process.env.VTPASS_API_KEY,
        "secret-key": process.env.VTPASS_SECRET_KEY
      },
      timeout: 10000
    });

    const data = response.data;
    if (data.code === "000" && data.content) {
      return res.json({
        success: true,
        customerName: data.content.Customer_Name || data.content.name || "Customer Validated",
        raw: data.content
      });
    }

    return res.status(400).json({ success: false, error: { code: "VERIFICATION_FAILED", message: data.response_description || "Validation failed" } });
  } catch (err) {
    next(err);
  }
});

app.get("/services/variations", async (req, res, next) => {
  try {
    const { serviceID } = req.query;
    if (!serviceID) {
      return res.status(400).json({ success: false, error: { code: "INVALID_INPUT", message: "serviceID query param is required" } });
    }

    const response = await axios.get(`${VTPASS_BASE_URL}/service-variations?serviceID=${serviceID}`, {
      headers: {
        "api-key": process.env.VTPASS_API_KEY,
        "public-key": process.env.VTPASS_PUBLIC_KEY
      },
      timeout: 10000
    });

    const variations = response.data.content?.varations || response.data.content?.variations || [];

    return res.json({
      success: true,
      serviceID,
      plans: variations.map((p) => ({
        variationCode: p.variation_code,
        name: p.name,
        amount: p.variation_amount
      }))
    });
  } catch (err) {
    next(err);
  }
});

// -------------------------------------------------------------
// 2. WALLET FUNDING INITIATION
// -------------------------------------------------------------
app.post("/wallet/initialize-funding", requireAuth, fundingLimiter, async (req, res, next) => {
  try {
    const userId = req.user.id;
    const userEmail = req.user.email;
    const { amount } = req.body;

    if (!amount || amount < 100) {
      return res.status(400).json({ success: false, error: { code: "INVALID_AMOUNT", message: "Minimum funding amount is 100 Naira" } });
    }

    const reference = `FUND-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;

    const { error: dbErr } = await supabase.from("wallet_deposits").insert([{
      user_id: userId,
      amount: amount,
      reference: reference,
      gateway: "squadco",
      status: "pending"
    }]);

    if (dbErr) {
      return res.status(500).json({ success: false, error: { code: "DB_ERROR", message: "Could not create deposit record" } });
    }

    const squadPayload = {
      email: userEmail,
      amount: Math.round(Number(amount) * 100),
      initiate_type: "inline",
      currency: "NGN",
      transaction_ref: reference,
      callback_url: `${SERVER_BASE_URL}/payment-callback`
    };

    const squadResponse = await axios.post(
      "https://api-d.squadco.com/transaction/initiate",
      squadPayload,
      {
        headers: { Authorization: `Bearer ${process.env.SQUADCO_SECRET_KEY}` },
        timeout: 10000
      }
    );

    if (squadResponse.data.status === 200) {
      return res.json({
        success: true,
        checkoutUrl: squadResponse.data.data.checkout_url,
        reference: reference
      });
    }

    return res.status(400).json({ success: false, error: { code: "GATEWAY_ERROR", message: "Could not initiate payment with gateway" } });
  } catch (err) {
    next(err);
  }
});

// -------------------------------------------------------------
// 3. ATOMIC PURCHASE ORDERS (MANDATORY IDEMPOTENCY)
// -------------------------------------------------------------
app.post("/orders", requireAuth, orderLimiter, async (req, res, next) => {
  const userId = req.user.id;
  const { serviceType, customerTarget, amount, billCode, variationCode } = req.body;
  const idempotencyKey = req.headers["x-idempotency-key"];

  if (!idempotencyKey) {
    return res.status(400).json({
      success: false,
      error: { code: "MISSING_IDEMPOTENCY_KEY", message: "X-Idempotency-Key header is required for purchase orders" }
    });
  }

  if (!serviceType || !customerTarget || !amount || !billCode) {
    return res.status(400).json({ success: false, error: { code: "INVALID_INPUT", message: "Missing required order fields" } });
  }

  try {
    const { data: existingOrder } = await supabase
      .from("orders")
      .select("*")
      .eq("idempotency_key", idempotencyKey)
      .eq("user_id", userId)
      .maybeSingle();

    if (existingOrder) {
      return res.json({
        success: true,
        orderId: existingOrder.order_id,
        status: existingOrder.status,
        message: "Returned existing order (Idempotency matched)"
      });
    }

    const { data: order, error: orderErr } = await supabase
      .from("orders")
      .insert([{
        user_id: userId,
        service_type: serviceType,
        customer_target: customerTarget,
        amount,
        idempotency_key: idempotencyKey
      }])
      .select()
      .single();

    if (orderErr) return res.status(500).json({ success: false, error: { code: "DB_ERROR", message: "Database error initializing order" } });

    const requestId = order.order_id;

    const { data: debitSuccess, error: debitErr } = await supabase.rpc("debit_user_wallet", {
      p_user_id: userId,
      p_amount: amount,
      p_order_id: requestId,
      p_reference: `DEBIT-${requestId}`
    });

    if (debitErr || !debitSuccess) {
      await supabase.from("orders").update({ status: "failed" }).eq("order_id", requestId);
      return res.status(400).json({ success: false, error: { code: "INSUFFICIENT_FUNDS", message: "Insufficient wallet balance" } });
    }

    try {
      const pspPayload = {
        request_id: requestId,
        serviceID: billCode,
        billersCode: customerTarget,
        amount: amount,
        phone: customerTarget
      };
      if (variationCode) pspPayload.variation_code = variationCode;

      const pspResponse = await axios.post(`${VTPASS_BASE_URL}/pay`, pspPayload, {
        headers: {
          "api-key": process.env.VTPASS_API_KEY,
          "secret-key": process.env.VTPASS_SECRET_KEY
        },
        timeout: 10000
      });

      const pspData = pspResponse.data;

      await supabase.from("psp_transactions").insert([{
        order_id: requestId,
        psp_reference: pspData.requestId || pspData.transactionId || requestId,
        psp_status: pspData.code,
        raw_response: pspData,
        receipt_data: pspData.token ? { token: pspData.token, units: pspData.units } : null
      }]);

      if (pspData.code === "000") {
        await supabase.from("orders").update({ status: "success" }).eq("order_id", requestId);
        log.info("Order successful", { orderId: requestId, userId, amount });
        return res.json({ success: true, orderId: requestId, status: "success", message: "Order processed successfully" });
      } else if (pspData.code === "099") {
        log.info("Order pending vendor processing", { orderId: requestId, userId });
        return res.json({ success: true, orderId: requestId, status: "pending", message: "Order processing with provider" });
      } else {
        await supabase.from("orders").update({ status: "failed" }).eq("order_id", requestId);
        await supabase.rpc("refund_user_wallet", {
          p_user_id: userId,
          p_amount: amount,
          p_order_id: requestId,
          p_reference: `REFUND-${requestId}`
        });

        log.warn("Order failed at gateway - refunded wallet", { orderId: requestId, pspCode: pspData.code });
        return res.status(400).json({ success: false, error: { code: "VENDOR_REJECTED", message: "Transaction failed at gateway. Wallet refunded.", pspCode: pspData.code } });
      }

    } catch (_apiErr) {
      log.warn("Network timeout calling vendor - left order pending", { orderId: requestId });
      return res.status(202).json({
        success: true,
        orderId: requestId,
        status: "pending",
        message: "Order submitted. Verification in progress."
      });
    }
  } catch (err) {
    next(err);
  }
});

// -------------------------------------------------------------
// 4. REQUERY WORKER ROUTE & DEAD-LETTER CONCURRENCY LOCK
// -------------------------------------------------------------
let isReconciling = false;

const reconcilePendingOrders = async () => {
  if (isReconciling) {
    log.info("Requery worker already executing, skipping concurrent run.");
    return 0;
  }
  isReconciling = true;

  try {
    const { data: pendingOrders } = await supabase
      .from("orders")
      .select("*")
      .eq("status", "pending")
      .limit(20);

    if (!pendingOrders || pendingOrders.length === 0) return 0;

    let processedCount = 0;
    const now = new Date();

    for (const order of pendingOrders) {
      try {
        const orderAgeMinutes = (now - new Date(order.created_at)) / (1000 * 60);

        if (orderAgeMinutes > 30) {
          await supabase.from("orders").update({ status: "failed", updated_at: now }).eq("order_id", order.order_id);
          await supabase.rpc("refund_user_wallet", {
            p_user_id: order.user_id,
            p_amount: order.amount,
            p_order_id: order.order_id,
            p_reference: `REFUND-DEADLETTER-${order.order_id}`
          });
          log.info("Dead letter refund issued for timed-out pending order", { orderId: order.order_id });
          processedCount++;
          continue;
        }

        const pspCheck = await axios.post(`${VTPASS_BASE_URL}/requery`, { request_id: order.order_id }, {
          headers: {
            "api-key": process.env.VTPASS_API_KEY,
            "secret-key": process.env.VTPASS_SECRET_KEY
          },
          timeout: 10000
        });

        const pspData = pspCheck.data;

        if (pspData.code === "000") {
          await supabase.from("orders").update({ status: "success", updated_at: new Date() }).eq("order_id", order.order_id);
          log.info("Requery reconciled order as SUCCESS", { orderId: order.order_id });
          processedCount++;
        } else if (VTPASS_TERMINAL_FAILURES.includes(pspData.code)) {
          await supabase.from("orders").update({ status: "failed", updated_at: new Date() }).eq("order_id", order.order_id);
          await supabase.rpc("refund_user_wallet", {
            p_user_id: order.user_id,
            p_amount: order.amount,
            p_order_id: order.order_id,
            p_reference: `REFUND-REQ-${order.order_id}`
          });
          log.info("Requery reconciled order as FAILED - refunded wallet", { orderId: order.order_id, pspCode: pspData.code });
          processedCount++;
        }
      } catch (_e) {
        // Leave pending for next cycle
      }
    }
    return processedCount;
  } catch (err) {
    log.error("Requery worker error", { error: err.message });
    return 0;
  } finally {
    isReconciling = false;
  }
};

const cronJob = cron.schedule("*/5 * * * *", async () => {
  const processed = await reconcilePendingOrders();
  if (processed > 0) log.info(`Reconciled ${processed} pending order(s).`);
});

app.post("/orders/check-pending", requireAdminSecret, async (_req, res, next) => {
  try {
    const processed = await reconcilePendingOrders();
    return res.json({ success: true, processed });
  } catch (err) {
    next(err);
  }
});

// -------------------------------------------------------------
// 5. SQUADCO WEBHOOK
// -------------------------------------------------------------
app.post("/webhooks/funding", async (req, res, next) => {
  try {
    const signature = req.headers["x-squad-encrypted-body"];
    const secret = process.env.SQUADCO_SECRET_KEY;

    if (!signature || !secret || !req.rawBody) {
      return res.status(401).json({ success: false, error: { code: "UNAUTHORIZED", message: "Missing webhook signature or raw body" } });
    }

    const expectedSignature = crypto
      .createHmac("sha512", secret)
      .update(req.rawBody)
      .digest("hex")
      .toUpperCase();

    if (signature.toUpperCase() !== expectedSignature) {
      return res.status(401).json({ success: false, error: { code: "UNAUTHORIZED", message: "Invalid Webhook Signature" } });
    }

    const payload = req.body.Body || req.body.data || req.body;
    const eventName = req.body.Event || req.body.event;

    if (eventName === "charge_successful" || eventName === "charge.success") {
      const reference = payload.transaction_ref || payload.reference;
      const amountInKobo = payload.amount;
      const amountInNaira = Number(amountInKobo) / 100;

      if (reference) {
        const { data: deposit } = await supabase
          .from("wallet_deposits")
          .select("user_id")
          .eq("reference", reference)
          .maybeSingle();

        if (deposit) {
          const { data: isCredited, error: rpcErr } = await supabase.rpc("credit_deposit_atomically", {
            p_user_id: deposit.user_id,
            p_amount: amountInNaira,
            p_reference: reference,
            p_description: `Squadco Deposit (${reference})`
          });

          if (rpcErr || !isCredited) {
            log.warn("Deposit credit returned false or failed (Already processed)", { reference });
          } else {
            log.info("Deposit credited successfully", { reference, amountInNaira });
          }
        }
      }
    }

    return res.status(200).send("OK");
  } catch (err) {
    next(err);
  }
});

// -------------------------------------------------------------
// 6. VTPASS WEBHOOK
// -------------------------------------------------------------
app.post("/webhooks/psp", async (req, res, next) => {
  try {
    const signature = req.headers["x-vtpass-signature"];
    const secret = process.env.VTPASS_SECRET_KEY;

    if (!signature || !secret || !req.rawBody) {
      return res.status(401).json({ success: false, error: { code: "UNAUTHORIZED", message: "Missing webhook signature or raw body" } });
    }

    const expectedSignature = crypto
      .createHmac("sha512", secret)
      .update(req.rawBody)
      .digest("hex");

    if (signature !== expectedSignature) {
      return res.status(401).json({ success: false, error: { code: "UNAUTHORIZED", message: "Invalid Webhook Signature" } });
    }

    const { request_id, code } = req.body;

    const { data: existingEvent } = await supabase
      .from("webhook_events")
      .select("id")
      .eq("psp_reference", request_id)
      .maybeSingle();

    if (existingEvent) {
      return res.status(200).send("OK (Duplicate Webhook Ignored)");
    }

    await supabase.from("webhook_events").insert([{
      psp_reference: request_id,
      signature: signature,
      raw_payload: req.body,
      processed: true
    }]);

    const { data: order, error: fetchErr } = await supabase
      .from("orders")
      .select("*")
      .eq("order_id", request_id)
      .maybeSingle();

    if (fetchErr || !order) {
      return res.status(200).send("OK (Order not found)");
    }

    if (order.status !== "pending") {
      return res.status(200).send("OK (Order already finalized)");
    }

    if (code === "000") {
      await supabase.from("orders").update({ status: "success", updated_at: new Date() }).eq("order_id", request_id);
      log.info("PSP Webhook confirmed order SUCCESS", { orderId: request_id });
    } else {
      await supabase.from("orders").update({ status: "failed", updated_at: new Date() }).eq("order_id", request_id);
      await supabase.rpc("refund_user_wallet", {
        p_user_id: order.user_id,
        p_amount: order.amount,
        p_order_id: request_id,
        p_reference: `REFUND-WH-${request_id}`
      });
      log.info("PSP Webhook confirmed order FAILED - refunded wallet", { orderId: request_id });
    }

    return res.status(200).send("OK");
  } catch (err) {
    next(err);
  }
});

// -------------------------------------------------------------
// CENTRALIZED ERROR HANDLER & FULL GRACEFUL SHUTDOWN
// -------------------------------------------------------------
app.use((err, _req, res, _next) => {
  log.error("Unhandled Exception", { error: err.message, stack: err.stack });
  const isProd = process.env.NODE_ENV === "production";
  res.status(500).json({
    success: false,
    error: {
      code: "INTERNAL_SERVER_ERROR",
      message: err.message || "An unexpected error occurred",
      ...(isProd ? {} : { details: err.stack })
    }
  });
});

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, "0.0.0.0", () => log.info(`Production backend active on port ${PORT}`));

// Complete Graceful Teardown
process.on("SIGTERM", () => {
  log.info("SIGTERM received. Stopping cron jobs and shutting down HTTP server...");
  cronJob.stop();
  server.close(() => {
    log.info("HTTP server closed. System clean.");
    process.exit(0);
  });
});
