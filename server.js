if (process.env.NODE_ENV !== "production") {
  require("dotenv").config();
}

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json());

const BIGISUB_BASE_URL = "https://api.bigisub.ng";
const BIGISUB_TOKEN = process.env.BIGISUB_TOKEN || process.env.BIGISUB_API_KEY;

const client = axios.create({
  baseURL: BIGISUB_BASE_URL,
  headers: {
    "Authorization": `Token ${BIGISUB_TOKEN}`,
    "Content-Type": "application/json"
  }
});

// Helper for Bigisub Network IDs
function getNetworkId(net) {
  const map = { "1": 1, "mtn": 1, "2": 2, "airtel": 2, "3": 3, "glo": 3, "4": 4, "9mobile": 4 };
  return map[String(net || "").toLowerCase().trim()] || 1;
}

// -------------------------------------------------------------
// 1. DATA PLANS (Bigisub Spec Alignment)
// -------------------------------------------------------------
app.get("/api/v2/vtu/data/plans", async (req, res) => {
  try {
    const netId = getNetworkId(req.query.network);
    const response = await client.get(`/api/v2/vtu/data/plans/?network=${netId}`);
    
    // Normalize data array
    const rawPlans = response.data?.data || (Array.isArray(response.data) ? response.data : []);
    res.json({ success: true, data: rawPlans });
  } catch (err) {
    res.status(500).json({ success: false, message: err.response?.data?.message || err.message, data: [] });
  }
});

// -------------------------------------------------------------
// 2. RECHARGE PIN PLANS (Fixes "Denomination Not Available")
// -------------------------------------------------------------
app.get("/api/v2/vtu/recharge-pin/plans", async (req, res) => {
  try {
    const netId = getNetworkId(req.query.network);
    const response = await client.get(`/api/v2/vtu/recharge-pin/plans/?network=${netId}`);
    const plans = response.data?.data || (Array.isArray(response.data) ? response.data : []);
    res.json({ success: true, data: plans });
  } catch (err) {
    res.status(500).json({ success: false, message: err.response?.data?.message || err.message, data: [] });
  }
});

// -------------------------------------------------------------
// 3. ELECTRICITY METER VERIFICATION (Fixes "Verification Failed")
// -------------------------------------------------------------
app.post("/api/v2/bills/electricity/verify", async (req, res) => {
  try {
    const { company, meter_no, meter_type } = req.body;
    const response = await client.post("/api/v2/bills/electricity/verify/", {
      company: company || "ikeja-electric",
      meter_no: String(meter_no).trim(),
      meter_type: meter_type || "prepaid"
    });
    res.json(response.data);
  } catch (err) {
    res.status(400).json({ success: false, message: err.response?.data?.message || "Meter verification failed" });
  }
});

// -------------------------------------------------------------
// 4. EDUCATION EXAM PRICING (Fixes "No Exams Available")
// -------------------------------------------------------------
app.get("/api/v2/bills/result-checker/prices", async (_req, res) => {
  try {
    const response = await client.get("/api/v2/bills/result-checker/prices/");
    const prices = response.data?.data?.prices || response.data?.data || [];
    res.json({ success: true, data: prices });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message, data: [] });
  }
});

// HEALTH CHECK
app.get("/health", (_req, res) => res.json({ status: "OK", timestamp: new Date() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Production Server Active on port ${PORT}`));


// RECHARGE PIN PLANS
app.get("/api/v2/vtu/recharge-pin/plans", async (req, res) => {
  try {
    const netId = getNetworkId(req.query.network);
    const response = await bigiClient.get(`/api/v2/vtu/recharge-pin/plans/?network=${netId}`);
    const plans = response.data?.data || (Array.isArray(response.data) ? response.data : []);

    // Normalize data so Kotlin receives size, price, and info cleanly
    const normalized = plans.map(p => ({
      id: p.id,
      network: p.network,
      network_name: p.network_name,
      size: p.size || `N${p.regular_price || 0}`,
      regular_price: p.regular_price || p.amount || 0,
      corporate_price: p.corporate_price || 0,
      info: p.info || `${p.network_name || "MTN"} ${p.size || ""} Recharge Pin`
    }));

    res.json({ success: true, data: normalized });
  } catch (err) {
    console.error("❌ Recharge Pin Fetch Error:", err.response?.data || err.message);
    res.status(500).json({ success: false, message: err.message, data: [] });
  }
});