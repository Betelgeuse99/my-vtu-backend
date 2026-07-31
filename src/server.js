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

// Health Check
app.get("/health", (req, res) => res.json({ status: "OK", timestamp: new Date() }));

// GET /services/variations - Fetch Data/Cable Plans
app.get("/services/variations", async (req, res) => {
  const { serviceID } = req.query; // e.g., mtn-data, dstv
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

// POST /orders - Create Order & Pay PSP
app.post("/orders", async (req, res) => {
  const { userId, serviceType, customerTarget, amount, billCode, variationCode } = req.body;

  const { data: order, error: orderErr } = await supabase
    .from("orders")
    .insert([{ user_id: userId, service_type: serviceType, customer_target: customerTarget, amount }])
    .select()
    .single();

  if (orderErr) return res.status(500).json({ error: "Database error initializing order", details: orderErr });

  const requestId = order.order_id;

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
    }

    return res.json({
      orderId: requestId,
      status: pspData.code === "000" ? "success" : "pending",
      message: "Order processed"
    });
  } catch (err) {
    await supabase.from("orders").update({ status: "failed" }).eq("order_id", requestId);
    return res.status(500).json({ error: "PSP execution failed", details: err.message });
  }
});

// POST /webhooks/psp - Webhook Listener with HMAC Validation
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

  const finalStatus = code === "000" ? "success" : "failed";

  await supabase.from("orders").update({ status: finalStatus, updated_at: new Date() }).eq("order_id", request_id);
  await supabase.from("psp_transactions").update({
    psp_status: code,
    receipt_data: content?.transactions ? content.transactions : null
  }).eq("order_id", request_id);

  return res.status(200).send("OK");
});

// GET /orders/:orderId - Status & Polling Endpoint
app.get("/orders/:orderId", async (req, res) => {
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
      }
    } catch (e) {
      // Ignore requery error during polling
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
