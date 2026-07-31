require("dotenv").config();
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const axios = require("axios");
const supabase = require("./config/supabase");

const app = express();
app.use(cors());
app.use(express.json());

const VTPASS_BASE_URL = process.env.VTPASS_ENV === "production" 
  ? "https://vtpass.com/api" 
  : "https://sandbox.vtpass.com/api";

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
    return res.status(401).json({ error: "Auth verification failed" });
  }
};

app.get("/health", (req, res) => res.json({ status: "OK", timestamp: new Date() }));

app.post("/services/verify", requireAuth, async (req, res) => {
  const { billCode, customerTarget, type } = req.body; 

  if (!billCode || !customerTarget) {
    return res.status(400).json({ error: "billCode and customerTarget are required" });
  }

  try {
    const payload = {
      serviceID: billCode,
      billersCode: customerTarget
    };
    if (type) payload.type = type;

    const response = await axios.post(`${VTPASS_BASE_URL}/merchant-verify`, payload, {
      headers: {
        "api-key": process.env.VTPASS_API_KEY,
        "secret-key": process.env.VTPASS_SECRET_KEY
      }
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
    return res.status(500).json({ error: "Verification service error", details: err.message });
  }
});

app.get("/services/variations", async (req, res) => {
  const { serviceID } = req.query;
  if (!serviceID) return res.status(400).json({ error: "serviceID query param is required" });

  try {
    const response = await axios.get(`${VTPASS_BASE_URL}/service-variations?serviceID=${serviceID}`, {
      headers: {
        "api-key": process.env.VTPASS_API_KEY,
        "public-key": process.env.VTPASS_PUBLIC_KEY
      }
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
    return res.status(500).json({ error: "Failed to fetch variations from PSP", details: err.message });
  }
});

app.post("/orders", requireAuth, async (req, res) => {
  const userId = req.user.id;
  const { serviceType, customerTarget, amount, billCode, variationCode } = req.body;

  const { data: order, error: orderErr } = await supabase
    .from("orders")
    .insert([{ user_id: userId, service_type: serviceType, customer_target: customerTarget, amount }])
    .select()
    .single();

  if (orderErr) return res.status(500).json({ error: "Database error initializing order" });

  const requestId = order.order_id;

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
      }
    });

    const pspData = pspResponse.data;

    await supabase.from("psp_transactions").insert([{
      order_id: requestId,
      psp_reference: pspData.requestId || pspData.transactionId,
      psp_status: pspData.code,
      raw_response: pspData,
      receipt_data: pspData.token ? { token: pspData.token, units: pspData.units } : null
    }]);

    if (pspData.code === "000") {
      await supabase.from("orders").update({ status: "success" }).eq("order_id", requestId);
      return res.json({ orderId: requestId, status: "success", message: "Order processed successfully" });
    } else if (pspData.code === "099") {
      return res.json({ orderId: requestId, status: "pending", message: "Order processing with provider" });
    } else {
      await supabase.from("orders").update({ status: "failed" }).eq("order_id", requestId);
      await supabase.rpc("refund_user_wallet", {
        p_user_id: userId,
        p_amount: amount,
        p_order_id: requestId,
        p_reference: `REFUND-${requestId}`
      });

      return res.status(400).json({ error: "Transaction failed at gateway. Wallet refunded.", pspCode: pspData.code });
    }

  } catch (err) {
    await supabase.from("orders").update({ status: "failed" }).eq("order_id", requestId);
    await supabase.rpc("refund_user_wallet", {
      p_user_id: userId,
      p_amount: amount,
      p_order_id: requestId,
      p_reference: `REFUND-EXC-${requestId}`
    });

    return res.status(500).json({ error: "PSP connection error. Wallet refunded." });
  }
});

app.post("/webhooks/psp", async (req, res) => {
  const signature = req.headers["x-vtpass-signature"];
  const secret = process.env.VTPASS_SECRET_KEY;

  if (signature) {
    const expectedSignature = crypto
      .createHmac("sha512", secret)
      .update(JSON.stringify(req.body))
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

  await supabase.from("psp_transactions").update({
    psp_status: code,
    receipt_data: content?.transactions ? content.transactions : null
  }).eq("order_id", request_id);

  return res.status(200).send("OK");
});

app.get("/orders/:orderId", requireAuth, async (req, res) => {
  const { orderId } = req.params;

  const { data: order } = await supabase
    .from("orders")
    .select("*, psp_transactions(receipt_data, psp_status)")
    .eq("order_id", orderId)
    .single();

  if (!order) return res.status(404).json({ error: "Order not found" });

  if (order.status === "pending") {
    try {
      const pspCheck = await axios.post(`${VTPASS_BASE_URL}/requery`, { request_id: orderId }, {
        headers: {
          "api-key": process.env.VTPASS_API_KEY,
          "secret-key": process.env.VTPASS_SECRET_KEY
        }
      });

      if (pspCheck.data.code === "000") {
        order.status = "success";
        await supabase.from("orders").update({ status: "success" }).eq("order_id", orderId);
      } else if (pspCheck.data.code === "016" || pspCheck.data.code === "084") {
        order.status = "failed";
        await supabase.from("orders").update({ status: "failed" }).eq("order_id", orderId);
        await supabase.rpc("refund_user_wallet", {
          p_user_id: order.user_id,
          p_amount: order.amount,
          p_order_id: orderId,
          p_reference: `REFUND-REQ-${orderId}`
        });
      }
    } catch (e) {
      // Requery exception handling
    }
  }

  return res.json({
    orderId: order.order_id,
    status: order.status,
    serviceType: order.service_type,
    amount: order.amount,
    receipt: order.psp_transactions[0]?.receipt_data || null
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Backend server running on port ${PORT}`));
