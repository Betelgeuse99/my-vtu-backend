if (process.env.NODE_ENV !== "production") {
  require("dotenv").config();
}

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");
const bigisub = require("./services/bigisub");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json());

const BREVO_API_KEY = process.env.BREVO_API_KEY;
const SENDER_NAME = process.env.SENDER_NAME || "Dreamhatcher";
const SENDER_EMAIL = process.env.SENDER_EMAIL || "support@dreamhatcher.com";

// NATIVE BREVO EMAIL SENDER (NO SDK FLAKINESS)
async function sendEmailViaBrevo({ toEmail, subject, htmlContent }) {
  if (!BREVO_API_KEY) {
    console.error("❌ BREVO_API_KEY is missing from environment variables!");
    throw new Error("Email service unconfigured");
  }

  const payload = {
    sender: { name: SENDER_NAME, email: SENDER_EMAIL },
    to: [{ email: toEmail }],
    subject: subject,
    htmlContent: htmlContent
  };

  try {
    const res = await axios.post("https://api.brevo.com/v3/smtp/email", payload, {
      headers: {
        "api-key": BREVO_API_KEY,
        "content-type": "application/json",
        "accept": "application/json"
      }
    });
    console.log("✅ Brevo Email Sent Successfully. MessageId:", res.data.messageId);
    return res.data;
  } catch (err) {
    console.error("❌ Brevo API Failure:", err.response?.data || err.message);
    throw new Error(err.response?.data?.message || "Email delivery failed");
  }
}

// MANDATORY TRANSACTION LOGGER
async function saveTransactionToSupabase({ userId, title, serviceType, amount, recipient, status, reference }) {
  if (!userId) {
    console.warn("⚠️ Transaction DB save skipped: missing userId.");
    return;
  }
  try {
    await supabase.from("transactions").insert([{
      user_id: userId,
      title: title || "VTU Purchase",
      service_type: serviceType || "data",
      amount: Number(amount) || 0,
      recipient: String(recipient || ""),
      status: status || "successful",
      reference: reference || `DH_${Date.now()}`,
      created_at: new Date().toISOString()
    }]);
    console.log(`✅ Transaction logged in Supabase for user: ${userId}`);
  } catch (err) {
    console.error("❌ Supabase DB Save Error:", err.message);
  }
}

// -------------------------------------------------------------
// 1. AUTHENTICATION & OTP ROUTES
// -------------------------------------------------------------

// SEND OTP
app.post("/auth/send-otp", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ success: false, message: "Email is required" });

  const cleanEmail = email.toLowerCase().trim();
  const otpCode = Math.floor(100000 + Math.random() * 900000).toString();

  try {
    // 1. Save to temp_otps in Supabase
    const { error: dbErr } = await supabase
      .from("temp_otps")
      .upsert({ email: cleanEmail, otp: otpCode, created_at: new Date() }, { onConflict: "email" });

    if (dbErr) console.warn("⚠️ Warning temp_otps upsert issue:", dbErr.message);

    // 2. Dispatch Email via Direct Brevo API
    await sendEmailViaBrevo({
      toEmail: cleanEmail,
      subject: `${otpCode} is your Dreamhatcher Verification Code`,
      htmlContent: `<html><body><h2>Dreamhatcher Verification</h2><p>Your verification code is: <b style="font-size:24px;">${otpCode}</b></p><p>This code expires shortly.</p></body></html>`
    });

    res.json({ success: true, message: "Verification code sent to your email." });
  } catch (err) {
    console.error("❌ SEND_OTP_ERROR:", err.message);
    res.status(500).json({ success: false, message: err.message || "Failed to send OTP code." });
  }
});

// VERIFY OTP & REGISTER / UPDATE USER
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
    // Check OTP in DB
    const { data: otpData } = await supabase
      .from("temp_otps")
      .select("*")
      .eq("email", email)
      .eq("otp", otp)
      .maybeSingle();

    if (!otpData) {
      return res.status(400).json({ success: false, message: "Invalid or expired OTP code." });
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

    // Upsert Profile & Wallet
    const { data: profile } = await supabase.from("profiles").upsert({
      id: userId, full_name: fullName, phone_number: phoneNumber, email: email, email_verified: true
    }, { onConflict: "id" }).select().single();

    await supabase.from("wallets").upsert({ user_id: userId, balance: 0 }, { onConflict: "user_id" });
    await supabase.from("temp_otps").delete().eq("email", email);

    res.json({ success: true, message: "Verification successful", userId: userId, user: profile });
  } catch (err) {
    console.error("❌ VERIFY_ERROR:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// LOGIN
app.post("/auth/login", async (req, res) => {
  const email = (req.body.email || "").toLowerCase().trim();
  const password = (req.body.password || "").trim();

  if (!email || !password) return res.status(400).json({ success: false, message: "Email and password required" });

  try {
    const { data: authData, error: authError } = await supabase.auth.signInWithPassword({ email, password });
    
    if (authError || !authData.user) {
      return res.status(401).json({ success: false, message: "Invalid email or account credentials." });
    }

    const { data: profile } = await supabase.from("profiles").select("*").eq("id", authData.user.id).maybeSingle();
    const { data: wallet } = await supabase.from("wallets").select("*").eq("user_id", authData.user.id).maybeSingle();

    res.json({ 
      success: true, 
      message: "Login successful", 
      userId: authData.user.id,
      user: profile || { email: email, id: authData.user.id }, 
      wallet: wallet || { balance: 0 }, 
      session: authData.session 
    });
  } catch (err) {
    console.error("❌ LOGIN_ERROR:", err.message);
    res.status(500).json({ success: false, message: "Login service error" });
  }
});

// -------------------------------------------------------------
// 2. VTU DATA & SERVICE ROUTES
// -------------------------------------------------------------

app.get("/api/v2/vtu/data/plans", async (req, res) => {
  try {
    const networkQuery = req.query.network || "1";
    const plans = await bigisub.getDataPlans(networkQuery);
    res.json({ success: true, data: plans });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message, data: [] });
  }
});

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
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Master Server active on port ${PORT}`));
