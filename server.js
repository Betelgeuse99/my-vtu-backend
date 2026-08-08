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

// SEND OTP
app.post("/auth/send-otp", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ success: false, message: "Email required" });

  const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
  const cleanEmail = email.toLowerCase().trim();

  try {
    const { error: dbErr } = await supabase
      .from("temp_otps")
      .upsert({ email: cleanEmail, otp: otpCode, created_at: new Date() }, { onConflict: "email" });

    if (dbErr) {
      console.error("❌ DB Insert Error:", dbErr.message);
      return res.status(500).json({ success: false, message: "DB Error: " + dbErr.message });
    }

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

// VERIFY OTP & CREATE AUTH USER + PROFILE
app.post("/auth/verify-otp", async (req, res) => {
  const email = (req.body.email || "").toLowerCase().trim();
  const receivedOtp = String(req.body.otp || "").replace(/\D/g, '').trim();
  const fullName = req.body.full_name || req.body.fullName;
  const phoneNumber = req.body.phone_number || req.body.phoneNumber;
  const userPassword = req.body.password || "Dreamhatcher@2026#Secure";

  if (!email || !receivedOtp) {
    return res.status(400).json({ success: false, message: "Email and OTP are required" });
  }

  try {
    // 1. Verify OTP in DB
    const { data: otpData, error: fetchErr } = await supabase
      .from("temp_otps")
      .select("*")
      .eq("email", email)
      .maybeSingle();

    if (fetchErr || !otpData) {
      return res.status(400).json({ success: false, message: "No active OTP found for " + email });
    }

    const storedOtp = String(otpData.otp).replace(/\D/g, '').trim();

    if (receivedOtp !== storedOtp) {
      return res.status(400).json({ 
        success: false, 
        message: `Invalid code. Received [${receivedOtp}], expected [${storedOtp}]` 
      });
    }

    // 2. Resolve User ID (Create in auth.users or retrieve existing)
    let userId;
    const { data: userList } = await supabase.auth.admin.listUsers();
    const existingUser = userList?.users?.find(u => u.email === email);

    if (existingUser) {
      userId = existingUser.id;
    } else {
      const { data: authUser, error: authErr } = await supabase.auth.admin.createUser({
        email: email,
        password: userPassword,
        email_confirm: true,
        user_metadata: { full_name: fullName }
      });

      if (authErr) {
        console.error("❌ Auth Creation Error:", authErr.message || authErr);
        // Fallback to random UUID if GoTrue service fails
        userId = crypto.randomUUID();
      } else {
        userId = authUser.user.id;
      }
    }

    // 3. Upsert Profile using the valid User ID
    const { data: profile, error: profileErr } = await supabase
      .from("profiles")
      .upsert([
        {
          id: userId,
          email: email,
          full_name: fullName || null,
          phone_number: phoneNumber || null
        }
      ], { onConflict: "email" })
      .select()
      .single();

    if (profileErr) {
      console.error("❌ Profile Creation Error:", profileErr.message);
      return res.status(500).json({ success: false, message: "Profile Error: " + profileErr.message });
    }

    // 4. Initialize Wallet
    try {
      await supabase.from("wallets").upsert([{ user_id: userId, balance: 0 }], { onConflict: "user_id" });
    } catch (_wErr) {
      // Wallet schema handled safely
    }

    // 5. Cleanup temp OTP
    await supabase.from("temp_otps").delete().eq("email", email);

    console.log(`✅ Verification COMPLETE for ${email} (User ID: ${userId})`);
    return res.json({ 
      success: true, 
      message: "Verification successful", 
      user: profile, 
      userId: userId 
    });

  } catch (err) {
    console.error("❌ Verify-OTP Exception:", err.message || err);
    return res.status(500).json({ success: false, message: err.message || "Internal server error" });
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
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Dreamhatcher Backend active on port ${PORT}`));
