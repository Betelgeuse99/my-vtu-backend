if (process.env.NODE_ENV !== "production") {
  require("dotenv").config();
}

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const axios = require("axios");
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

// Helper to normalize network identifiers for Bigisub (1=MTN, 2=Airtel, 3=Glo, 4=9Mobile)
function getNetworkId(net) {
  const map = { "1": 1, "mtn": 1, "2": 2, "airtel": 2, "3": 3, "glo": 3, "4": 4, "9mobile": 4 };
  return map[String(net || "").toLowerCase().trim()] || 1;
}

// Helper to normalize cable provider strings (dstv, gotv, startimes, showmax)
function getCableCode(provider) {
  const clean = String(provider || "").toLowerCase().trim();
  if (clean.includes("gotv")) return "gotv";
  if (clean.includes("dstv")) return "dstv";
  if (clean.includes("star")) return "startimes";
  if (clean.includes("show")) return "showmax";
  return clean;
}

// -------------------------------------------------------------
// 2. EMAIL TEMPLATES (REGISTRATION & PASSWORD RESET)
// -------------------------------------------------------------
function getRegisterEmailHtml(otpCode) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Dreamhatcher Verification</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f4f6f9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color: #f4f6f9; padding: 40px 10px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width: 500px; background-color: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.05); border: 1px solid #e5e7eb;">
          <tr>
            <td align="center" style="background-color: #0d1b2a; padding: 32px 20px;">
              <h1 style="margin: 0; color: #f59e0b; font-size: 24px; font-weight: 800; letter-spacing: 0.5px;">DREAMHATCHER</h1>
              <p style="margin: 4px 0 0 0; color: #94a3b8; font-size: 13px; font-weight: 500;">Security & Authentication</p>
            </td>
          </tr>
          <tr>
            <td style="padding: 36px 32px; text-align: center;">
              <h2 style="margin: 0 0 12px 0; color: #1e293b; font-size: 20px; font-weight: 700;">Verify Your Email Address</h2>
              <p style="margin: 0 0 28px 0; color: #64748b; font-size: 14px; line-height: 1.6;">
                Thank you for choosing Dreamhatcher. Use the One-Time Password (OTP) below to complete your registration request.
              </p>
              <div style="background-color: #f8fafc; border: 2px dashed #cbd5e1; border-radius: 12px; padding: 20px; margin: 0 auto 28px auto; max-width: 280px;">
                <span style="font-family: 'Courier New', Courier, monospace; font-size: 32px; font-weight: 800; color: #0d1b2a; letter-spacing: 8px;">${otpCode}</span>
              </div>
              <p style="margin: 0 0 8px 0; color: #64748b; font-size: 13px;">
                This code will expire in <strong>10 minutes</strong>.
              </p>
              <p style="margin: 0; color: #94a3b8; font-size: 12px; line-height: 1.5;">
                If you did not request this code, please ignore this email.
              </p>
            </td>
          </tr>
          <tr>
            <td style="background-color: #f8fafc; padding: 20px; text-align: center; border-top: 1px solid #f1f5f9;">
              <p style="margin: 0; color: #94a3b8; font-size: 12px;">
                &copy; 2026 Dreamhatcher VTU. All rights reserved.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function getResetEmailHtml(otpCode) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Reset Your Password</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f4f6f9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color: #f4f6f9; padding: 40px 10px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width: 500px; background-color: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.05); border: 1px solid #e5e7eb;">
          <tr>
            <td align="center" style="background-color: #0d1b2a; padding: 32px 20px;">
              <h1 style="margin: 0; color: #f59e0b; font-size: 24px; font-weight: 800; letter-spacing: 0.5px;">DREAMHATCHER</h1>
              <p style="margin: 4px 0 0 0; color: #ef4444; font-size: 13px; font-weight: 600;">Password Reset Request</p>
            </td>
          </tr>
          <tr>
            <td style="padding: 36px 32px; text-align: center;">
              <h2 style="margin: 0 0 12px 0; color: #1e293b; font-size: 20px; font-weight: 700;">Reset Your Password</h2>
              <p style="margin: 0 0 28px 0; color: #64748b; font-size: 14px; line-height: 1.6;">
                We received a request to reset your Dreamhatcher account password. Enter the code below to proceed:
              </p>
              <div style="background-color: #fef2f2; border: 2px dashed #fca5a5; border-radius: 12px; padding: 20px; margin: 0 auto 28px auto; max-width: 280px;">
                <span style="font-family: 'Courier New', Courier, monospace; font-size: 32px; font-weight: 800; color: #991b1b; letter-spacing: 8px;">${otpCode}</span>
              </div>
              <p style="margin: 0 0 8px 0; color: #64748b; font-size: 13px;">
                This reset code expires in <strong>10 minutes</strong>.
              </p>
              <p style="margin: 0; color: #dc2626; font-size: 12px; line-height: 1.5; font-weight: 500;">
                If you did not request a password reset, please secure your account or ignore this email.
              </p>
            </td>
          </tr>
          <tr>
            <td style="background-color: #f8fafc; padding: 20px; text-align: center; border-top: 1px solid #f1f5f9;">
              <p style="margin: 0; color: #94a3b8; font-size: 12px;">
                &copy; 2026 Dreamhatcher VTU. All rights reserved.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// -------------------------------------------------------------
// 3. AUTHENTICATION ROUTES (Native Brevo API)
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
        htmlContent: getRegisterEmailHtml(otpCode)
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

app.post("/auth/send-reset-otp", async (req, res) => {
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
        subject: `${otpCode} is your Password Reset Code`,
        htmlContent: getResetEmailHtml(otpCode)
      },
      {
        headers: {
          "api-key": process.env.BREVO_API_KEY,
          "content-type": "application/json"
        }
      }
    );

    res.json({ success: true, message: "Password reset code sent" });
  } catch (err) {
    console.error("❌ Send Reset OTP Error:", err.response?.data || err.message);
    res.status(500).json({ success: false, message: "Failed to send reset code" });
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
      wallet: wallet || { balance: 0 }, 
      session: authData.session 
    });
  } catch (err) {
    console.error("❌ LOGIN_ERROR:", err.message);
    res.status(500).json({ success: false, message: "Login service error" });
  }
});

// -------------------------------------------------------------
// 4. BIGISUB VTU & UTILITIES ENGINE
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

// DATA PLANS & PURCHASE
app.get("/api/v2/vtu/data/plans", async (req, res) => {
  try {
    const netId = getNetworkId(req.query.network);
    const response = await bigiClient.get(`/api/v2/vtu/data/plans/?network=${netId}`);
    const plans = response.data?.data || (Array.isArray(response.data) ? response.data : []);
    res.json({ success: true, data: plans });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message, data: [] });
  }
});

app.post("/api/v2/vtu/data/purchase", async (req, res) => {
  try {
    const { network, plan, phone_number } = req.body;
    const response = await bigiClient.post("/api/v2/vtu/data/purchase/", {
      network: getNetworkId(network),
      plan: Number(plan),
      phone_number: String(phone_number).trim(),
      pin: DEFAULT_PIN,
      ported_number: true
    });
    res.json(response.data);
  } catch (err) {
    res.status(400).json({ success: false, message: err.response?.data?.message || err.message });
  }
});

// CABLE TV (FIXES VERIFICATION & PLANS)
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

    console.log(`📡 Verifying Cable: provider=${provider}, card_no=${cardNo}`);

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
    console.error("❌ Cable Verify Error:", err.response?.data || err.message);
    res.status(400).json({ 
      success: false, 
      message: err.response?.data?.message || err.response?.data?.detail || "Customer account not found or invalid smartcard number" 
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

// EDUCATION (EXAM PRICES)
app.get("/api/v2/bills/result-checker/prices", async (_req, res) => {
  try {
    const response = await bigiClient.get("/api/v2/bills/result-checker/prices/");
    const prices = response.data?.data?.prices || response.data?.data || [];
    res.json({ success: true, data: prices });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message, data: [] });
  }
});

// HEALTH CHECK
app.get("/health", (_req, res) => res.json({ status: "OK", timestamp: new Date() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Dreamhatcher Production Server active on port ${PORT}`));
