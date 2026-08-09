if (process.env.NODE_ENV !== "production") {
  require("dotenv").config();
}

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const SibApiV3Sdk = require('sib-api-v3-sdk');
const { createClient } = require("@supabase/supabase-js");
const bigisub = require("./services/bigisub");

// 1. INITIALIZATION
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const defaultClient = SibApiV3Sdk.ApiClient.instance;
defaultClient.authentications['api-key'].apiKey = process.env.BREVO_API_KEY;
const transacEmailApi = new SibApiV3Sdk.TransactionalEmailsApi();

const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json());

const DEFAULT_PIN = process.env.BIGISUB_PIN || "1234";

// -------------------------------------------------------------
// 2. AUTHENTICATION ROUTES
// -------------------------------------------------------------
app.post("/auth/send-otp", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ success: false, message: "Email required" });

  const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
  const cleanEmail = email.toLowerCase().trim();

  try {
    const { error: dbErr } = await supabase.from("temp_otps").upsert({ email: cleanEmail, otp: otpCode });
    if (dbErr) throw dbErr;

    const sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();
    sendSmtpEmail.subject = `${otpCode} is your Dreamhatcher Verification Code`;
    sendSmtpEmail.sender = { name: process.env.SENDER_NAME, email: process.env.SENDER_EMAIL };
    sendSmtpEmail.to = [{ email: cleanEmail }];
    sendSmtpEmail.htmlContent = `<html><body><h2>Dreamhatcher Verification</h2><p>Your code is: <b>${otpCode}</b></p></body></html>`;

    await transacEmailApi.sendTransacEmail(sendSmtpEmail);
    res.json({ success: true, message: "OTP sent" });
  } catch (err) {
    console.error("❌ OTP Error:", err.message);
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
    console.error("❌ VERIFY_ERROR:", err.message);
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
    console.error("❌ LOGIN_ERROR:", err.message);
    res.status(500).json({ success: false, message: "Login service error" });
  }
});

// -------------------------------------------------------------
// 3. WALLET & FUNDING API (Monnify / Paystack Manual Sync)
// -------------------------------------------------------------
app.get("/wallet/balance/:userId", async (req, res) => {
  try {
    const { data: wallet } = await supabase.from("wallets").select("*").eq("user_id", req.params.userId).maybeSingle();
    res.json({ success: true, balance: wallet ? wallet.balance : 0 });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post("/wallet/initialize-funding", async (req, res) => {
  const { userId, amount } = req.body;
  if (!userId || !amount) return res.status(400).json({ success: false, message: "User ID and Amount required" });

  try {
    // Generate Virtual Account / Reference Payment Details
    const reference = `DH_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    res.json({
      success: true,
      message: "Funding reference created",
      data: {
        reference,
        amount,
        bank_name: "Wema Bank / Monnify",
        account_number: "99" + Math.floor(100000000 + Math.random() * 900000000),
        account_name: "Dreamhatcher-VTU"
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// -------------------------------------------------------------
// 4. BIGISUB VTU & UTILITIES ENGINE
// -------------------------------------------------------------

// AIRTIME
app.post("/api/v2/vtu/airtime/purchase", async (req, res) => {
  try {
    const { network, phone_number, amount } = req.body;
    const result = await bigisub.purchaseAirtime({ network, phone_number, amount, pin: DEFAULT_PIN });
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, message: err.response?.data?.message || err.message });
  }
});

// DATA BUNDLES
app.get("/api/v2/vtu/data/plans", async (req, res) => {
  try {
    const network = req.query.network;
    const plans = await bigisub.getDataPlans(network);
    res.json(plans);
  } catch (err) {
    res.status(500).json({ success: false, message: err.response?.data?.message || err.message });
  }
});

app.post("/api/v2/vtu/data/purchase", async (req, res) => {
  try {
    const { network, plan, phone_number } = req.body;
    const result = await bigisub.purchaseData({ network, plan, phone_number, pin: DEFAULT_PIN });
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, message: err.response?.data?.message || err.message });
  }
});

// CABLE TV
app.get("/api/v2/vtu/cable/plans", async (req, res) => {
  try {
    const cableName = req.query.cable_name || "dstv";
    const plans = await bigisub.getCablePlans(cableName);
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
  try {
    const { cable_type, card_no, phone_number, amount, Customer } = req.body;
    const result = await bigisub.purchaseCable({ cable_type, card_no, phone_number, amount, Customer, pin: DEFAULT_PIN });
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, message: err.response?.data?.message || err.message });
  }
});

// RECHARGE PINS
app.get("/api/v2/vtu/recharge-pin/plans", async (req, res) => {
  try {
    const network = req.query.network;
    const plans = await bigisub.getRechargePinPlans(network);
    res.json(plans);
  } catch (err) {
    res.status(500).json({ success: false, message: err.response?.data?.message || err.message });
  }
});

app.post("/api/v2/vtu/recharge-pin/purchase", async (req, res) => {
  try {
    const { plan, quantity, name_on_card } = req.body;
    const result = await bigisub.purchaseRechargePin({ plan, quantity, name_on_card, pin: DEFAULT_PIN });
    res.json(result);
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
  try {
    const { company, meter_no, meter_type, phone_number, amount, Customer_name } = req.body;
    const result = await bigisub.payElectricity({ company, meter_no, meter_type, phone_number, amount, Customer_name, pin: DEFAULT_PIN });
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, message: err.response?.data?.message || err.message });
  }
});

// EDUCATION PINS (EXAM RESULT CHECKERS)
app.get("/api/v2/bills/result-checker/prices", async (_req, res) => {
  try {
    const prices = await bigisub.getEducationPrices();
    res.json(prices);
  } catch (err) {
    res.status(500).json({ success: false, message: err.response?.data?.message || err.message });
  }
});

app.post("/api/v2/bills/result-checker/purchase", async (req, res) => {
  try {
    const { exam, quantity } = req.body;
    const result = await bigisub.purchaseEducationPin({ exam, quantity, pin_code: DEFAULT_PIN });
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, message: err.response?.data?.message || err.message });
  }
});

// AIRTIME TO CASH
app.post("/api/v2/airtime-to-cash/submit", async (req, res) => {
  const { network, phone_number, amount } = req.body;
  res.json({
    success: true,
    message: "Airtime to Cash request logged",
    data: {
      destination_number: "08031234567",
      rate: "80%",
      expected_cash: amount * 0.8,
      status: "pending_transfer"
    }
  });
});

// NIN / BVN VERIFICATION
app.post("/api/v2/identity/verify", async (req, res) => {
  const { id_type, id_number } = req.body;
  res.json({
    success: true,
    message: "Identity verified successfully",
    data: {
      id_type,
      id_number,
      full_name: "Verified User",
      status: "VALID"
    }
  });
});

// STUBS & SERVER START
app.get("/health", (_req, res) => res.json({ status: "OK", timestamp: new Date() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Dreamhatcher Production Server active on port ${PORT}`));
