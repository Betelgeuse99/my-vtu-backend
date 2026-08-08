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

// 2. SEND OTP (For Sign Up & Forgot Password)
app.post("/auth/send-otp", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ success: false, message: "Email required" });

  const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
  const cleanEmail = email.toLowerCase().trim();

  try {
    const { error: dbErr } = await supabase.from("temp_otps").upsert({ email: cleanEmail, otp: otpCode });
    if (dbErr) throw dbErr;

    const sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();
    sendSmtpEmail.subject = `${otpCode} is your Dreamhatcher Code`;
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

// 3. VERIFY OTP & SIGN UP / UPDATE PASSWORD
app.post("/auth/verify-otp", async (req, res) => {
  const email = (req.body.email || "").toLowerCase().trim();
  const otp = (req.body.otp || "").trim();
  const rawPassword = req.body.password;
  const password = rawPassword && rawPassword.trim().length >= 6 ? rawPassword.trim() : "Dreamhatcher@2026#Secure";
  const fullName = req.body.full_name || req.body.fullName || "User";
  const phoneNumber = req.body.phone_number || req.body.phoneNumber || "";

  if (!email || !otp) {
    return res.status(400).json({ success: false, message: "Email and OTP required" });
  }

  try {
    // A. Verify OTP
    const { data: otpData } = await supabase.from("temp_otps").select("*").eq("email", email).eq("otp", otp).single();
    if (!otpData) {
      return res.status(400).json({ success: false, message: "Invalid or expired verification code." });
    }

    // B. Check Auth User
    let userId;
    const { data: userList } = await supabase.auth.admin.listUsers();
    const existing = userList?.users?.find(u => u.email === email);

    if (existing) {
      userId = existing.id;
      // Force update password in auth.users
      const { error: updateErr } = await supabase.auth.admin.updateUserById(userId, {
        password: password,
        user_metadata: { full_name: fullName }
      });
      if (updateErr) console.error("❌ Password Update Error:", updateErr.message);
      else console.log(`🔑 Password updated successfully for existing user ${email}`);
    } else {
      const { data: authUser, error: authError } = await supabase.auth.admin.createUser({
        email, 
        password, 
        email_confirm: true, 
        user_metadata: { full_name: fullName }
      });
      if (authError) throw authError;
      userId = authUser.user.id;
      console.log(`🔑 New Auth User created for ${email} with password length ${password.length}`);
    }

    // C. Upsert Profile
    await supabase.from("profiles").upsert({
      id: userId,
      full_name: fullName,
      phone_number: phoneNumber,
      email: email,
      email_verified: true
    }, { onConflict: "id" });

    // D. Wallet & Cleanup
    await supabase.from("wallets").upsert({ user_id: userId, balance: 0 }, { onConflict: "user_id" });
    await supabase.from("temp_otps").delete().eq("email", email);

    res.json({ success: true, message: "Verification successful", userId });

  } catch (err) {
    console.error("❌ VERIFY_ERROR:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// 4. RESET PASSWORD ROUTE (For Forgot Password Screen)
app.post("/auth/reset-password", async (req, res) => {
  const email = (req.body.email || "").toLowerCase().trim();
  const otp = (req.body.otp || "").trim();
  const newPassword = (req.body.password || req.body.newPassword || "").trim();

  if (!email || !otp || !newPassword) {
    return res.status(400).json({ success: false, message: "Email, OTP, and new password are required." });
  }

  try {
    // 1. Verify OTP
    const { data: otpData } = await supabase.from("temp_otps").select("*").eq("email", email).eq("otp", otp).single();
    if (!otpData) {
      return res.status(400).json({ success: false, message: "Invalid or expired OTP code." });
    }

    // 2. Lookup Auth User
    const { data: userList } = await supabase.auth.admin.listUsers();
    const existing = userList?.users?.find(u => u.email === email);

    if (!existing) {
      return res.status(404).json({ success: false, message: "No account found with this email." });
    }

    // 3. Directly update password in Supabase Auth GoTrue engine
    const { error: updateErr } = await supabase.auth.admin.updateUserById(existing.id, {
      password: newPassword
    });

    if (updateErr) {
      throw updateErr;
    }

    // 4. Delete temp OTP
    await supabase.from("temp_otps").delete().eq("email", email);

    console.log(`✅ Password successfully reset for ${email}`);
    return res.json({ success: true, message: "Password reset successful! You can now log in." });

  } catch (err) {
    console.error("❌ RESET_PASSWORD_ERROR:", err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// 5. STRICT LOGIN ROUTE
app.post("/auth/login", async (req, res) => {
  const email = (req.body.email || "").toLowerCase().trim();
  const password = (req.body.password || "").trim();

  if (!email || !password) {
    return res.status(400).json({ success: false, message: "Email and password required" });
  }

  try {
    const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
      email: email,
      password: password,
    });

    if (authError || !authData.user) {
      console.warn(`⚠️ Login rejected for ${email}: ${authError?.message || "Incorrect password"}`);
      return res.status(401).json({ 
        success: false, 
        message: "Invalid email or password." 
      });
    }

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

// STUBS & SERVER START
app.post("/orders", (req, res) => res.json({ success: true, message: "Order processed" }));
app.get("/health", (req, res) => res.json({ status: "OK" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Dreamhatcher Backend active on port ${PORT}`));
