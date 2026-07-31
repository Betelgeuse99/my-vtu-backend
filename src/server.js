require("dotenv").config();
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const axios = require("axios");
const rateLimit = require("express-rate-limit");
const supabase = require("./config/supabase");

const app = express();

app.set("trust proxy", 1);
app.use(cors());

// Capture raw body buffer for HMAC webhook validation
app.use(express.json({
  verify: (req, _res, buf) => {
    req.rawBody = buf;
  }
}));

// Global Rate Limiting
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: "Too many requests, please try again later." }
});
app.use(globalLimiter);

const orderLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { error: "Too many purchase attempts. Please wait a minute." }
});

const VTPASS_BASE_URL = process.env.VTPASS_ENV === "production" 
  ? "https://vtpass.com/api" 
  : "https://sandbox.vtpass.com/api";

const SERVER_BASE_URL = process.env.SERVER_BASE_URL || "https://your-render-app.onrender.com";

// -------------------------------------------------------------
// AUTHENTICATION MIDDLEWARE
// -------------------------------------------------------------
const requireAuth = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized: Missing token header" });
  }

  const token = authHeader.split(" ")[1];

  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) {
      return res.status(401).json({ error: "Unauthorized: Invalid or expired token" });
    }
    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Auth verification failed", details: err.message });
  }
};

// Health Check
app.get("/health", (_req, res) => res.json({ status: "OK", timestamp: new Date().toISOString() }));

// -------------------------------------------------------------
// 1. SERVICE VALIDATION & VARIATIONS
// -------------------------------------------------------------
app.post("/services/verify", requireAuth, async (req, res, next) => {
  try {
    const { billCode, customerTarget, type } = req.body; 
    if (!billCode || !customerTarget) {
      return res.status(400).json({ error: "billCode and customerTarget are required" });
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

    return res.status(400).json({ success: false, error: data.response_description || "Validation failed" });
  } catch (err) {
    next(err);
  }
});

app.get("/services/variations", async (req, res, next) => {
  try {
    const { serviceID } = req.query;
    if (!serviceID) return res.status(400).json({ error: "serviceID query param is required" });

    const response = await axios.get(`${VTPASS_BASE_URL}/service-variations?serviceID=${serviceID}`, {
      headers: {
        "api-key": process.env.VTPASS_API_KEY,
        "public-key": process.env.VTPASS_PUBLIC_KEY
      },
      timeout: 10000
    });

    const variations = response.data.content?.varations || [];
    return res.json({
      serviceID,
      plans: variations.map(p => ({
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
app.post("/wallet/initialize-funding", requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.id;
    const userEmail = req.user.email;
    const { amount } = req.body;

    if (!amount || amount < 100) {
      return res.status(400).json({ error: "Minimum funding amount is 100 Naira" });
    }

    const reference = `FUND-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;

    await supabase.from("wallet_deposits").insert([{
      user_id: userId,
      amount: amount,
      reference: reference,
      gateway: "squadco",
      status: "pending"
    }]);

    const squadPayload = {
      email: userEmail,
      amount: Math.round(Number(amount) * 100), // Converted to Kobo
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

    return res.status(400).json({ error: "Could not initiate payment with gateway" });
  } catch (err) {
    next(err);
  }
});

// -------------------------------------------------------------
// 3. ATOMIC PURCHASE ORDERS (RESILIENT TIMEOUT HANDLING)
// -------------------------------------------------------------
app.post("/orders", requireAuth, orderLimiter, async (req, res, next) => {
  const userId = req.user.id;
  const { serviceType, customerTarget, amount, billCode, variationCode } = req.body;

  if (!serviceType || !customerTarget || !amount || !billCode) {
    return res.status(400).json({ error: "Missing required order fields" });
  }

  try {
    const { data: order, error: orderErr } = await supabase
      .from("orders")
      .insert([{ user_id: userId, service_type: serviceType, customer_target: customerTarget, amount }])
      .select()
      .single();

    if (orderErr) return res.status(500).json({ error: "Database error initializing order" });

    const requestId = order.order_id;

    // Atomic Balance Check & Debit
    const { data: debitSuccess, error: debitErr } = await supabase.rpc("debit_user_wallet", {
      p_user_id: userId,
      p_amount: amount,
      p_order_id: requestId,
      p_reference: `DEBIT-${requestId}`
    });

    if (debitErr || !debitSuccess) {
      await supabase.from("orders").update({ status: "failed" }).eq("order_id", requestId);
      return res.status(400).json({ error: "Insufficient wallet balance" });
    }

    // Call Provider API
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
        timeout: 15000
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
        return res.json({ orderId: requestId, status: "success", message: "Order processed successfully" });
      } else if (pspData.code === "099") {
        // Pending status
        return res.json({ orderId: requestId, status: "pending", message: "Order processing with provider" });
      } else {
        // Definite Failure -> Safe to Refund
        await supabase.from("orders").update({ status: "failed" }).eq("order_id", requestId);
        await supabase.rpc("refund_user_wallet", {
          p_user_id: userId,
          p_amount: amount,
          p_order_id: requestId,
          p_reference: `REFUND-${requestId}`
        });

        return res.status(400).json({ error: "Transaction failed at gateway. Wallet refunded.", pspCode: pspData.code });
      }

    } catch (_apiErr) {
      // NETWORK TIMEOUT OR UNCERTAIN FAILURE: Leave as 'pending' for Requery worker
      return res.status(202).json({
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
// 4. REQUERY WORKER ROUTE (SAFE RECONCILIATION FOR PENDING ORDERS)
// -------------------------------------------------------------
app.post("/orders/check-pending", async (_req, res, next) => {
  try {
    const { data: pendingOrders } = await supabase
      .from("orders")
      .select("*")
      .eq("status", "pending")
      .limit(20);

    if (!pendingOrders || pendingOrders.length === 0) {
      return res.json({ status: "OK", processed: 0 });
    }

    let processedCount = 0;

    for (const order of pendingOrders) {
      try {
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
          processedCount++;
        } else if (["011", "016", "084", "010"].includes(pspData.code)) {
          // Confirmed failed statuses
          await supabase.from("orders").update({ status: "failed", updated_at: new Date() }).eq("order_id", order.order_id);
          await supabase.rpc("refund_user_wallet", {
            p_user_id: order.user_id,
            p_amount: order.amount,
            p_order_id: order.order_id,
            p_reference: `REFUND-REQ-${order.order_id}`
          });
          processedCount++;
        }
      } catch (_e) {
        // Skip and retry on next poll cycle
      }
    }

    return res.json({ status: "OK", processed: processedCount });
  } catch (err) {
    next(err);
  }
});

// -------------------------------------------------------------
// 5. SQUADCO FUNDING WEBHOOK (HARDENED HMAC & NESTED PARSING)
// -------------------------------------------------------------
app.post("/webhooks/funding", async (req, res, next) => {
  try {
    const signature = req.headers["x-squad-encrypted-body"];
    const secret = process.env.SQUADCO_SECRET_KEY;

    if (signature && secret && req.rawBody) {
      const expectedSignature = crypto
        .createHmac("sha512", secret)
        .update(req.rawBody)
        .digest("hex")
        .toUpperCase();

      if (signature.toUpperCase() !== expectedSignature) {
        return res.status(401).send("Invalid Webhook Signature");
      }
    }

    // Safely extract from nested payload structures
    const payload = req.body.Body || req.body.data || req.body;
    const eventName = req.body.Event || req.body.event;

    if (eventName === "charge_successful" || eventName === "charge.success") {
      const reference = payload.transaction_ref || payload.reference;
      const amountInKobo = payload.amount;
      const amountInNaira = Number(amountInKobo) / 100;

      if (reference) {
        const { data: deposit } = await supabase
          .from("wallet_deposits")
          .select("*")
          .eq("reference", reference)
          .single();

        if (deposit && deposit.status === "pending") {
          await supabase
            .from("wallet_deposits")
            .update({ status: "success", updated_at: new Date() })
            .eq("reference", reference);

          await supabase.rpc("credit_user_wallet", {
            p_user_id: deposit.user_id,
            p_amount: amountInNaira,
            p_reference: reference,
            p_description: `Squadco Wallet Deposit (${reference})`
          });
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

    if (signature && secret && req.rawBody) {
      const expectedSignature = crypto
        .createHmac("sha512", secret)
        .update(req.rawBody)
        .digest("hex");

      if (signature !== expectedSignature) {
        return res.status(401).send("Invalid Webhook Signature");
      }
    }

    const { request_id, code, content } = req.body;

    await supabase.from("webhook_events").insert([{
      psp_reference: request_id,
      signature: signature || "none",
      raw_payload: req.body,
      processed: true
    }]);

    const { data: order } = await supabase.from("orders").select("*").eq("order_id", request_id).single();
    if (!order || order.status !== "pending") return res.status(200).send("OK (Already Processed)");

    if (code === "000") {
      await supabase.from("orders").update({ status: "success", updated_at: new Date() }).eq("order_id", request_id);
    } else {
      await supabase.from("orders").update({ status: "failed", updated_at: new Date() }).eq("order_id", request_id);
      await supabase.rpc("refund_user_wallet", {
        p_user_id: order.user_id,
        p_amount: order.amount,
        p_order_id: request_id,
        p_reference: `REFUND-WH-${request_id}`
      });
    }

    return res.status(200).send("OK");
  } catch (err) {
    next(err);
  }
});

// Centralized Error Handler
app.use((err, _req, res, _next) => {
  console.error("Unhandled Server Error:", err.stack || err);
  res.status(500).json({ error: "Internal Server Error", details: err.message });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`Backend server running on port ${PORT}`));
