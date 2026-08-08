if (process.env.NODE_ENV !== "production") {
  require("dotenv").config();
}

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const crypto = require("crypto");
const axios = require("axios");
const cron = require("node-cron");
const supabase = require("./config/supabase");

var SibApiV3Sdk = require('sib-api-v3-sdk');
var defaultClient = SibApiV3Sdk.ApiClient.instance;

var apiKey = defaultClient.authentications['api-key'];
apiKey.apiKey = process.env.BREVO_API_KEY;

var brevoApi = new SibApiV3Sdk.TransactionalEmailsApi();

const app = express();
app.set("trust proxy", 1);
app.use(helmet());

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",")
  : ["http://localhost:3000", process.env.SERVER_BASE_URL].filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("CORS policy restriction: Origin not allowed"));
      }
    },
    credentials: true,
  })
);

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

const BIGISUB_BASE_URL = "https://bigisub.ng/api";
const SERVER_BASE_URL = process.env.SERVER_BASE_URL;

// Health check
app.get("/health", async (_req, res) => {
  try {
    const { error } = await supabase.from("orders").select("order_id").limit(1);
    if (error) throw error;
    res.json({ status: "OK", database: "connected", timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ status: "ERROR", database: "disconnected", details: err.message });
  }
});

// Send OTP (Strict Supabase Insert + Error Throwing)
app.post("/auth/send-otp", async (req, res, next) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, error: { message: "Email is required" } });

    const normalizedEmail = email.trim().toLowerCase();
    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    // 1. Force write to Supabase
    const { error: dbOtpErr } = await supabase
      .from("temp_otps")
      .upsert({ email: normalizedEmail, code: otpCode, expires_at: expiresAt }, { onConflict: "email" });

    // 🔴 IF SUPABASE FAILS, STOP HERE AND RETURN DB ERROR TO APP
    if (dbOtpErr) {
      return res.status(500).json({ 
        success: false, 
        error: { message: "Supabase DB Insert Error: " + dbOtpErr.message } 
      });
    }

    // 2. Send email via Brevo
    var sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();
    sendSmtpEmail.subject = `${otpCode} is your Dreamhatcher Verification Code`;
    sendSmtpEmail.sender = { name: process.env.SENDER_NAME, email: process.env.SENDER_EMAIL };
    sendSmtpEmail.to = [{ email: normalizedEmail }];
    sendSmtpEmail.htmlContent = `
      <div style="font-family: Arial, sans-serif; padding: 20px;">
        <h2>Dreamhatcher VTU Verification</h2>
        <p>Your verification code is: <b style="font-size: 26px; color: #0A192F;">${otpCode}</b></p>
        <p>Expires in 10 minutes. Do not share this code with anyone.</p>
      </div>
    `;

    await brevoApi.sendTransacEmail(sendSmtpEmail);
    return res.json({ success: true, message: "OTP sent successfully" });
  } catch (err) {
    next(err);
  }
});

// Verify OTP Route
app.post("/auth/verify-otp", async (req, res, next) => {
  try {
    const { email, otp, full_name, phone_number } = req.body;

    if (!email || !otp) {
      return res.status(400).json({ success: false, error: { message: "Email and OTP are required" } });
    }

    const normalizedEmail = email.trim().toLowerCase();

    // 1. Fetch from Supabase
    const { data: storedData, error: fetchErr } = await supabase
      .from("temp_otps")
      .select("*")
      .eq("email", normalizedEmail)
      .maybeSingle();

    if (fetchErr) {
      return res.status(500).json({ success: false, error: { message: "DB Query Error: " + fetchErr.message } });
    }

    if (!storedData) {
      return res.status(400).json({ success: false, error: { message: "No OTP record found in database for this email." } });
    }

    if (new Date() > new Date(storedData.expires_at)) {
      await supabase.from("temp_otps").delete().eq("email", normalizedEmail);
      return res.status(400).json({ success: false, error: { message: "OTP has expired." } });
    }

    const receivedCode = String(otp).trim().replace(/['"]+/g, '');
    const expectedCode = String(storedData.code).trim();

    if (receivedCode !== expectedCode) {
      return res.status(400).json({ success: false, error: { message: "Invalid OTP code." } });
    }

    // 2. Cleanup OTP record
    await supabase.from("temp_otps").delete().eq("email", normalizedEmail);

    // 3. Upsert into profiles
    const { data: userProfile, error: dbErr } = await supabase
      .from("profiles")
      .upsert(
        [
          {
            email: normalizedEmail,
            full_name: full_name || null,
            phone_number: phone_number || null,
            updated_at: new Date().toISOString(),
          },
        ],
        { onConflict: "email" }
      )
      .select()
      .single();

    if (dbErr) {
      return res.status(500).json({ success: false, error: { message: "Profile creation error: " + dbErr.message } });
    }

    return res.json({
      success: true,
      message: "Verification successful",
      user: userProfile,
    });
  } catch (err) {
    next(err);
  }
});

app.use((err, _req, res, _next) => {
  res.status(500).json({ success: false, error: { message: err.message || "Internal error" } });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Server active on port ${PORT}`));
