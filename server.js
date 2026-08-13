// ✅ ALWAYS LOAD .env FIRST
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const axios = require("axios");
const https = require("https");
const { createClient } = require("@supabase/supabase-js");

// 1. INITIALIZATION & CLIENTS
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const BIGISUB_BASE_URL = "https://api.bigisub.ng";
const BIGISUB_TOKEN = process.env.BIGISUB_TOKEN || process.env.BIGISUB_API_KEY;
const DEFAULT_PIN = process.env.BIGISUB_PIN || "1234";

const bigiClient = axios.create({
  baseURL: BIGISUB_BASE_URL,
  headers: {
    "Authorization": `Token ${BIGISUB_TOKEN}`,
    "Content-Type": "application/json"
  }
});

const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json());

// Helper to normalize network identifiers for BigiSub (App: 1=MTN, 2=Glo, 3=Airtel, 4=9Mobile -> BigiSub API: 1=MTN, 2=Airtel, 3=Glo, 4=9Mobile)
function getNetworkId(net) {
  const map = { 
    "1": 1, "mtn": 1, 
    "2": 3, "glo": 3,       // App 2 (Glo) -> BigiSub API 3
    "3": 2, "airtel": 2,    // App 3 (Airtel) -> BigiSub API 2
    "4": 4, "9mobile": 4, "eti": 4 
  };
  return map[String(net || "").toLowerCase().trim()] || 1;
}

// Helper to normalize cable provider strings
function getCableCode(provider) {
  const clean = String(provider || "").toLowerCase().trim();
  if (clean.includes("gotv")) return "gotv";
  if (clean.includes("dstv")) return "dstv";
  if (clean.includes("star")) return "startimes";
  if (clean.includes("show")) return "showmax";
  return clean;
}

// -------------------------------------------------------------
// 2. AUTHENTICATION ROUTES (Native Brevo API)
// -------------------------------------------------------------
app.post("/auth/send-otp", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ success: false, message: "Email required" });

  const cleanEmail = email.toLowerCase().trim();
  const otpCode = Math.floor(100000 + Math.random() * 900000).toString();

  try {
    const { error: dbErr } = await supabase
      .from("temp_otps")
      .upsert({ email: cleanEmail, otp: otpCode, created_at: new Date() }, { onConflict: "email" });

    if (dbErr) console.warn("⚠️ temp_otps warning:", dbErr.message);

    await axios.post(
      "https://api.brevo.com/v3/smtp/email",
      {
        sender: { name: process.env.SENDER_NAME || "Dreamhatcher", email: process.env.SENDER_EMAIL },
        to: [{ email: cleanEmail }],
        subject: `${otpCode} is your Dreamhatcher Verification Code`,
        htmlContent: `<html><body><h2>Dreamhatcher Verification</h2><p>Your code is: <b style="font-size:24px;">${otpCode}</b></p></body></html>`
      },
      {
        headers: {
          "api-key": process.env.BREVO_API_KEY,
          "content-type": "application/json"
        }
      }
    );

    res.json({ success: true, message: "Verification code sent" });
  } catch (err) {
    console.error("❌ Send OTP Error:", err.response?.data || err.message);
    res.status(500).json({ success: false, message: "Failed to send OTP code" });
  }
});

app.post("/auth/verify-otp", async (req, res) => {
  const email = (req.body.email || "").toLowerCase().trim();
  const otp = (req.body.otp || "").trim();
  const password = req.body.password && req.body.password.trim().length >= 6 
    ? req.body.password.trim() 
    : "Dreamhatcher@2026#Secure";
  const fullName = req.body.full_name || req.body.fullName || "User";
  const phoneNumber = req.body.phone_number || req.body.phoneNumber || "";

  if (!email || !otp) return res.status(400).json({ success: false, message: "Email and OTP required" });

  try {
    const { data: otpData } = await supabase
      .from("temp_otps")
      .select("*")
      .eq("email", email)
      .eq("otp", otp)
      .maybeSingle();

    if (!otpData) {
      return res.status(400).json({ success: false, message: "Invalid or expired OTP." });
    }

    let userId;
    const { data: userList } = await supabase.auth.admin.listUsers();
    const existing = userList?.users?.find(u => u.email === email);

    if (existing) {
      userId = existing.id;
      await supabase.auth.admin.updateUserById(userId, { 
        password: password, 
        user_metadata: { full_name: fullName } 
      });
    } else {
      const { data: authUser, error: authError } = await supabase.auth.admin.createUser({
        email: email,
        password: password,
        email_confirm: true,
        user_metadata: { full_name: fullName }
      });
      if (authError) throw authError;
      userId = authUser.user.id;
    }

    const { data: profile } = await supabase.from("profiles").upsert({
      id: userId, full_name: fullName, phone_number: phoneNumber, email: email, email_verified: true
    }, { onConflict: "id" }).select().single();

    await supabase.from("wallets").upsert({ user_id: userId, wallets: 0 }, { onConflict: "user_id" });
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
    
    if (authError || !authData.user) {
      return res.status(401).json({ success: false, message: "Invalid credentials." });
    }

    const { data: profile } = await supabase.from("profiles").select("*").eq("id", authData.user.id).maybeSingle();
    const { data: wallet } = await supabase.from("wallets").select("*").eq("user_id", authData.user.id).maybeSingle();

    res.json({ 
      success: true, 
      message: "Login successful", 
      userId: authData.user.id,
      user: profile || { email: email, id: authData.user.id }, 
      wallet: wallet || { wallets: 0 }, 
      session: authData.session 
    });
  } catch (err) {
    console.error("❌ LOGIN_ERROR:", err.message);
    res.status(500).json({ success: false, message: "Login service error" });
  }
});

// -------------------------------------------------------------
// 3. BIGISUB VTU & UTILITIES ENGINE
// -------------------------------------------------------------

// AIRTIME
app.post("/api/v2/vtu/airtime/purchase", async (req, res) => {
  try {
    const { network, phone_number, amount } = req.body;
    const response = await bigiClient.post("/api/v2/vtu/airtime/purchase/", {
      network: getNetworkId(network),
      phone_number: String(phone_number).trim(),
      amount: String(amount),
      airtime_type: "vtu",
      pin: DEFAULT_PIN
    });
    res.json(response.data);
  } catch (err) {
    console.error("❌ Airtime Error:", err.response?.data || err.message);
    res.status(400).json({ success: false, message: err.response?.data?.message || err.message });
  }
});

// SQUAD DEDICATED VIRTUAL ACCOUNT CREATION
app.post("/api/v2/wallet/virtual-account", async (req, res) => {
  try {
    const { userId, email, firstName, lastName, phone, bvn, dob, gender, address } = req.body;
    if (!userId || !email) return res.status(400).json({ success: false, message: "User ID and Email are required" });

    const { data: user } = await supabase.from("users").select("virtual_account_number, virtual_bank_name, virtual_account_name").eq("id", userId).single();
    if (user?.virtual_account_number) {
      return res.json({
        success: true,
        account_number: user.virtual_account_number,
        bank_name: user.virtual_bank_name || "GTBANK / SQUAD",
        account_name: user.virtual_account_name
      });
    }

    const squadSecret = process.env.SQUADCO_SECRET_KEY || process.env.SQUAD_SECRET_KEY;
    let squadBaseUrl = process.env.SQUAD_BASE_URL || "";
    if (!squadBaseUrl || squadBaseUrl.includes("dva")) {
      squadBaseUrl = "https://sandbox-api-d.squadco.com";
    }
    squadBaseUrl = squadBaseUrl.trim().replace(/\/+$/, "");

    const payload = {
      customer_identifier: String(userId),
      first_name: (firstName || "Dreamhatcher").trim(),
      last_name: (lastName || "User").trim(),
      mobile_num: phone ? String(phone).replace(/[^0-9]/g, "") : "08012345678",
      email: String(email).toLowerCase().trim(),
      bvn: bvn || "22222222222",
      dob: dob || "01/01/1990",
      gender: gender || "1",
      address: address || "Lagos",
      beneficiary_account: process.env.SQUAD_BENEFICIARY_ACCOUNT || "0123456789"
    };

    const squadRes = await axios.post(`${squadBaseUrl}/virtual-account`, payload, {
      headers: { Authorization: `Bearer ${squadSecret}`, "Content-Type": "application/json" }
    });

    if (squadRes.data?.status === 200 || squadRes.data?.success) {
      const accData = squadRes.data.data;
      const accNo = accData.virtual_account_number;
      const bankName = accData.bank_name || "GTBANK / SQUAD";
      const accName = accData.account_name || `DREAMHATCHER-${payload.first_name}`;

      await supabase.from("users").update({
        virtual_account_number: accNo,
        virtual_bank_name: bankName,
        virtual_account_name: accName,
        squad_customer_id: String(userId)
      }).eq("id", userId);

      return res.json({ success: true, account_number: accNo, bank_name: bankName, account_name: accName });
    } else {
      throw new Error(squadRes.data?.message || "Failed to create virtual account with Squad");
    }
  } catch (err) {
    console.error("❌ Squad Account Creation Error:", err.response?.data || err.message);
    res.status(500).json({ success: false, message: err.response?.data?.message || err.message });
  }
});
// SQUAD AUTOMATED FUNDING WEBHOOK
// SQUAD AUTOMATED FUNDING WEBHOOK
app.post("/api/v2/webhooks/squad", async (req, res) => {
  try {
    const payload = req.body;
    const bodyData = payload?.Body || payload?.data || payload;
    const txRef = payload?.TransactionRef || bodyData?.transaction_ref;
    const status = bodyData?.transaction_status || payload?.status;
    const email = bodyData?.email || payload?.email;
    const rawAmount = Number(bodyData?.amount || payload?.amount || 0);

    const amount = rawAmount > 100000 ? rawAmount / 100 : rawAmount;

    if (status !== "Success" && status !== "success" && payload?.Event !== "charge_successful") {
      return res.status(200).json({ success: true, message: "Ignored non-successful transaction" });
    }

    if (!email || !txRef || amount <= 0) {
      return res.status(200).json({ success: true, message: "Invalid payload parameters" });
    }

    // 1. Idempotency Check
    const { data: existingTx } = await supabase.from("transactions").select("id").eq("reference", txRef).single();
    if (existingTx) {
      return res.status(200).json({ success: true, message: "Transaction already processed" });
    }

    // 2. Resolve User ID by Email
    const cleanEmail = email.trim();
    let targetUserId = null;

    const { data: users } = await supabase.from("users").select("id").ilike("email", cleanEmail);
    if (users && users.length > 0) {
      targetUserId = users[0].id;
    } else {
      // Fallback: Check profiles table if users is empty
      const { data: profiles } = await supabase.from("profiles").select("id").ilike("email", cleanEmail);
      if (profiles && profiles.length > 0) targetUserId = profiles[0].id;
    }

    if (!targetUserId) {
      console.error("❌ Webhook Error: No user ID found for email:", cleanEmail);
      return res.status(200).json({ success: true, message: "User not found" });
    }

    // 3. Get or Initialize Wallet Row
    const { data: walletRow } = await supabase.from("wallets").select("id, balance").eq("user_id", targetUserId).single();
    const currentBalance = Number(walletRow?.balance || 0);
    const newBalance = currentBalance + amount;

    if (walletRow) {
      await supabase.from("wallets").update({ balance: newBalance }).eq("id", walletRow.id);
    } else {
      await supabase.from("wallets").insert({ user_id: targetUserId, balance: newBalance });
    }

    // 4. Log Transaction
    await supabase.from("transactions").insert({
      user_id: targetUserId,
      type: "deposit",
      amount: amount,
      balance_before: currentBalance,
      balance_after: newBalance,
      reference: txRef,
      status: "success",
      description: "Automated Virtual Account Topup via Squad"
    });

    console.log(`✅ Wallet funded: ${cleanEmail} +₦${amount} (New Balance: ₦${newBalance})`);
    return res.status(200).json({ success: true, message: "Wallet funded successfully" });
  } catch (err) {
    console.error("❌ Squad Webhook Exception:", err.message);
    return res.status(200).json({ success: true, message: "Error handled" });
  }
});
// DATA PLANS & PURCHASE
app.get("/api/v2/vtu/data/plans", async (req, res) => {
  try {
    const appNetId = Number(req.query.network) || 1;
    const { data: plans, error } = await supabase
      .from("data_plans")
      .select("*")
      .eq("network_id", appNetId)
      .eq("is_active", true)
      .order("buy_price", { ascending: true });

    if (error) throw error;

    const formattedPlans = plans.map(p => ({
      id: Number(p.bigi_plan_id),
      plan_id: Number(p.bigi_plan_id),
      network: p.network_id,
      plantype: p.plan_type,
      size: p.volume,
      validity: p.validity,
      amount: p.retail_price,
      plan_amount: p.retail_price,
      buy_price: p.buy_price
    }));

    res.json({ success: true, data: formattedPlans });
  } catch (err) {
    console.error("❌ Data plans fetch error:", err.message);
    res.status(500).json({ success: false, message: err.message, data: [] });
  }
});

app.post("/api/v2/vtu/data/purchase", async (req, res) => {
  try {
    const { network, plan, plan_id, phone_number, pin } = req.body;

    // 1. Resolve plan identifier whether frontend sends 'plan' or 'plan_id'
    const targetPlan = plan || plan_id;
    const numericPlanId = Number(targetPlan);

    if (!targetPlan || isNaN(numericPlanId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid or missing plan ID"
      });
    }

    // 2. Format payload for BigiSub API
    const payload = {
      customer_identifier: String(userId),
      first_name: (firstName || "Dreamhatcher").trim(),
      last_name: (lastName || "User").trim(),
      mobile_num: phone ? String(phone).replace(/[^0-9]/g, "") : "08012345678",
      email: String(email).toLowerCase().trim(),
      bvn: bvn || "22222222222",
      dob: dob || "01/01/1990",
      gender: gender || "1",
      address: address || "Lagos",
      beneficiary_account: process.env.SQUAD_BENEFICIARY_ACCOUNT || "0123456789"
    };

    // 3. Dispatch purchase request
    const response = await bigiClient.post("/api/v2/vtu/data/purchase/", payload);
    return res.json({
      success: true,
      message: "Data purchase successful",
      data: response.data
    });

  } catch (err) {
    // Detailed error logging to inspect BigiSub validation details in Render logs
    const bigiError = err.response?.data;
    console.error("❌ BigiSub API Error:", JSON.stringify(bigiError || err.message, null, 2));

    return res.status(err.response?.status || 400).json({
      success: false,
      message: bigiError?.message || bigiError?.detail || err.message,
      errors: bigiError?.errors || null
    });
  }
});

// CABLE TV
app.get("/api/v2/vtu/cable/plans", async (req, res) => {
  try {
    const cableName = getCableCode(req.query.cable_name || req.query.provider || "gotv");
    const response = await bigiClient.get(`/api/v2/vtu/cable/plans/?cable_name=${cableName}`);
    const plans = response.data?.data || (Array.isArray(response.data) ? response.data : []);
    res.json({ success: true, data: plans });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message, data: [] });
  }
});

app.post("/api/v2/vtu/cable/verify", async (req, res) => {
  try {
    const provider = getCableCode(req.body.cable_name || req.body.provider || "gotv");
    const cardNo = String(req.body.card_no || req.body.smartCardNo || "").trim().replace(/\s+/g, "");

    if (!cardNo || cardNo.length < 8) {
      return res.status(400).json({ success: false, message: "Smartcard / IUC number must be at least 8 characters" });
    }

    const response = await bigiClient.post("/api/v2/vtu/cable/verify/", {
      cable_name: provider,
      card_no: cardNo
    });

    const verifyData = response.data?.data || {};
    res.json({
      success: true,
      message: "Verification successful",
      data: {
        customerName: verifyData.customer_name || "VERIFIED CUSTOMER",
        currentBouquet: verifyData.current_bouquet || "",
        cardNumber: verifyData.card_number || cardNo,
        cableProvider: verifyData.cable_provider || provider
      }
    });
  } catch (err) {
    res.status(400).json({ 
      success: false, 
      message: err.response?.data?.message || err.response?.data?.detail || "Customer account not found" 
    });
  }
});

app.post("/api/v2/vtu/cable/purchase", async (req, res) => {
  try {
    const { cable_type, provider, card_no, phone_number, amount, Customer, customerName } = req.body;
    const response = await bigiClient.post("/api/v2/vtu/cable/purchase/", {
      cable_type: getCableCode(cable_type || provider),
      card_no: String(card_no).trim(),
      phone_number: String(phone_number).trim(),
      amount: Number(amount),
      Customer: String(Customer || customerName).trim(),
      pin: DEFAULT_PIN
    });
    res.json(response.data);
  } catch (err) {
    res.status(400).json({ success: false, message: err.response?.data?.message || err.message });
  }
});

// RECHARGE PINS
app.get("/api/v2/vtu/recharge-pin/plans", async (req, res) => {
  try {
    const netId = getNetworkId(req.query.network);
    const response = await bigiClient.get(`/api/v2/vtu/recharge-pin/plans/?network=${netId}`);
    const plans = response.data?.data || (Array.isArray(response.data) ? response.data : []);
    res.json({ success: true, data: plans });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message, data: [] });
  }
});

// ELECTRICITY
app.get("/api/v2/bills/electricity/providers", async (_req, res) => {
  try {
    const response = await bigiClient.get("/api/v2/bills/electricity/providers/");
    const providers = response.data?.data?.providers || response.data?.data || [];
    res.json({ success: true, data: providers });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message, data: [] });
  }
});

app.post("/api/v2/bills/electricity/verify", async (req, res) => {
  try {
    const { company, meter_no, meter_type } = req.body;
    const response = await bigiClient.post("/api/v2/bills/electricity/verify/", {
      company: String(company).trim(),
      meter_no: String(meter_no).trim(),
      meter_type: String(meter_type || "prepaid").trim()
    });
    const verifyData = response.data?.data || {};
    res.json({
      success: true,
      message: "Meter verified",
      data: {
        customerName: verifyData.customer_name || "VERIFIED CUSTOMER",
        customerAddress: verifyData.customer_address || "",
        meterNumber: verifyData.meter_number || meter_no
      }
    });
  } catch (err) {
    res.status(400).json({ success: false, message: err.response?.data?.message || "Electricity meter verification failed" });
  }
});

// EDUCATION
app.get("/api/v2/bills/result-checker/prices", async (_req, res) => {
  try {
    const response = await bigiClient.get("/api/v2/bills/result-checker/prices/");
    const prices = response.data?.data?.prices || response.data?.data || [];
    res.json({ success: true, data: prices });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message, data: [] });
  }
});

// -------------------------------------------------------------
// 4. DUAL KEEP-WARM HEALTH ENDPOINT (RENDER & SUPABASE)
// -------------------------------------------------------------
app.get("/health", async (_req, res) => {
  try {
    const { error } = await supabase.from("temp_otps").select("email").limit(1);
    if (error) throw error;
    res.json({ status: "OK", db: "connected", timestamp: new Date() });
  } catch (err) {
    res.status(200).json({ status: "OK", db: "degraded", error: err.message, timestamp: new Date() });
  }
});

// Dynamic keep-warm self-ping for Render deployment
const SELF_URL = process.env.RENDER_EXTERNAL_URL || process.env.APP_URL;

if (SELF_URL) {
  const pingUrl = `${SELF_URL}/health`;
  setInterval(() => {
    https.get(pingUrl, (response) => {
      response.resume();
    }).on("error", (err) => {
      console.warn("⚠️ Keep-warm ping warning:", err.message);
    });
  }, 10 * 60 * 1000);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Dreamhatcher Production Server active on port ${PORT}`));
