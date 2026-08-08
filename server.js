if (process.env.NODE_ENV !== "production") {
  require("dotenv").config();
}

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const SibApiV3Sdk = require('sib-api-v3-sdk');
const { createClient } = require("@supabase/supabase-js");

// 1. INITIALIZATION
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const defaultClient = SibApiV3Sdk.ApiClient.instance;
defaultClient.authentications['api-key'].apiKey = process.env.BREVO_API_KEY;
const transacEmailApi = new SibApiV3Sdk.TransactionalEmailsApi();

const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json());

// 2. SEND OTP
app.post("/auth/send-otp", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ success: false, message: "Email required" });

  const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
  const cleanEmail = email.toLowerCase().trim();

  try {
    const { error: dbErr } = await supabase.from("temp_otps").upsert({ email: cleanEmail, otp: otpCode });
    if (dbErr) throw dbErr;

    const sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();
    sendSmtpEmail.subject = "Verification Code";
    sendSmtpEmail.sender = { name: process.env.SENDER_NAME, email: process.env.SENDER_EMAIL };
    sendSmtpEmail.to = [{ email: cleanEmail }];
    sendSmtpEmail.htmlContent = `<html><body><h1>Code: ${otpCode}</h1></body></html>`;

    await transacEmailApi.sendTransacEmail(sendSmtpEmail);
    res.json({ success: true, message: "OTP sent" });
  } catch (err) {
    console.error("❌ OTP Error:", err.message);
    res.status(500).json({ success: false, message: "Service busy. Try again." });
  }
});

// 3. VERIFY OTP & REGISTER USER
app.post("/auth/verify-otp", async (req, res) => {
  const email = (req.body.email || "").toLowerCase().trim();
  const otp = (req.body.otp || "").trim();
  const password = req.body.password || "Dreamhatcher@2026#Secure";
  const fullName = req.body.full_name || req.body.fullName || "User";
  const phoneNumber = req.body.phone_number || req.body.phoneNumber || "";

  if (!email || !otp) {
    return res.status(400).json({ success: false, message: "Email and OTP are required" });
  }

  try {
    // A. Verify code in DB
    const { data: otpData } = await supabase.from("temp_otps").select("*").eq("email", email).eq("otp", otp).single();
    if (!otpData) {
      return res.status(400).json({ success: false, message: "Invalid or expired verification code." });
    }

    // B. Create or Fetch Auth User
    let userId;
    const { data: userList } = await supabase.auth.admin.listUsers();
    const existing = userList?.users?.find(u => u.email === email);

    if (existing) {
      userId = existing.id;
      // Update password if specified
      if (req.body.password) {
        await supabase.auth.admin.updateUserById(userId, { password: req.body.password });
      }
    } else {
      const { data: authUser, error: authError } = await supabase.auth.admin.createUser({
        email, 
        password, 
        email_confirm: true, 
        user_metadata: { full_name: fullName }
      });
      if (authError) throw authError;
      userId = authUser.user.id;
    }

    // C. Upsert Profile
    const { error: profileError } = await supabase.from("profiles").upsert({
      id: userId,
      full_name: fullName,
      phone_number: phoneNumber,
      email: email,
      email_verified: true
    }, { onConflict: "id" });

    if (profileError) {
      console.error("Profile Error:", JSON.stringify(profileError));
      throw new Error("Failed to create profile row.");
    }

    // D. Create Wallet & Cleanup
    await supabase.from("wallets").upsert({ user_id: userId, balance: 0 }, { onConflict: "user_id" });
    await supabase.from("temp_otps").delete().eq("email", email);

    console.log(`✅ Registration Verified for ${email} (User ID: ${userId})`);
    res.json({ success: true, message: "Verification successful", userId });

  } catch (err) {
    console.error("❌ VERIFY_ERROR:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// 4. STRICT LOGIN ROUTE (Verifies Email + Password against Supabase Auth)
app.post("/auth/login", async (req, res) => {
  const email = (req.body.email || "").toLowerCase().trim();
  const password = req.body.password;

  if (!email || !password) {
    return res.status(400).json({ success: false, message: "Email and password required" });
  }

  try {
    // 1. Verify credentials with Supabase Auth GoTrue engine
    const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
      email: email,
      password: password,
    });

    if (authError || !authData.user) {
      console.warn(`⚠️ Login rejected for ${email}: Incorrect password or invalid user.`);
      return res.status(401).json({ 
        success: false, 
        message: "Invalid email or password." 
      });
    }

    // 2. Fetch User Profile
    const { data: profile } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", authData.user.id)
      .maybeSingle();

    console.log(`✅ Valid Login for ${email}`);
    res.json({ 
      success: true, 
      message: "Login successful", 
      user: profile || { id: authData.user.id, email },
      session: authData.session 
    });

  } catch (err) {
    console.error("❌ LOGIN_ERROR:", err.message);
    res.status(500).json({ success: false, message: "Login service error" });
  }
});

// 5. STUBS & SERVER START
app.post("/orders", (req, res) => res.json({ success: true, message: "Order processed" }));
app.get("/health", (req, res) => res.json({ status: "OK" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Dreamhatcher Backend active on port ${PORT}`));
