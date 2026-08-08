if (process.env.NODE_ENV !== "production") {
  require("dotenv").config();
}

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const crypto = require("crypto");
const axios = require("axios");
const SibApiV3Sdk = require('sib-api-v3-sdk');
const supabase = require("./config/supabase");

// -------------------------------------------------------------
// 1. BREVO SDK INITIALIZATION
// -------------------------------------------------------------
const defaultClient = SibApiV3Sdk.ApiClient.instance;
const apiKey = defaultClient.authentications['api-key'];
apiKey.apiKey = process.env.BREVO_API_KEY;

const transacEmailApi = new SibApiV3Sdk.TransactionalEmailsApi();

// -------------------------------------------------------------
// 2. ENVIRONMENT VALIDATION
// -------------------------------------------------------------
const REQUIRED_ENV_VARS = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "BIGISUB_API_KEY",
  "BREVO_API_KEY",
  "SENDER_EMAIL",
  "SENDER_NAME",
  "SERVER_BASE_URL",
];

const missingVars = REQUIRED_ENV_VARS.filter((key) => !process.env[key]);
if (missingVars.length > 0) {
  console.error(`❌ CRITICAL: Missing variables: ${missingVars.join(", ")}`);
  process.exit(1);
}

// -------------------------------------------------------------
// 3. EXPRESS APP & SECURITY
// -------------------------------------------------------------
const app = express();
app.set("trust proxy", 1);
app.use(helmet());
app.use(cors());
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));

// -------------------------------------------------------------
// 4. PRODUCTION AUTH ROUTES
// -------------------------------------------------------------

// SEND OTP (Brevo + Database Fix)
app.post("/auth/send-otp", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ success: false, message: "Email required" });

  const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
  const cleanEmail = email.toLowerCase().trim();
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hr buffer

  try {
    // A. Save to Database (Matching column names: email, code, expires_at)
    const { error: dbErr } = await supabase
      .from("temp_otps")
      .upsert({ email: cleanEmail, code: otpCode, expires_at: expiresAt }, { onConflict: "email" });

    if (dbErr) {
      console.error("❌ DB Insert Error:", dbErr.message);
      return res.status(500).json({ success: false, message: "DB Error: " + dbErr.message });
    }

    // B. Send via Brevo
    const sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();
    sendSmtpEmail.subject = `${otpCode} is your Dreamhatcher Verification Code`;
    sendSmtpEmail.sender = { name: process.env.SENDER_NAME, email: process.env.SENDER_EMAIL };
    sendSmtpEmail.to = [{ email: cleanEmail }];
    sendSmtpEmail.htmlContent = `
      <div style="font-family: Arial, sans-serif; padding: 20px;">
        <h2>Dreamhatcher Verification</h2>
        <p>Your verification code is: <b style="font-size: 26px; color: #0A192F;">${otpCode}</b></p>
      </div>
    `;

    await transacEmailApi.sendTransacEmail(sendSmtpEmail);
    console.log(`✅ OTP Email sent successfully to ${cleanEmail}`);
    return res.json({ success: true, message: "OTP sent successfully" });

  } catch (err) {
    console.error("❌ Send-OTP Exception:", err.response ? err.response.text : err.message || err);
    return res.status(500).json({ success: false, message: "Email delivery failed: " + (err.message || "Brevo Error") });
  }
});

// VERIFY OTP & CREATE PROFILE
app.post("/auth/verify-otp", async (req, res) => {
  const email = (req.body.email || "").toLowerCase().trim();
  const otp = String(req.body.otp || "").replace(/\D/g, '').trim();
  const fullName = req.body.full_name || req.body.fullName;
  const phoneNumber = req.body.phone_number || req.body.phoneNumber;

  if (!email || !otp) {
    return res.status(400).json({ success: false, message: "Email and OTP are required" });
  }

  try {
    // 1. Check database for OTP
    const { data: otpData, error: fetchErr } = await supabase
      .from("temp_otps")
      .select("*")
      .eq("email", email)
      .maybeSingle();

    if (fetchErr || !otpData) {
      return res.status(400).json({ success: false, message: "No active OTP found. Request a new code." });
    }

    const expectedCode = String(otpData.code).replace(/\D/g, '').trim();
    if (otp !== expectedCode) {
      return res.status(400).json({ success: false, message: "Invalid OTP code." });
    }

    // 2. Create/Update Public Profile directly
    const { data: profile, error: profileErr } = await supabase
      .from("profiles")
      .upsert([
        {
          email: email,
          full_name: fullName || null,
          phone_number: phoneNumber || null,
          updated_at: new Date().toISOString()
        }
      ], { onConflict: "email" })
      .select()
      .single();

    if (profileErr) {
      console.error("❌ Profile Creation Error:", profileErr.message);
      return res.status(500).json({ success: false, message: "Profile Error: " + profileErr.message });
    }

    // 3. Cleanup temp_otps row after verification
    await supabase.from("temp_otps").delete().eq("email", email);

    console.log(`✅ Verification successful for ${email}`);
    return res.json({ success: true, message: "Verification successful", user: profile });

  } catch (err) {
    console.error("❌ Verify-OTP Exception:", err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// -------------------------------------------------------------
// 5. AUXILIARY ROUTES
// -------------------------------------------------------------
app.get("/health", (_req, res) => res.json({ status: "OK", timestamp: new Date() }));
app.post("/orders", (_req, res) => res.json({ success: true, message: "Order processed" }));

app.post("/wallet/initialize-funding", (_req, res) => {
  res.json({ success: true, message: "Funding initialized" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Dreamhatcher Production Backend active on port ${PORT}`));
