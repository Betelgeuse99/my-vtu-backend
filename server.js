if (process.env.NODE_ENV !== "production") {
  require("dotenv").config();
}

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const SibApiV3Sdk = require('sib-api-v3-sdk');
const { createClient } = require("@supabase/supabase-js");
const bigisub = require("./services/bigisub");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const defaultClient = SibApiV3Sdk.ApiClient.instance;
defaultClient.authentications['api-key'].apiKey = process.env.BREVO_API_KEY;
const transacEmailApi = new SibApiV3Sdk.TransactionalEmailsApi();

const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json());

const DEFAULT_PIN = process.env.BIGISUB_PIN || "1234";

// MANDATORY TRANSACTION LOGGER
async function saveTransactionToSupabase({ userId, title, serviceType, amount, recipient, status, reference }) {
  if (!userId) {
    console.error("❌ CRITICAL ERROR: Cannot save transaction because userId is NULL/undefined!");
    return false;
  }
  
  try {
    const payload = {
      user_id: userId,
      title: title || "VTU Purchase",
      service_type: serviceType,
      amount: Number(amount) || 0,
      recipient: String(recipient || ""),
      status: status || "successful",
      reference: reference || `DH_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      created_at: new Date().toISOString()
    };

    console.log("📝 Attempting Supabase Insert Payload:", payload);

    const { data, error } = await supabase.from("transactions").insert([payload]).select();

    if (error) {
      console.error("❌ SUPABASE DB INSERT FAILED:", error.message, error.details);
      return false;
    }

    console.log("✅ SUPABASE DB INSERT SUCCESSFUL:", data);
    return true;
  } catch (err) {
    console.error("❌ EXCEPTION IN TRANSACTION LOGGER:", err.message);
    return false;
  }
}

// -------------------------------------------------------------
// AUTHENTICATION ROUTES
// -------------------------------------------------------------
app.post("/auth/send-otp", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ success: false, message: "Email required" });
  const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
  const cleanEmail = email.toLowerCase().trim();
  try {
    await supabase.from("temp_otps").upsert({ email: cleanEmail, otp: otpCode });
    const sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();
    sendSmtpEmail.subject = `${otpCode} is your Dreamhatcher Verification Code`;
    sendSmtpEmail.sender = { name: process.env.SENDER_NAME, email: process.env.SENDER_EMAIL };
    sendSmtpEmail.to = [{ email: cleanEmail }];
    sendSmtpEmail.htmlContent = `<html><body><h2>Dreamhatcher Verification</h2><p>Your code is: <b>${otpCode}</b></p></body></html>`;
    await transacEmailApi.sendTransacEmail(sendSmtpEmail);
    res.json({ success: true, message: "OTP sent" });
  } catch (err) {
    res.status(500).json({ success: false, message: "Service busy. Try again." });
  }
});

app.post("/auth/verify-otp", async (req, res) => {
  const email = (req.body.email || "").toLowerCase().trim();
  const otp = (req.body.otp || "").trim();
  const rawPassword = req.body.password;
  const password = rawPassword && rawPassword.trim().length >= 6 ? rawPassword.trim() : "Dreamhatcher@2026#Secure";
  const fullName = req.body.full_name || req.body.fullName || "User";
  const phoneNumber = req.body.phone_number || req.body.phoneNumber || "";

  if (!email || !otp) return res.status(400).json({ success: false, message: "Email and OTP required" });

  try {
    const { data: otpData } = await supabase.from("temp_otps").select("*").eq("email", email).eq("otp", otp).single();
    if (!otpData) return res.status(400).json({ success: false, message: "Invalid or expired OTP." });

    let userId;
    const { data: userList } = await supabase.auth.admin.listUsers();
    const existing = userList?.users?.find(u => u.email === email);

    if (existing) {
      userId = existing.id;
      await supabase.auth.admin.updateUserById(userId, { password, user_metadata: { full_name: fullName } });
    } else {
      const { data: authUser, error: authError } = await supabase.auth.admin.createUser({
        email, password, email_confirm: true, user_metadata: { full_name: fullName }
      });
      if (authError) throw authError;
      userId = authUser.user.id;
    }

    const { data: profile } = await supabase.from("profiles").upsert({
      id: userId, full_name: fullName, phone_number: phoneNumber, email, email_verified: true
    }, { onConflict: "id" }).select().single();

    await supabase.from("wallets").upsert({ user_id: userId, balance: 0 }, { onConflict: "user_id" });
    await supabase.from("temp_otps").delete().eq("email", email);

    res.json({ success: true, message: "Verification successful", userId, user: profile });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post("/auth/login", async (req, res) => {
  const email = (req.body.email || "").toLowerCase().trim();
  const password = (req.body.password || "").trim();
  if (!email || !password) return res.status(400).json({ success: false, message: "Email and password required" });
  try {
    const { data: authData, error: authError } = await supabase.auth.signInWithPassword({ email, password });
    if (authError || !authData.user) return res.status(401).json({ success: false, message: "Invalid credentials." });
    const { data: profile } = await supabase.from("profiles").select("*").eq("id", authData.user.id).maybeSingle();
    const { data: wallet } = await supabase.from("wallets").select("*").eq("user_id", authData.user.id).maybeSingle();
    res.json({ success: true, message: "Login successful", user: profile, wallet: wallet || { balance: 0 }, session: authData.session });
  } catch (err) {
    res.status(500).json({ success: false, message: "Login service error" });
  }
});

// WALLET API
app.get("/wallet/balance/:userId", async (req, res) => {
  try {
    const { data: wallet } = await supabase.from("wallets").select("*").eq("user_id", req.params.userId).maybeSingle();
    res.json({ success: true, balance: wallet ? wallet.balance : 0 });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// -------------------------------------------------------------
// VTU ROUTES WITH MULTI-FALLBACK USER ID EXTRACTION
// -------------------------------------------------------------

// AIRTIME
app.post("/api/v2/vtu/airtime/purchase", async (req, res) => {
  const { network, phone_number, amount } = req.body;
  const targetUserId = req.body.userId || req.body.user_id || req.headers["x-user-id"] || req.query.userId;
  
  try {
    const result = await bigisub.purchaseAirtime({ network, phone_number, amount, pin: DEFAULT_PIN });
    
    await saveTransactionToSupabase({
      userId: targetUserId,
      title: `Airtime Top-up (${network?.toUpperCase() || "Network"})`,
      serviceType: "airtime",
      amount,
      recipient: phone_number,
      status: "successful",
      reference: result?.reference || result?.trans_id || `DH_${Date.now()}`
    });

    res.json({ success: true, status: "successful", data: result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.response?.data?.message || err.message });
  }
});

// DATA BUNDLES
app.get("/api/v2/vtu/data/plans", async (req, res) => {
  try {
    const rawNetwork = req.query.network || "mtn";
    const networkMap = { "1": "mtn", "2": "airtel", "3": "glo", "4": "9mobile" };
    const network = networkMap[rawNetwork] || rawNetwork.toString().toLowerCase().trim();

    const plans = await bigisub.getDataPlans(network);

    // Normalize response into a flat array regardless of Bigisub key wrapping
    const planArray = Array.isArray(plans) 
      ? plans 
      : (plans?.plans || plans?.data || plans?.plans_List || []);

    console.log("📦 Returned " + planArray.length + " plans for network: " + network);
    return res.json(planArray);
  } catch (err) {
    console.error("❌ Data Plans Fetch Error:", err.response?.data || err.message);
    return res.status(500).json({ success: false, message: "Failed to fetch plans", plans: [] });
  }
});

app.post("/api/v2/vtu/data/purchase", async (req, res) => {
  const { network, plan, phone_number, amount } = req.body;
  const targetUserId = req.body.userId || req.body.user_id || req.headers["x-user-id"] || req.query.userId;

  try {
    const result = await bigisub.purchaseData({ network, plan, phone_number, pin: DEFAULT_PIN });

    await saveTransactionToSupabase({
      userId: targetUserId,
      title: `Data Purchase (${network?.toUpperCase() || "Data"})`,
      serviceType: "data",
      amount: amount || result?.amount || 0,
      recipient: phone_number,
      status: "successful",
      reference: result?.reference || result?.trans_id || `DH_${Date.now()}`
    });

    res.json({ success: true, status: "successful", data: result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.response?.data?.message || err.message });
  }
});

// CABLE TV
app.get("/api/v2/vtu/cable/plans", async (req, res) => {
  try {
    const plans = await bigisub.getCablePlans(req.query.cable_name || "dstv");
    res.json(plans);
  } catch (err) {
    res.status(500).json({ success: false, message: err.response?.data?.message || err.message });
  }
});

app.post("/api/v2/vtu/cable/verify", async (req, res) => {
  try {
    const result = await bigisub.verifyCable(req.body);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, message: err.response?.data?.message || err.message });
  }
});

app.post("/api/v2/vtu/cable/purchase", async (req, res) => {
  const { cable_type, card_no, phone_number, amount, Customer } = req.body;
  const targetUserId = req.body.userId || req.body.user_id || req.headers["x-user-id"] || req.query.userId;

  try {
    const result = await bigisub.purchaseCable({ cable_type, card_no, phone_number, amount, Customer, pin: DEFAULT_PIN });

    await saveTransactionToSupabase({
      userId: targetUserId,
      title: `Cable TV (${cable_type?.toUpperCase()})`,
      serviceType: "cable",
      amount,
      recipient: card_no,
      status: "successful",
      reference: result?.reference || result?.trans_id || `DH_${Date.now()}`
    });

    res.json({ success: true, status: "successful", data: result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.response?.data?.message || err.message });
  }
});

// ELECTRICITY BILLS
app.get("/api/v2/bills/electricity/providers", async (_req, res) => {
  try {
    const providers = await bigisub.getElectricityProviders();
    res.json(providers);
  } catch (err) {
    res.status(500).json({ success: false, message: err.response?.data?.message || err.message });
  }
});

app.post("/api/v2/bills/electricity/verify", async (req, res) => {
  try {
    const result = await bigisub.verifyMeter(req.body);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, message: err.response?.data?.message || err.message });
  }
});

app.post("/api/v2/bills/electricity/pay", async (req, res) => {
  const { company, meter_no, meter_type, phone_number, amount, Customer_name } = req.body;
  const targetUserId = req.body.userId || req.body.user_id || req.headers["x-user-id"] || req.query.userId;

  try {
    const result = await bigisub.payElectricity({ company, meter_no, meter_type, phone_number, amount, Customer_name, pin: DEFAULT_PIN });

    await saveTransactionToSupabase({
      userId: targetUserId,
      title: `Electricity (${company})`,
      serviceType: "electricity",
      amount,
      recipient: meter_no,
      status: "successful",
      reference: result?.reference || result?.trans_id || `DH_${Date.now()}`
    });

    res.json({ success: true, status: "successful", data: result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.response?.data?.message || err.message });
  }
});

// FETCH TRANSACTIONS BY USER ID
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
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Dreamhatcher Production Server active on port ${PORT}`));
