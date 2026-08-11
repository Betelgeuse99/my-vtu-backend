if (process.env.NODE_ENV !== "production") {
  require("dotenv").config();
}

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const { createClient } = require("@supabase/supabase-js");
const bigisub = require("./services/bigisub");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json());

// MANDATORY TRANSACTION LOGGER
async function saveTransactionToSupabase({ userId, title, serviceType, amount, recipient, status, reference }) {
  if (!userId) {
    console.warn("⚠️ Transaction not saved: userId missing.");
    return;
  }
  try {
    await supabase.from("transactions").insert([{
      user_id: userId,
      title: title || "Data Purchase",
      service_type: serviceType || "data",
      amount: Number(amount) || 0,
      recipient: String(recipient || ""),
      status: status || "successful",
      reference: reference || `DH_${Date.now()}`,
      created_at: new Date().toISOString()
    }]);
    console.log(`✅ Transaction logged for user: ${userId}`);
  } catch (err) {
    console.error("❌ Supabase DB Save Error:", err.message);
  }
}

// DATA BUNDLE PLAN LISTING
app.get("/api/v2/vtu/data/plans", async (req, res) => {
  try {
    const networkQuery = req.query.network || "1";
    const plans = await bigisub.getDataPlans(networkQuery);
    res.json({ success: true, data: plans });
  } catch (err) {
    res.status(500).json({ success: false, message: err.response?.data?.message || err.message, data: [] });
  }
});

// DATA BUNDLE PURCHASE
app.post("/api/v2/vtu/data/purchase", async (req, res) => {
  const { network, plan, phone_number, amount, userId, user_id } = req.body;
  const targetUserId = userId || user_id || req.headers["x-user-id"];

  try {
    const response = await bigisub.purchaseData({
      network,
      plan,
      phone_number,
      pin: process.env.BIGISUB_PIN || "1234"
    });

    if (response.success || response.data?.status === "successful" || response.data?.status === "processing") {
      await saveTransactionToSupabase({
        userId: targetUserId,
        title: `Data Top-up (${response.data?.network || network})`,
        serviceType: "data",
        amount: amount || response.data?.amount || 0,
        recipient: phone_number,
        status: "successful",
        reference: response.data?.reference || response.data?.transaction_id || `DH_${Date.now()}`
      });
    }

    res.json(response);
  } catch (err) {
    res.status(500).json({ success: false, message: err.response?.data?.message || err.message });
  }
});

// GET USER TRANSACTIONS HISTORY
app.get("/api/v2/transactions/:userId", async (req, res) => {
  try {
    const { data: txs, error } = await supabase
      .from("transactions")
      .select("*")
      .eq("user_id", req.params.userId)
      .order("created_at", { ascending: false });

    if (error) throw error;
    res.json({ success: true, data: txs || [] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get("/health", (_req, res) => res.json({ status: "OK", timestamp: new Date() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Bigisub-aligned Server active on port ${PORT}`));
