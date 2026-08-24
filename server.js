// ✅ ALWAYS LOAD .env FIRST
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const axios = require("axios");
const https = require("https");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

// Crash forensics: without these an unhandled rejection kills the server
// silently and there is no trace of why. Logged loudly instead.
process.on("uncaughtException", (err) => {
  console.error("💥 UNCAUGHT EXCEPTION:", err.stack || err.message);
});
process.on("unhandledRejection", (reason) => {
  console.error("💥 UNHANDLED REJECTION:", reason instanceof Error ? reason.stack : reason);
});

const alrahuzService = require("./services/alrahuz");

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
  timeout: 25000,
  headers: {
    Authorization: "Token " + BIGISUB_TOKEN,
    "Content-Type": "application/json"
  }
});

const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));

// Kill switch for hung requests: after 30s of no response, log loudly so we
// can see WHICH endpoint stalls (e.g. a slow provider API) instead of the
// request silently hanging until Render cuts it.
app.use((req, res, next) => {
  res.setTimeout(30000, () => {
    console.error("⏰ Response timeout on " + req.method + " " + req.url);
  });
  next();
});

function getNetworkId(net) {
  // Bigisub network IDs, verified against the live API (2026-08-17):
  //   1 = MTN, 2 = GLO, 3 = AIRTEL, 4 = 9MOBILE
  // The app sends EITHER a slug ("mtn"/"glo"/"airtel"/"9mobile") for airtime &
  // recharge-pins, OR the Android registry's numeric id for data. The Android
  // registry numbers GLO=3 / AIRTEL=2 (swapped vs Bigisub), so the numeric keys
  // below translate those app ids into Bigisub's ids. Slugs map straight to
  // Bigisub ids. Keep both halves consistent with each other.
  const map = { "1": 1, "mtn": 1, "2": 3, "glo": 2, "3": 2, "airtel": 3, "4": 4, "9mobile": 4, "eti": 4 };
  return map[String(net || "").toLowerCase().trim()] || 1;
}

function getCableCode(provider) {
  const clean = String(provider || "").toLowerCase().trim();
  if (clean.includes("gotv")) return "gotv";
  if (clean.includes("dstv")) return "dstv";
  if (clean.includes("star")) return "startimes";
  if (clean.includes("show")) return "showmax";
  return clean;
}

function formatLocalPhone(phone) {
  let clean = String(phone || "").replace(/[^0-9]/g, "");
  if (clean.startsWith("234") && clean.length > 10) {
    clean = "0" + clean.slice(3);
  } else if (clean.length === 10 && !clean.startsWith("0")) {
    clean = "0" + clean;
  }
  return clean;
}

function formatSquadGender(g) {
  const clean = String(g || "").toLowerCase().trim();
  if (clean === "female" || clean === "f" || clean === "2") return "2";
  return "1";
}

// -------------------------------------------------------------
// PROVIDER ROUTING HELPERS (bigisub | alrahuz per service)
// -------------------------------------------------------------

/** Active provider for [service] from provider_routing (default bigisub). */
async function getActiveProvider(service) {
  try {
    const { data } = await supabase
      .from("provider_routing")
      .select("provider")
      .eq("service", service)
      .maybeSingle();
    return data?.provider === "alrahuz" ? "alrahuz" : "bigisub";
  } catch {
    return "bigisub";
  }
}

/**
 * Selling price for [planRow] on [provider]. alrahuz_retail_price is an
 * optional per-provider override; the shared retail_price is the default.
 */
function effectiveRetailPrice(planRow, provider) {
  if (provider === "alrahuz") {
    const override = Number(planRow.alrahuz_retail_price);
    if (override > 0) return override;
  }
  return Number(planRow.retail_price || 0);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolves a plan reference from the app/admin to a data_plans row.
 * Accepts the row uuid, a Bigisub numeric id, or an Alrahuz numeric id —
 * whichever provider is routed, the id the caller holds still resolves.
 */
async function findPlanRow(planRef) {
  const ref = String(planRef).trim();
  if (UUID_RE.test(ref)) {
    const { data } = await supabase.from("data_plans").select("*").eq("id", ref).maybeSingle();
    if (data) return data;
  }
  const { data: byAlrahuz } = await supabase
    .from("data_plans")
    .select("*")
    .eq("alrahuz_plan_id", ref)
    .maybeSingle();
  if (byAlrahuz) return byAlrahuz;
  const { data: byBigi } = await supabase
    .from("data_plans")
    .select("*")
    .eq("bigi_plan_id", ref)
    .maybeSingle();
  return byBigi || null;
}

/**
 * The provider-specific plan id for [planRow], or null when the plan cannot
 * be fulfilled on that provider. Bigisub ids are pure numerics; the
 * "ALR-xxx" placeholders used for Alrahuz-exclusive plans are not real
 * Bigisub ids and must never be sent to their API.
 */
function planProviderId(planRow, provider) {
  if (!planRow) return null;
  if (provider === "alrahuz") {
    return planRow.alrahuz_plan_id ? String(planRow.alrahuz_plan_id) : null;
  }
  const id = String(planRow.bigi_plan_id || "");
  return /^\d+$/.test(id) ? id : null;
}

/**
 * Writes an entry into the transactions ledger. The Android app reads this
 * table directly from Supabase for purchase history, and the admin dashboard
 * ledger reads it via /api/v2/admin/transactions — logging here keeps both in
 * sync with wallet movements. Failures inside logTx must never break a
 * purchase response, so everything is caught.
 */
async function logTx({ user_id, title, service_type, amount, recipient, status, reference, provider }) {
  try {
    await supabase.from("transactions").insert({
      user_id,
      title: String(title || service_type || "Transaction"),
      service_type,
      amount: Number(amount) || 0,
      recipient: String(recipient || "").trim(),
      status: status || "successful",
      reference,
      provider: provider || null,
    });
  } catch (err) {
    console.warn("⚠️ transactions log failed:", err.message);
  }
}

function newTxRef(prefix) {
  return prefix + "-" + Date.now() + "-" + crypto.randomBytes(3).toString("hex").toUpperCase();
}

// -------------------------------------------------------------
// WALLET HELPERS (balance check + debit on successful purchase)
// -------------------------------------------------------------

/**
 * Resolves the signed-in user for a purchase. Prefers the x-user-id header
 * (sent by the Android app), falling back to a userId field in the body.
 */
async function requestUserId(req) {
  const token = (req.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user.id;
}

async function getWallet(userId) {
  // The wallets table is keyed by user_id and has no id column.
  const { data, error } = await supabase
    .from("wallets")
    .select("balance")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/**
 * Ensures a wallet row exists for [userId], creating a zero-balance row when
 * missing. Users who signed up before the on_auth_user_created trigger existed
 * (or whose row was never created) had no row — which made the old debit's
 * .single() throw "Cannot coerce the result to a single JSON object" and leave
 * orders fulfilled but unpaid. Service role bypasses RLS. Returns the wallet.
 */
async function ensureWallet(userId) {
  let wallet = await getWallet(userId);
  if (wallet) return wallet;

  const { data, error } = await supabase
    .from("wallets")
    .insert({ user_id: userId, balance: 0 })
    .select("balance")
    .maybeSingle();
  if (error || !data) {
    // Race: another request may have just created it — re-read before failing.
    wallet = await getWallet(userId);
    if (wallet) return wallet;
    throw error || new Error("Could not create wallet for " + userId);
  }
  return data;
}

/**
 * Returns a user-facing error message when [userId]'s wallet cannot cover
 * [amount], or null when the purchase may proceed. This MUST stay enforced
 * server-side — the app-side check is only a UX nicety.
 */
async function walletShortfallMessage(userId, amount) {
  const wallet = await ensureWallet(userId);
  const balance = Number(wallet.balance || 0);
  if (balance < amount) {
    return (
      "Insufficient wallet balance — you need ₦" + amount.toLocaleString() +
      " but your balance is ₦" + balance.toLocaleString() +
      ". Please fund your wallet first."
    );
  }
  return null;
}

/**
 * Debits [amount] from [userId]'s wallet via the atomic debit_wallet RPC.
 * Called BEFORE the order is fulfilled so an order can never be delivered
 * without charging the user. The RPC (SECURITY DEFINER in CURRENT_SETUP.sql)
 * self-heals a missing wallet row, serializes concurrent purchases, refuses
 * to drive the balance negative, and writes the wallet_transactions audit
 * row in the same transaction. Returns the new balance, or null when the
 * debit failed.
 */
async function debitWallet(userId, amount) {
  const { data, error } = await supabase.rpc("debit_wallet", {
    p_user_id: userId,
    p_amount: amount,
  });
  if (error || data === null || data === undefined) {
    console.error("❌ Wallet debit error:", error?.message || "0 rows updated");
    return null;
  }
  return Number(data);
}

/**
 * Refunds [amount] to [userId]'s wallet via the atomic credit_wallet RPC when
 * an order was debited but Bigisub rejected it. Returns the new balance, or
 * null when the credit failed.
 */
async function creditWallet(userId, amount) {
  const { data, error } = await supabase.rpc("credit_wallet", {
    p_user_id: userId,
    p_amount: amount,
  });
  if (error || data === null || data === undefined) {
    console.error("❌ Wallet credit error:", error?.message || "0 rows updated");
    return null;
  }
  return Number(data);
}

// Bigisub can answer a purchase request with an HTTP error OR with an HTTP 200
// that still means failure. Failure indicators are inconsistent across
// endpoints and can be nested inside `data` (e.g. the outer wrapper says
// success but data.status is "failed"), so walk the whole response looking for
// any failure signal. If nothing indicates failure, treat the order as placed.
function bigiFailed(node, depth = 0) {
  if (!node || depth > 3) return false;

  if (typeof node === "string") {
    return ["failed", "error", "failure", "fail", "declined", "cancelled"].includes(node.toLowerCase());
  }
  if (typeof node !== "object" || Array.isArray(node)) return false;

  const isFailureValue = (v) => {
    if (v === false) return true;
    if (typeof v === "number") return v >= 400;
    if (typeof v === "string") {
      return ["false", "0", "no", "failed", "error", "failure", "fail", "declined", "cancelled"].includes(v.toLowerCase());
    }
    return false;
  };

  if ("success" in node && isFailureValue(node.success)) return true;
  if ("status" in node && isFailureValue(node.status)) return true;
  if ("error" in node && node.error) return true;
  if ("code" in node && typeof node.code === "number" && node.code >= 400) return true;
  if ("status_code" in node && typeof node.status_code === "number" && node.status_code >= 400) return true;
  if ("statusCode" in node && typeof node.statusCode === "number" && node.statusCode >= 400) return true;

  const nested = node.data;
  if (nested && typeof nested === "object") {
    if (Array.isArray(nested)) {
      return nested.some((item) => bigiFailed(item, depth + 1));
    }
    return bigiFailed(nested, depth + 1);
  }
  return false;
}

function bigiErrorMessage(data, fallback) {
  return (
    data?.message ||
    data?.detail ||
    (typeof data?.error === "string" ? data.error : data?.error?.message) ||
    fallback
  );
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
        htmlContent: `<html><body><h2>Dreamhatcher Verification</h2><p>Your code is: <b>${otpCode}</b></p></body></html>`
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

    await supabase.from("wallets").upsert({ user_id: userId, balance: 0 }, { onConflict: "user_id" });
    await supabase.from("temp_otps").delete().eq("email", email);

    res.json({ success: true, message: "Verification successful", userId, user: profile });
  } catch (err) {
    console.error("❌ VERIFY_ERROR:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /auth/refresh — exchange a refresh token for a fresh session.
// The admin dashboard stores this refresh token and calls this whenever its
// access token (1h TTL) expires, so the session survives indefinitely with
// activity instead of hard-failing after an hour.
app.post("/auth/refresh", async (req, res) => {
  const refreshToken = req.body.refresh_token;
  if (!refreshToken) {
    return res.status(400).json({ success: false, message: "refresh_token required" });
  }
  try {
    const { data, error } = await supabase.auth.refreshSession({ refresh_token: refreshToken });
    if (error || !data?.session) {
      return res.status(401).json({ success: false, message: "Session expired — please sign in again" });
    }
    res.json({
      success: true,
      session: {
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
        expires_at: data.session.expires_at
      },
      user: data.user ? { id: data.user.id, email: data.user.email } : null
    });
  } catch (err) {
    console.error("❌ Token refresh error:", err.message);
    res.status(500).json({ success: false, message: "Refresh failed" });
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
// 3. SQUAD DEDICATED VIRTUAL ACCOUNT & WEBHOOK
// -------------------------------------------------------------
app.post("/api/v2/wallet/virtual-account", async (req, res) => {
  try {
    const { 
      userId, customer_identifier, 
      firstName, first_name, 
      lastName, last_name, 
      phone, phone_number, mobile_num,
      bvn, dob, gender, address, email 
    } = req.body;

    const targetUserId = userId || customer_identifier;
    const userEmail = (email || req.user?.email || "").toLowerCase().trim();

    if (!targetUserId || !userEmail) {
      return res.status(400).json({ success: false, message: "User ID and Email are required" });
    }

    const { data: profile } = await supabase
      .from("profiles")
      .select("virtual_account_number, virtual_bank_name, virtual_account_name")
      .eq("id", targetUserId)
      .maybeSingle();

    if (profile?.virtual_account_number) {
      return res.json({
        success: true,
        account_number: profile.virtual_account_number,
        bank_name: profile.virtual_bank_name || "GTBank / Squad",
        account_name: profile.virtual_account_name
      });
    }

    const cleanBvn = String(bvn || "").replace(/\D/g, "");
    if (!cleanBvn || cleanBvn.length !== 11) {
      return res.status(400).json({ success: false, message: "Invalid BVN. Must be exactly 11 digits." });
    }

    const cleanPhone = formatLocalPhone(phone || phone_number || mobile_num);
    const genderCode = formatSquadGender(gender);

    const squadSecret = process.env.SQUADCO_SECRET_KEY || process.env.SQUAD_SECRET_KEY || "";
    let squadBaseUrl = process.env.SQUAD_BASE_URL || (squadSecret.includes("_test_") ? "https://sandbox-api-d.squadco.com" : "https://api-d.squadco.com");
    squadBaseUrl = squadBaseUrl.trim().replace(/\/+$/, "");

    const payload = {
      customer_identifier: String(targetUserId),
      first_name: String(firstName || first_name || "Customer").trim(),
      last_name: String(lastName || last_name || "User").trim(),
      mobile_num: cleanPhone || "08012345678",
      email: userEmail,
      bvn: cleanBvn,
      dob: String(dob || "01/01/1990").trim(),
      gender: genderCode,
      address: String(address || "Maiduguri, Nigeria").trim(),
      beneficiary_account: process.env.SQUAD_BENEFICIARY_ACCOUNT || "0123456789"
    };

    let response;
    try {
      response = await axios.post(squadBaseUrl + "/virtual-account/business", payload, {
        headers: {
          Authorization: "Bearer " + squadSecret,
          "Content-Type": "application/json"
        }
      });
    } catch (apiErr) {
      if (apiErr.response?.status === 404) {
        response = await axios.post(squadBaseUrl + "/virtual-account", payload, {
          headers: {
            Authorization: "Bearer " + squadSecret,
            "Content-Type": "application/json"
          }
        });
      } else {
        throw apiErr;
      }
    }

    const squadData = response.data;

    if (squadData.status === 200 || squadData.success) {
      const va = squadData.data || squadData;
      const accNo = va.virtual_account_number || va.account_number;
      const bankName = va.bank_name || "GTBank / Squad";
      const accName = va.account_name || (payload.first_name + " " + payload.last_name);

      await supabase.from("profiles").update({
        virtual_account_number: accNo,
        virtual_bank_name: bankName,
        virtual_account_name: accName
      }).eq("id", targetUserId);

      return res.status(200).json({
        success: true,
        account_number: accNo,
        bank_name: bankName,
        account_name: accName
      });
    } else {
      return res.status(400).json({
        success: false,
        message: squadData.message || "Squad API error",
        details: squadData.data
      });
    }
  } catch (error) {
    const errorDetails = error.response?.data || error.message;
    console.error("❌ Squad Integration Error:", JSON.stringify(errorDetails, null, 2));
    return res.status(error.response?.status || 500).json({
      success: false,
      message: error.response?.data?.message || "Failed to create virtual account with Squad",
      details: errorDetails
    });
  }
});

app.post("/api/v2/webhooks/squad", async (req, res) => {
  // SECURITY: this endpoint must NEVER credit a wallet without proof the
  // webhook came from Squad. The HMAC-SHA512 signature over the RAW body is
  // that proof (the raw bytes are captured by the express.json verify hook
  // above — re-serializing req.body would break the HMAC). The app's live
  // funding flow uses the Supabase squad-webhook edge function; this route
  // is kept for compatibility and must enforce the same rules.
  try {
    const squadSecret = process.env.SQUAD_SECRET_KEY || process.env.SQUADCO_SECRET_KEY || "";
    // Squad sends the HMAC-SHA512 signature (of the raw body with the secret
    // key) in EITHER header — accept both, require at least one. Compared
    // case-insensitively because Squad sends uppercase hex.
    const signature = req.get("x-squad-signature") || req.get("x-squad-encrypted-body") || "";
    const rawBody = (req.rawBody || Buffer.from("")).toString("utf8");

    if (!squadSecret || !signature || !rawBody) {
      console.error("❌ Squad Webhook: missing secret/signature/body");
      return res.status(401).json({ success: false, message: "Missing signature" });
    }

    const computed = crypto.createHmac("sha512", squadSecret).update(rawBody).digest("hex").toUpperCase();
    if (computed !== signature.trim().toUpperCase()) {
      console.error("❌ Squad Webhook: invalid signature");
      return res.status(401).json({ success: false, message: "Invalid signature" });
    }

    const payload = req.body;
    const bodyData = payload?.Body || payload?.data || payload;
    const txRef = payload?.TransactionRef || bodyData?.transaction_ref;
    const status = (bodyData?.transaction_status || payload?.status || "").toString().toLowerCase();
    const event = (payload?.Event || "").toString().toLowerCase();

    if (event && event !== "charge_successful" && event !== "transaction.success" && status !== "success") {
      return res.status(200).json({ success: true, message: "Ignored non-successful transaction" });
    }

    if (!txRef) {
      return res.status(400).json({ success: false, message: "No transaction reference" });
    }

    // Only credit a payment row this app actually created — never by email.
    const { data: payment } = await supabase
      .from("payments")
      .select("*")
      .eq("reference", txRef)
      .maybeSingle();
    if (!payment) {
      return res.status(200).json({ success: true, message: "Payment not tracked" });
    }
    if (payment.status === "success") {
      return res.status(200).json({ success: true, message: "Already processed" });
    }

    const paymentAmount = Number(payment.amount);
    if (!paymentAmount || paymentAmount <= 0) {
      return res.status(500).json({ success: false, message: "Invalid payment amount" });
    }

    // Atomic credit via the credit_wallet RPC: self-heals the wallet row,
    // serializes concurrent webhooks, writes the audit trail.
    const { data: newBalance, error: creditError } = await supabase.rpc("credit_wallet", {
      p_user_id: payment.user_id,
      p_amount: paymentAmount,
      p_description: "Wallet funding via Squad - Verified"
    });
    if (creditError || newBalance === null || newBalance === undefined) {
      console.error("❌ Wallet Update Error:", creditError?.message || "0 rows updated");
      return res.status(500).json({ success: false, message: "Failed to update wallet row" });
    }

    await supabase.from("payments").update({ status: "success", squad_response: payload }).eq("id", payment.id);

    // Purchase-history row (schema matches the transactions table).
    try {
      await supabase.from("transactions").insert({
        user_id: payment.user_id,
        title: "Wallet Funding",
        service_type: "funding",
        amount: paymentAmount,
        recipient: "Squad",
        status: "successful",
        reference: txRef
      });
    } catch (txErr) {
      console.warn("transactions insert failed:", txErr.message);
    }

    console.log("✅ Wallet funded: " + payment.user_id + " +₦" + paymentAmount + " (New Balance: ₦" + newBalance + ")");
    return res.json({ success: true, message: "Wallet funded successfully", balance: newBalance });
  } catch (err) {
    console.error("❌ Squad Webhook Exception:", err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// -------------------------------------------------------------
// 4. BIGISUB VTU & UTILITIES ENGINE
// -------------------------------------------------------------
app.post("/api/v2/vtu/airtime/purchase", async (req, res) => {
  try {
    const { network, phone_number, amount } = req.body;
    const userId = await requestUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, message: "Authentication required" });
    }

    const price = Number(amount) || 0;
    if (price <= 0) {
      return res.status(400).json({ success: false, message: "Invalid amount" });
    }


    const shortfall = await walletShortfallMessage(userId, price);
    if (shortfall) {
      return res.status(400).json({ success: false, message: shortfall });
    }

    // Debit FIRST so an order can never be delivered without charging the
    // user. Refunded automatically if Bigisub rejects the order below.
    const newBalance = await debitWallet(userId, price);
    if (newBalance === null) {
      return res.status(400).json({ success: false, message: "Could not debit your wallet. Please try again." });
    }
    // Stash the debit on the request so the catch block (which cannot see
    // try-block consts) can refund the exact amount if Bigisub rejects it.
    req._debit = { userId: userId, price: price };
    const txRef = newTxRef("AIR");

    const response = await bigiClient.post("/api/v2/vtu/airtime/purchase/", {
      network: getNetworkId(network),
      phone_number: String(phone_number).trim(),
      amount: String(amount),
      airtime_type: "vtu",
      pin: DEFAULT_PIN
    });
    console.log("📦 AIRTIME raw response:", JSON.stringify(response.data));

    if (bigiFailed(response.data)) {
      // Order was not fulfilled — refund the debit and log the failure.
      await creditWallet(userId, price);
      await logTx({
        user_id: userId,
        title: "Airtime ₦" + price + " — Failed",
        service_type: "airtime",
        amount: price,
        recipient: String(phone_number).trim(),
        status: "failed",
        reference: txRef,
        provider: "bigisub"
      });
      return res.status(400).json({
        success: false,
        message: bigiErrorMessage(response.data, "Bigisub rejected this purchase")
      });
    }


    await logTx({
      user_id: userId,
      title: "Airtime ₦" + price,
      service_type: "airtime",
      amount: price,
      recipient: String(phone_number).trim(),
      status: "successful",
      reference: txRef,
      provider: "bigisub"
    });
    console.log("✅ Airtime: user " + userId + " -₦" + price + " (balance ₦" + newBalance + ")");
    res.json({ success: true, message: "Airtime top-up successful", data: response.data, balance: newBalance });
  } catch (err) {
    console.error("❌ Airtime Error:", err.response?.data || err.message);
    // try-block consts are invisible to catch, so the debit context comes
    // from the request (stashed right after the debit succeeded).
    const ctx = req._debit || null;
    const bigiStatus = err.response?.status || 0;
    if (bigiStatus >= 400 && bigiStatus < 500) {
      // Bigisub rejected the request outright (bad amount, bad phone, auth…)
      // — the order was NOT placed. Refund the debit so the user is never
      // charged for an order that didn't happen.
      if (ctx) {
        await creditWallet(ctx.userId, ctx.price);
      }
      console.error("❌ Order rejected by Bigisub:", err.response?.data || err.message);
      return res.status(400).json({ success: false, message: bigiErrorMessage(err.response?.data, err.message) });
    }
    // 5xx / timeout / connection error: Bigisub may STILL have processed the
    // order (it has delivered airtime while returning "An error occurred…").
    // We already debited, so keep the charge and let the user verify delivery
    // — refunding blindly would hand out free airtime.
    console.error("⚠️ Order outcome uncertain:", err.response?.data || err.message);
    return res.json({
      success: true,
      message: "Request submitted — delivery may take a few minutes. If you don't receive it, contact support for a refund."
    });
  }
});

app.get("/api/v2/vtu/data/plans", async (req, res) => {
  try {
    const appNetId = Number(req.query.network) || 1;
    const provider = await getActiveProvider("data");

    const { data: plans, error } = await supabase
      .from("data_plans")
      .select("*")
      .eq("network_id", appNetId)
      .eq("is_active", true)
      .order("retail_price", { ascending: true });

    if (error) throw error;

    // The id surfaced to the app is the ACTIVE provider's plan id — when the
    // admin flips the route to Alrahuz, purchases come back with Alrahuz ids
    // and are fulfilled by Alrahuz without any app update. Plans that cannot
    // be fulfilled by the ACTIVE provider (e.g. Alrahuz-exclusive rows while
    // routed to Bigisub) are hidden so the app never shows a dead plan.
    const formattedPlans = plans
      .map(p => {
        const activeId = planProviderId(p, provider);
        if (!activeId) return null;
        const effPrice = effectiveRetailPrice(p, provider);
        return {
          row_id: p.id,
          id: Number(activeId),
          plan_id: Number(activeId),
          bigi_plan_id: /^\d+$/.test(String(p.bigi_plan_id || "")) ? p.bigi_plan_id : null,
          alrahuz_plan_id: p.alrahuz_plan_id ? Number(p.alrahuz_plan_id) : null,
          network: p.network_id,
          plantype: p.plan_type,
          size: p.volume,
          validity: p.validity,
          // effective selling price for the ACTIVE provider
          amount: effPrice,
          plan_amount: effPrice,
          // keep the raw fields the admin dashboard reads
          retail_price: effPrice,
          buy_price: provider === "alrahuz"
            ? (Number(p.alrahuz_buy_price) || p.buy_price)
            : p.buy_price,
          bigi_buy_price: p.buy_price,
          alrahuz_buy_price: p.alrahuz_buy_price,
          alrahuz_retail_price: p.alrahuz_retail_price,
          provider,
        };
      })
      .filter(Boolean);

    res.json({ success: true, provider, data: formattedPlans });
  } catch (err) {
    console.error("❌ Data plans fetch error:", err.message);
    res.status(500).json({ success: false, message: err.message, data: [] });
  }
});

app.post("/api/v2/vtu/data/purchase", async (req, res) => {
  try {
    const { network, plan, plan_id, phone_number } = req.body;
    const userId = await requestUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, message: "Authentication required" });
    }

    const targetPlan = plan || plan_id;
    if (!targetPlan) {
      return res.status(400).json({ success: false, message: "Invalid or missing plan ID" });
    }

    // Which provider is the admin routing data through right now?
    let provider = await getActiveProvider("data");

    // Resolve the plan in the unified catalog — accepts a Bigisub id, an
    // Alrahuz id, or the catalog row uuid, so the app works no matter which
    // provider's ids it currently holds.
    const planRow = await findPlanRow(targetPlan);

    let fulfillProvider = provider;
    let providerPlanId = planProviderId(planRow, provider);
    if (!providerPlanId && planRow) {
      // Plan exists but has no ID on the routed provider (e.g. an
      // Alrahuz-exclusive plan while routed to Bigisub). Fall back to the
      // provider that CAN fulfil it rather than failing the user.
      const other = provider === "alrahuz" ? "bigisub" : "alrahuz";
      const otherId = planProviderId(planRow, other);
      if (otherId) {
        fulfillProvider = other;
        providerPlanId = otherId;
        console.log(`ℹ️ Plan ${targetPlan} not on ${provider} — falling back to ${other}`);
      }
    }

    if (!fulfillProvider || !providerPlanId) {
      return res.status(400).json({ success: false, message: "Data plan not found or unavailable" });
    }

    // Server-authoritative price from the synced catalog; client amount only
    // as a last resort for unknown plans.
    let price = planRow ? effectiveRetailPrice(planRow, fulfillProvider) : 0;
    if (!(price > 0)) price = Number(req.body.amount) || 0;
    if (price <= 0) {
      return res.status(400).json({ success: false, message: "Could not determine plan price" });
    }

    const shortfall = await walletShortfallMessage(userId, price);
    if (shortfall) {
      return res.status(400).json({ success: false, message: shortfall });
    }

    // Debit FIRST so an order can never be delivered without charging the
    // user. Refunded automatically if the provider rejects the order below.
    const newBalance = await debitWallet(userId, price);
    if (newBalance === null) {
      return res.status(400).json({ success: false, message: "Could not debit your wallet. Please try again." });
    }
    // Stash the debit on the request so the catch block (which cannot see
    // try-block consts) can refund the exact amount if the provider rejects it.
    req._debit = { userId: userId, price: price };
    const txRef = newTxRef(fulfillProvider === "alrahuz" ? "ALR" : "BIGI");

    let response;
    if (fulfillProvider === "alrahuz") {
      response = await alrahuzService.buyData({
        network: network,
        mobile_number: String(phone_number).trim(),
        plan: Number(providerPlanId),
      });
    } else {
      response = await bigiClient.post("/api/v2/vtu/data/purchase/", {
        network: getNetworkId(network),
        plan: Number(providerPlanId),
        phone_number: String(phone_number).trim(),
        pin: DEFAULT_PIN
      }).then(r => r.data);
    }
    console.log(`📦 DATA raw response (${fulfillProvider}):`, JSON.stringify(response));

    // Never report success unless the provider actually fulfilled the order.
    if (bigiFailed(response)) {
      // Order was not fulfilled — refund the debit and log the failure.
      await creditWallet(userId, price);
      await logTx({
        user_id: userId,
        title: (planRow?.volume ? planRow.volume + " Data" : "Data Purchase") + " — Failed",
        service_type: "data",
        amount: price,
        recipient: String(phone_number).trim(),
        status: "failed",
        reference: txRef,
        provider: fulfillProvider
      });
      return res.status(400).json({
        success: false,
        message: bigiErrorMessage(response, fulfillProvider === "alrahuz"
          ? "Alrahuzdata rejected this purchase"
          : "Bigisub rejected this purchase")
      });
    }

    await logTx({
      user_id: userId,
      title: (planRow?.volume ? planRow.volume + " Data" : "Data Purchase") + " — " + String(phone_number).trim(),
      service_type: "data",
      amount: price,
      recipient: String(phone_number).trim(),
      status: "successful",
      reference: txRef,
      provider: fulfillProvider
    });

    console.log("✅ Data purchase (" + fulfillProvider + "): user " + userId + " plan " + providerPlanId + " -₦" + price + " (balance ₦" + newBalance + ")");
    return res.json({
      success: true,
      message: "Data purchase successful",
      provider: fulfillProvider,
      reference: txRef,
      data: response,
      balance: newBalance
    });
  } catch (err) {
    const provError = err.response?.data;
    const ctx = req._debit || null;
    const provStatus = err.response?.status || 0;
    if (provStatus >= 400 && provStatus < 500) {
      // Request was NOT placed — refund the debit and log the failure.
      if (ctx) {
        await creditWallet(ctx.userId, ctx.price);
        await logTx({
          user_id: ctx.userId,
          title: "Data Purchase — Rejected",
          service_type: "data",
          amount: ctx.price,
          recipient: "",
          status: "failed",
          reference: newTxRef("FAIL"),
          provider: null
        });
      }
      console.error("❌ Data rejected by provider:", JSON.stringify(provError || err.message, null, 2));
      return res.status(provStatus).json({
        success: false,
        message: bigiErrorMessage(provError, err.message),
        errors: provError?.errors || null
      });
    }
    // 5xx / timeout / connection error — order may still have been processed.
    console.error("⚠️ Data outcome uncertain:", JSON.stringify(provError || err.message, null, 2));
    return res.json({
      success: true,
      message: "Data request submitted — delivery may take a few minutes. If you don't receive it, contact support for a refund."
    });
  }
});

app.get("/api/v2/vtu/cable/plans", async (req, res) => {
  try {
    const cableName = getCableCode(req.query.cable_name || req.query.provider || "gotv");
    const response = await bigiClient.get("/api/v2/vtu/cable/plans/?cable_name=" + cableName);
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
    const userId = await requestUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, message: "Authentication required" });
    }

    const price = Number(amount) || 0;
    if (price <= 0) {
      return res.status(400).json({ success: false, message: "Invalid amount" });
    }

    const shortfall = await walletShortfallMessage(userId, price);
    if (shortfall) {
      return res.status(400).json({ success: false, message: shortfall });
    }

    // Debit FIRST so an order can never be delivered without charging the
    // user. Refunded automatically if Bigisub rejects the order below.
    const newBalance = await debitWallet(userId, price);
    if (newBalance === null) {
      return res.status(400).json({ success: false, message: "Could not debit your wallet. Please try again." });
    }
    // Stash the debit on the request so the catch block (which cannot see
    // try-block consts) can refund the exact amount if Bigisub rejects it.
    req._debit = { userId: userId, price: price };
    const txRef = newTxRef("CBL");

    const response = await bigiClient.post("/api/v2/vtu/cable/purchase/", {
      cable_type: getCableCode(cable_type || provider),
      card_no: String(card_no).trim(),
      phone_number: String(phone_number).trim(),
      amount: price,
      Customer: String(Customer || customerName).trim(),
      pin: DEFAULT_PIN
    });
    console.log("📦 CABLE raw response:", JSON.stringify(response.data));

    if (bigiFailed(response.data)) {
      // Order was not fulfilled — refund the debit and log the failure.
      await creditWallet(userId, price);
      await logTx({
        user_id: userId,
        title: "Cable TV — Failed",
        service_type: "cable",
        amount: price,
        recipient: String(card_no).trim(),
        status: "failed",
        reference: txRef,
        provider: "bigisub"
      });
      return res.status(400).json({
        success: false,
        message: bigiErrorMessage(response.data, "Bigisub rejected this purchase")
      });
    }


    await logTx({
      user_id: userId,
      title: "Cable TV — " + getCableCode(cable_type || provider),
      service_type: "cable",
      amount: price,
      recipient: String(card_no).trim(),
      status: "successful",
      reference: txRef,
      provider: "bigisub"
    });
    console.log("✅ Cable: user " + userId + " -₦" + price + " (balance ₦" + newBalance + ")");
    res.json({ success: true, message: "Cable subscription successful", data: response.data, balance: newBalance });
  } catch (err) {
    // try-block consts are invisible to catch, so the debit context comes
    // from the request (stashed right after the debit succeeded).
    const ctx = req._debit || null;
    const bigiStatus = err.response?.status || 0;
    if (bigiStatus >= 400 && bigiStatus < 500) {
      // Bigisub rejected the request outright (bad amount, bad phone, auth…)
      // — the order was NOT placed. Refund the debit so the user is never
      // charged for an order that didn't happen.
      if (ctx) {
        await creditWallet(ctx.userId, ctx.price);
      }
      console.error("❌ Order rejected by Bigisub:", err.response?.data || err.message);
      return res.status(400).json({ success: false, message: bigiErrorMessage(err.response?.data, err.message) });
    }
    // 5xx / timeout / connection error: Bigisub may STILL have processed the
    // order (it has delivered airtime while returning "An error occurred…").
    // We already debited, so keep the charge and let the user verify delivery
    // — refunding blindly would hand out free airtime.
    console.error("⚠️ Order outcome uncertain:", err.response?.data || err.message);
    return res.json({
      success: true,
      message: "Request submitted — delivery may take a few minutes. If you don't receive it, contact support for a refund."
    });
  }
});

app.get("/api/v2/vtu/recharge-pin/plans", async (req, res) => {
  try {
    const netId = getNetworkId(req.query.network);
    const response = await bigiClient.get("/api/v2/vtu/recharge-pin/plans/?network=" + netId);
    const plans = response.data?.data || (Array.isArray(response.data) ? response.data : []);
    res.json({ success: true, data: plans });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message, data: [] });
  }
});

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

app.get("/api/v2/bills/result-checker/prices", async (_req, res) => {
  try {
    const response = await bigiClient.get("/api/v2/bills/result-checker/prices/");
    const prices = response.data?.data?.prices || response.data?.data || [];
    res.json({ success: true, data: prices });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message, data: [] });
  }
});

app.post("/api/v2/bills/electricity/pay", async (req, res) => {
  try {
    const { company, meter_no, meter_type, phone_number, amount, Customer_name, customerName } = req.body;
    const userId = await requestUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, message: "Authentication required" });
    }

    const price = Number(amount) || 0;
    if (price <= 0) {
      return res.status(400).json({ success: false, message: "Invalid amount" });
    }

    const shortfall = await walletShortfallMessage(userId, price);
    if (shortfall) {
      return res.status(400).json({ success: false, message: shortfall });
    }

    // Debit FIRST so an order can never be delivered without charging the
    // user. Refunded automatically if Bigisub rejects the order below.
    const newBalance = await debitWallet(userId, price);
    if (newBalance === null) {
      return res.status(400).json({ success: false, message: "Could not debit your wallet. Please try again." });
    }
    // Stash the debit on the request so the catch block (which cannot see
    // try-block consts) can refund the exact amount if Bigisub rejects it.
    req._debit = { userId: userId, price: price };
    const txRef = newTxRef("ELEC");

    const response = await bigiClient.post("/api/v2/bills/electricity/pay/", {
      company: String(company).trim(),
      meter_no: String(meter_no).trim(),
      meter_type: String(meter_type || "prepaid").trim(),
      phone_number: String(phone_number).trim(),
      amount: price,
      Customer_name: String(Customer_name || customerName || "").trim(),
      pin: DEFAULT_PIN
    });
    console.log("📦 ELECTRICITY raw response:", JSON.stringify(response.data));

    if (bigiFailed(response.data)) {
      // Order was not fulfilled — refund the debit and log the failure.
      await creditWallet(userId, price);
      await logTx({
        user_id: userId,
        title: "Electricity — Failed",
        service_type: "electricity",
        amount: price,
        recipient: String(meter_no).trim(),
        status: "failed",
        reference: txRef,
        provider: "bigisub"
      });
      return res.status(400).json({
        success: false,
        message: bigiErrorMessage(response.data, "Bigisub rejected this payment")
      });
    }


    await logTx({
      user_id: userId,
      title: "Electricity — " + String(company).trim(),
      service_type: "electricity",
      amount: price,
      recipient: String(meter_no).trim(),
      status: "successful",
      reference: txRef,
      provider: "bigisub"
    });
    console.log("✅ Electricity: user " + userId + " -₦" + price + " (balance ₦" + newBalance + ")");
    // The Android app shows the recharge token on the receipt — surface Bigisub's
    // token (whatever shape it arrives in) so the payment screen can display it.
    const token = response.data?.data?.token || response.data?.token || null;
    res.json({ success: true, message: "Electricity bill paid", data: response.data, token: token, balance: newBalance });
  } catch (err) {
    // try-block consts are invisible to catch, so the debit context comes
    // from the request (stashed right after the debit succeeded).
    const ctx = req._debit || null;
    const bigiStatus = err.response?.status || 0;
    if (bigiStatus >= 400 && bigiStatus < 500) {
      // Bigisub rejected the request outright (bad amount, bad phone, auth…)
      // — the order was NOT placed. Refund the debit so the user is never
      // charged for an order that didn't happen.
      if (ctx) {
        await creditWallet(ctx.userId, ctx.price);
      }
      console.error("❌ Order rejected by Bigisub:", err.response?.data || err.message);
      return res.status(400).json({ success: false, message: bigiErrorMessage(err.response?.data, err.message) });
    }
    // 5xx / timeout / connection error: Bigisub may STILL have processed the
    // order (it has delivered airtime while returning "An error occurred…").
    // We already debited, so keep the charge and let the user verify delivery
    // — refunding blindly would hand out free airtime.
    console.error("⚠️ Order outcome uncertain:", err.response?.data || err.message);
    return res.json({
      success: true,
      message: "Request submitted — delivery may take a few minutes. If you don't receive it, contact support for a refund."
    });
  }
});

app.post("/api/v2/vtu/recharge-pin/purchase", async (req, res) => {
  try {
    const { network, plan, quantity, card_name, name_on_card } = req.body;
    const userId = await requestUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, message: "Authentication required" });
    }

    const numericPlanId = Number(plan);
    const qty = Number(quantity) || 1;
    if (!plan || isNaN(numericPlanId)) {
      return res.status(400).json({ success: false, message: "Invalid or missing plan ID" });
    }

    // Resolve the unit price from Bigisub's own plan catalog, then charge qty x price.
    const netId = getNetworkId(network);
    const plansRes = await bigiClient.get("/api/v2/vtu/recharge-pin/plans/?network=" + netId);
    const plans = plansRes.data?.data || (Array.isArray(plansRes.data) ? plansRes.data : []);
    const planInfo = plans.find(p => Number(p.id) === numericPlanId);
    const unitPrice = Number(planInfo?.regular_price || planInfo?.corporate_price || 0);
    const price = unitPrice * qty;
    if (price <= 0) {
      return res.status(400).json({ success: false, message: "Could not determine plan price" });
    }

    const shortfall = await walletShortfallMessage(userId, price);
    if (shortfall) {
      return res.status(400).json({ success: false, message: shortfall });
    }

    // Debit FIRST so an order can never be delivered without charging the
    // user. Refunded automatically if Bigisub rejects the order below.
    const newBalance = await debitWallet(userId, price);
    if (newBalance === null) {
      return res.status(400).json({ success: false, message: "Could not debit your wallet. Please try again." });
    }
    // Stash the debit on the request so the catch block (which cannot see
    // try-block consts) can refund the exact amount if Bigisub rejects it.
    req._debit = { userId: userId, price: price };
    const txRef = newTxRef("PIN");

    const response = await bigiClient.post("/api/v2/vtu/recharge-pin/purchase/", {
      network: netId,
      plan: numericPlanId,
      quantity: qty,
      card_name: String(card_name || "").trim(),
      name_on_card: String(name_on_card || "").trim(),
      pin: DEFAULT_PIN
    });
    console.log("📦 RECHARGE PIN raw response:", JSON.stringify(response.data));

    if (bigiFailed(response.data)) {
      // Order was not fulfilled — refund the debit and log the failure.
      await creditWallet(userId, price);
      await logTx({
        user_id: userId,
        title: "Recharge PINs — Failed",
        service_type: "recharge_pin",
        amount: price,
        recipient: String(network || "").trim(),
        status: "failed",
        reference: txRef,
        provider: "bigisub"
      });
      return res.status(400).json({
        success: false,
        message: bigiErrorMessage(response.data, "Bigisub rejected this purchase")
      });
    }


    await logTx({
      user_id: userId,
      title: "Recharge PINs x" + qty,
      service_type: "recharge_pin",
      amount: price,
      recipient: String(network || "").trim(),
      status: "successful",
      reference: txRef,
      provider: "bigisub"
    });
    console.log("✅ Recharge PIN: user " + userId + " -₦" + price + " (balance ₦" + newBalance + ")");
    res.json({ success: true, message: "Recharge PINs generated", data: response.data, balance: newBalance });
  } catch (err) {
    // try-block consts are invisible to catch, so the debit context comes
    // from the request (stashed right after the debit succeeded).
    const ctx = req._debit || null;
    const bigiStatus = err.response?.status || 0;
    if (bigiStatus >= 400 && bigiStatus < 500) {
      // Bigisub rejected the request outright (bad amount, bad phone, auth…)
      // — the order was NOT placed. Refund the debit so the user is never
      // charged for an order that didn't happen.
      if (ctx) {
        await creditWallet(ctx.userId, ctx.price);
      }
      console.error("❌ Order rejected by Bigisub:", err.response?.data || err.message);
      return res.status(400).json({ success: false, message: bigiErrorMessage(err.response?.data, err.message) });
    }
    // 5xx / timeout / connection error: Bigisub may STILL have processed the
    // order (it has delivered airtime while returning "An error occurred…").
    // We already debited, so keep the charge and let the user verify delivery
    // — refunding blindly would hand out free airtime.
    console.error("⚠️ Order outcome uncertain:", err.response?.data || err.message);
    return res.json({
      success: true,
      message: "Request submitted — delivery may take a few minutes. If you don't receive it, contact support for a refund."
    });
  }
});

app.post("/api/v2/bills/result-checker/purchase", async (req, res) => {
  try {
    const { exam, quantity, pin_code } = req.body;
    const userId = await requestUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, message: "Authentication required" });
    }

    const qty = Number(quantity) || 1;
    if (!exam) {
      return res.status(400).json({ success: false, message: "Exam type is required" });
    }

    // Resolve the unit price from Bigisub's price list, then charge qty x price.
    const pricesRes = await bigiClient.get("/api/v2/bills/result-checker/prices/");
    const prices = pricesRes.data?.data?.prices || pricesRes.data?.data || [];
    const examInfo = prices.find(p => String(p.code || p.exam || "").toLowerCase() === String(exam).toLowerCase());
    const unitPrice = Number(examInfo?.amount || examInfo?.plan_amount || 0);
    const price = unitPrice * qty;
    if (price <= 0) {
      return res.status(400).json({ success: false, message: "Could not determine exam price" });
    }

    const shortfall = await walletShortfallMessage(userId, price);
    if (shortfall) {
      return res.status(400).json({ success: false, message: shortfall });
    }

    // Debit FIRST so an order can never be delivered without charging the
    // user. Refunded automatically if Bigisub rejects the order below.
    const newBalance = await debitWallet(userId, price);
    if (newBalance === null) {
      return res.status(400).json({ success: false, message: "Could not debit your wallet. Please try again." });
    }
    // Stash the debit on the request so the catch block (which cannot see
    // try-block consts) can refund the exact amount if Bigisub rejects it.
    req._debit = { userId: userId, price: price };
    const txRef = newTxRef("EPIN");

    const response = await bigiClient.post("/api/v2/bills/result-checker/purchase/", {
      exam: String(exam).trim(),
      quantity: qty,
      pin_code: String(pin_code || DEFAULT_PIN).trim()
    });
    console.log("📦 EXAM PIN raw response:", JSON.stringify(response.data));

    if (bigiFailed(response.data)) {
      // Order was not fulfilled — refund the debit and log the failure.
      await creditWallet(userId, price);
      await logTx({
        user_id: userId,
        title: "Exam PIN — Failed",
        service_type: "exam_pin",
        amount: price,
        recipient: String(exam).trim(),
        status: "failed",
        reference: txRef,
        provider: "bigisub"
      });
      return res.status(400).json({
        success: false,
        message: bigiErrorMessage(response.data, "Bigisub rejected this purchase")
      });
    }


    await logTx({
      user_id: userId,
      title: "Exam PIN (" + String(exam).trim() + ") x" + qty,
      service_type: "exam_pin",
      amount: price,
      recipient: String(exam).trim(),
      status: "successful",
      reference: txRef,
      provider: "bigisub"
    });
    console.log("✅ Exam PIN: user " + userId + " -₦" + price + " (balance ₦" + newBalance + ")");
    // The Android app shows the purchased PINs in a dialog — extract them from
    // whatever shape Bigisub returns (wrapped in data, or a bare array).
    const rawData = response.data?.data;
    const pins =
      response.data?.pins ||
      rawData?.pins ||
      (Array.isArray(rawData) ? rawData : []);
    res.json({ success: true, message: "Exam PINs generated", data: response.data, pins: pins, balance: newBalance });
  } catch (err) {
    // try-block consts are invisible to catch, so the debit context comes
    // from the request (stashed right after the debit succeeded).
    const ctx = req._debit || null;
    const bigiStatus = err.response?.status || 0;
    if (bigiStatus >= 400 && bigiStatus < 500) {
      // Bigisub rejected the request outright (bad amount, bad phone, auth…)
      // — the order was NOT placed. Refund the debit so the user is never
      // charged for an order that didn't happen.
      if (ctx) {
        await creditWallet(ctx.userId, ctx.price);
      }
      console.error("❌ Order rejected by Bigisub:", err.response?.data || err.message);
      return res.status(400).json({ success: false, message: bigiErrorMessage(err.response?.data, err.message) });
    }
    // 5xx / timeout / connection error: Bigisub may STILL have processed the
    // order (it has delivered airtime while returning "An error occurred…").
    // We already debited, so keep the charge and let the user verify delivery
    // — refunding blindly would hand out free airtime.
    console.error("⚠️ Order outcome uncertain:", err.response?.data || err.message);
    return res.json({
      success: true,
      message: "Request submitted — delivery may take a few minutes. If you don't receive it, contact support for a refund."
    });
  }
});

// -------------------------------------------------------------
// 5. ADMIN ENDPOINTS (require is_admin profile)
// -------------------------------------------------------------

async function requireAdmin(req, res, next) {
  try {
    const token = (req.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
    if (!token) return res.status(401).json({ success: false, message: "No token provided" });

    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) {
      return res.status(401).json({ success: false, message: "Invalid or expired token" });
    }

    const { data: profile } = await supabase
      .from("profiles")
      .select("is_admin, role")
      .eq("id", data.user.id)
      .maybeSingle();

    if (!profile || (profile.is_admin !== true && profile.role !== "admin")) {
      return res.status(403).json({ success: false, message: "Admin access required" });
    }

    req.adminUser = data.user;
    next();
  } catch (err) {
    console.error("❌ Admin auth error:", err.message);
    res.status(500).json({ success: false, message: "Authentication failed" });
  }
}

// GET /api/v2/admin/stats — dashboard summary with dual-provider balances + routes
app.get("/api/v2/admin/stats", requireAdmin, async (_req, res) => {
  try {
    // Fetch both provider balances in parallel — a provider failing must
    // never take down the whole dashboard.
    let bigisubBalance = 0;
    let alrahuzBalance = 0;
    const [bigiResult, alrahuzResult] = await Promise.allSettled([
      (async () => {
        // Correct route per Bigisub docs: /api/v2/financial/wallet/balance/
        // (older builds used /api/v2/balance/ — kept as fallbacks)
        try {
          const r = await bigiClient.get("/api/v2/financial/wallet/balance/");
          return Number(r.data?.data?.balance ?? r.data?.balance ?? 0);
        } catch {
          try {
            const r = await bigiClient.get("/api/v2/balance/");
            return Number(r.data?.balance ?? r.data?.data?.balance ?? 0);
          } catch {
            const r = await bigiClient.get("/api/balance/");
            const raw = r.data?.balance ?? r.data?.data?.balance ?? (typeof r.data === "number" ? r.data : 0);
            return Number(raw) || 0;
          }
        }
      })(),
      (async () => {
        try {
          const alr = require("./services/alrahuz");
          return await alr.getBalance();
        } catch (e) { return 0; }
      })()
    ]);
    if (bigiResult.status === "fulfilled") bigisubBalance = bigiResult.value;
    if (alrahuzResult.status === "fulfilled") alrahuzBalance = alrahuzResult.value;

    // Fetch active provider routes
    let activeRoutes = { airtime: "bigisub", data: "bigisub", cable: "bigisub", electricity: "bigisub", epin: "bigisub" };
    try {
      const { data: routes } = await supabase.from("provider_routing").select("service, provider");
      if (routes) routes.forEach(r => { activeRoutes[r.service] = r.provider; });
    } catch (e) {
      console.warn("⚠️ Could not fetch provider_routing (table may not exist yet):", e.message);
    }

    const [usersRes, walletRes, txRes] = await Promise.all([
      supabase.from("profiles").select("id", { count: "exact", head: true }),
      supabase.from("wallets").select("balance"),
      supabase.from("transactions").select("id", { count: "exact", head: true })
    ]);

    const totalUsers = usersRes.count || 0;
    const totalTransactions = txRes.count || 0;
    const totalLiability = (walletRes.data || []).reduce((sum, w) => sum + Number(w.balance || 0), 0);

    res.json({
      success: true,
      data: {
        // RAW NUMBERS — the dashboard formats them. Pre-formatted strings
        // like "1,234.00" become NaN when the UI runs Number() on them.
        balances: {
          bigisub: Number(bigisubBalance.toFixed(2)),
          alrahuz: Number(alrahuzBalance.toFixed(2))
        },
        active_routes: activeRoutes,
        total_registered_users: totalUsers,
        total_transactions: totalTransactions,
        total_wallet_liability: Number(totalLiability.toFixed(2))
      }
    });
  } catch (err) {
    console.error("❌ Admin stats error:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/v2/admin/providers — current routing state
app.get("/api/v2/admin/providers", requireAdmin, async (_req, res) => {
  try {
    let routes = { airtime: "bigisub", data: "bigisub", cable: "bigisub", electricity: "bigisub", epin: "bigisub" };
    try {
      const { data } = await supabase.from("provider_routing").select("service, provider");
      if (data) data.forEach(r => { routes[r.service] = r.provider; });
    } catch (e) {
      // Table may not exist yet
    }
    res.json({ success: true, data: routes });
  } catch (err) {
    console.error("❌ Admin providers error:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/v2/admin/providers/route — switch provider(s)
app.post("/api/v2/admin/providers/route", requireAdmin, async (req, res) => {
  try {
    const { global_provider, service, provider } = req.body;
    const validProviders = ["bigisub", "alrahuz"];
    const validServices = ["airtime", "data", "cable", "electricity", "epin"];

    // Global switch: update all services at once
    if (global_provider) {
      if (!validProviders.includes(global_provider)) {
        return res.status(400).json({ success: false, message: "Invalid provider. Use 'bigisub' or 'alrahuz'." });
      }
      try {
        for (const svc of validServices) {
          await supabase
            .from("provider_routing")
            .upsert({ service: svc, provider: global_provider, updated_at: new Date().toISOString() }, { onConflict: "service" });
        }
      } catch (e) {
        // Table may not exist — seed via raw inserts
        for (const svc of validServices) {
          await supabase.from("provider_routing").delete().eq("service", svc).catch(() => {});
          await supabase.from("provider_routing").insert({ service: svc, provider: global_provider }).catch(() => {});
        }
      }
      console.log(`✅ Global provider switch: all services → ${global_provider} (by ${req.adminUser.email})`);
      return res.json({ success: true, message: `All services switched to ${global_provider}` });
    }

    // Per-service switch
    if (service && provider) {
      if (!validServices.includes(service)) {
        return res.status(400).json({ success: false, message: `Invalid service. Use one of: ${validServices.join(", ")}` });
      }
      if (!validProviders.includes(provider)) {
        return res.status(400).json({ success: false, message: "Invalid provider. Use 'bigisub' or 'alrahuz'." });
      }
      try {
        await supabase
          .from("provider_routing")
          .upsert({ service, provider, updated_at: new Date().toISOString() }, { onConflict: "service" });
      } catch (e) {
        await supabase.from("provider_routing").delete().eq("service", service).catch(() => {});
        await supabase.from("provider_routing").insert({ service, provider }).catch(() => {});
      }
      console.log(`✅ Provider route: ${service} → ${provider} (by ${req.adminUser.email})`);
      return res.json({ success: true, message: `${service} switched to ${provider}` });
    }

    return res.status(400).json({ success: false, message: "Provide either global_provider or (service + provider)" });
  } catch (err) {
    console.error("❌ Admin provider route error:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/v2/admin/users — paginated user list with optional search
app.get("/api/v2/admin/users", requireAdmin, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const search = (req.query.search || "").trim();
    const offset = (page - 1) * limit;

    let query = supabase
      .from("profiles")
      .select("id, full_name, email, phone_number, is_admin, role, created_at", { count: "exact" })
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (search) {
      query = query.or(`full_name.ilike.%${search}%,email.ilike.%${search}%,phone_number.ilike.%${search}%`);
    }

    const { data: users, count, error } = await query;
    if (error) throw error;

    // Fetch wallet balances for this page of users
    const userIds = (users || []).map(u => u.id);
    let wallets = [];
    if (userIds.length) {
      const { data: w } = await supabase.from("wallets").select("user_id, balance").in("user_id", userIds);
      wallets = w || [];
    }
    const walletMap = {};
    wallets.forEach(w => { walletMap[w.user_id] = Number(w.balance || 0); });

    const enriched = (users || []).map(u => ({
      ...u,
      wallet_balance: walletMap[u.id] || 0
    }));

    res.json({
      success: true,
      data: enriched,
      pagination: { page, limit, total: count || 0, totalPages: Math.ceil((count || 0) / limit) }
    });
  } catch (err) {
    console.error("❌ Admin users error:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/v2/admin/wallet/adjust — credit or debit a user's wallet
app.post("/api/v2/admin/wallet/adjust", requireAdmin, async (req, res) => {
  try {
    const { target_user_id, amount, action, reason } = req.body;

    if (!target_user_id) return res.status(400).json({ success: false, message: "target_user_id is required" });
    if (!amount || Number(amount) <= 0) return res.status(400).json({ success: false, message: "amount must be a positive number" });
    if (!["credit", "debit"].includes(action)) return res.status(400).json({ success: false, message: "action must be 'credit' or 'debit'" });
    if (!reason || !reason.trim()) return res.status(400).json({ success: false, message: "reason is required for wallet adjustments" });

    const amt = Number(amount);

    const rpcName = action === "credit" ? "credit_wallet" : "debit_wallet";
    const { data: newBalance, error } = await supabase.rpc(rpcName, {
      p_user_id: target_user_id,
      p_amount: amt,
      p_description: `Admin ${action}: ${reason.trim()} (by ${req.adminUser.email})`
    });

    if (error || newBalance === null || newBalance === undefined) {
      return res.status(400).json({ success: false, message: error?.message || "Wallet adjustment failed" });
    }

    // Audit trail
    try {
      await supabase.from("transactions").insert({
        user_id: target_user_id,
        title: `Admin ${action === "credit" ? "Credit" : "Debit"}`,
        service_type: "admin_adjust",
        amount: amt,
        recipient: req.adminUser.email,
        status: "successful",
        reference: `ADMIN-${Date.now()}`
      });
    } catch (txErr) {
      console.warn("⚠️ Admin adjust audit insert failed:", txErr.message);
    }

    console.log(`✅ Admin ${action}: ${target_user_id} ${action === "credit" ? "+" : "-"}₦${amt} by ${req.adminUser.email} (${reason})`);
    res.json({ success: true, message: `Wallet ${action}ed successfully`, new_balance: newBalance });
  } catch (err) {
    console.error("❌ Admin wallet adjust error:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/v2/admin/transactions — paginated transaction ledger
app.get("/api/v2/admin/transactions", requireAdmin, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 25));
    const offset = (page - 1) * limit;
    const statusFilter = (req.query.status || "").trim();
    const typeFilter = (req.query.service_type || "").trim();

    // NOTE: no PostgREST embed here — the transactions table has NO foreign
    // key on user_id, so `profiles:user_id(...)` fails with "Could not find a
    // relationship between 'transactions' and 'user_id'". Profiles are joined
    // manually below instead.
    let query = supabase
      .from("transactions")
      .select("*", { count: "exact" })
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (statusFilter) query = query.eq("status", statusFilter);
    if (typeFilter) query = query.eq("service_type", typeFilter);

    const { data: txns, count, error } = await query;
    if (error) throw error;

    // Manual join: attach { profiles: { full_name, email } } so the admin UI
    // keeps working unchanged.
    const userIds = [...new Set((txns || []).map(t => t.user_id).filter(Boolean))];
    const profileMap = {};
    if (userIds.length) {
      const { data: profs } = await supabase
        .from("profiles")
        .select("id, full_name, email")
        .in("id", userIds);
      (profs || []).forEach(p => { profileMap[p.id] = p; });
    }

    const enriched = (txns || []).map(t => ({
      ...t,
      profiles: profileMap[t.user_id] || null
    }));

    res.json({
      success: true,
      data: enriched,
      pagination: { page, limit, total: count || 0, totalPages: Math.ceil((count || 0) / limit) }
    });
  } catch (err) {
    console.error("❌ Admin transactions error:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/v2/admin/transactions/refund — refund a transaction
app.post("/api/v2/admin/transactions/refund", requireAdmin, async (req, res) => {
  try {
    const { transaction_id, reason } = req.body;

    if (!transaction_id) return res.status(400).json({ success: false, message: "transaction_id is required" });
    if (!reason || !reason.trim()) return res.status(400).json({ success: false, message: "reason is required for refunds" });

    // Fetch the transaction
    const { data: tx, error: txErr } = await supabase
      .from("transactions")
      .select("*")
      .eq("id", transaction_id)
      .maybeSingle();
    if (txErr || !tx) return res.status(404).json({ success: false, message: "Transaction not found" });
    if (tx.status === "refunded") return res.status(400).json({ success: false, message: "Transaction already refunded" });

    const refundAmount = Number(tx.amount);
    if (!refundAmount || refundAmount <= 0) {
      return res.status(400).json({ success: false, message: "Invalid transaction amount" });
    }

    // Credit the user's wallet
    const { data: newBalance, error: creditErr } = await supabase.rpc("credit_wallet", {
      p_user_id: tx.user_id,
      p_amount: refundAmount,
      p_description: `Refund: ${reason.trim()} (by ${req.adminUser.email})`
    });
    if (creditErr || newBalance === null || newBalance === undefined) {
      return res.status(500).json({ success: false, message: creditErr?.message || "Failed to credit wallet" });
    }

    // Mark the original transaction as refunded
    await supabase.from("transactions").update({ status: "refunded" }).eq("id", transaction_id);

    // Insert refund audit row
    try {
      await supabase.from("transactions").insert({
        user_id: tx.user_id,
        title: `Refund: ${tx.title}`,
        service_type: "refund",
        amount: refundAmount,
        recipient: req.adminUser.email,
        status: "successful",
        reference: `REFUND-${Date.now()}`
      });
    } catch (insErr) {
      console.warn("⚠️ Refund audit insert failed:", insErr.message);
    }

    console.log(`✅ Refund: user ${tx.user_id} +₦${refundAmount} for tx ${transaction_id} by ${req.adminUser.email}`);
    res.json({ success: true, message: "Refund processed successfully", new_balance: newBalance });
  } catch (err) {
    console.error("❌ Admin refund error:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/v2/admin/plans/update-price — update retail price and active status for a data plan
app.post("/api/v2/admin/plans/update-price", requireAdmin, async (req, res) => {
  try {
    const { plan_id, retail_price, is_active, alrahuz_retail_price } = req.body;

    if (!plan_id) return res.status(400).json({ success: false, message: "plan_id is required" });

    const updates = {};
    if (retail_price !== undefined && retail_price !== null) {
      updates.retail_price = Number(retail_price);
    }
    // Per-provider selling price override for Alrahuz (null clears it)
    if (alrahuz_retail_price !== undefined) {
      updates.alrahuz_retail_price = alrahuz_retail_price === null ? null : Number(alrahuz_retail_price);
    }
    if (is_active !== undefined) {
      updates.is_active = Boolean(is_active);
    }
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ success: false, message: "No fields to update" });
    }
    updates.updated_at = new Date().toISOString();

    const { data, error } = await supabase
      .from("data_plans")
      .update(updates)
      .eq("id", plan_id)
      .select()
      .maybeSingle();

    if (error) throw error;
    if (!data) return res.status(404).json({ success: false, message: "Plan not found" });

    console.log(`✅ Plan ${plan_id} updated by ${req.adminUser.email}:`, updates);
    res.json({ success: true, message: "Plan updated successfully", data });
  } catch (err) {
    console.error("❌ Admin plan update error:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// -------------------------------------------------------------
// 6. ADMIN DASHBOARD STATIC HOSTING (/admin)
// Serves the built Vite app (admin-dashboard/dist) from this same
// service, so the dashboard is live at /admin on Render with no
// separate hosting. API routes above take precedence.
// -------------------------------------------------------------
const path = require("path");
const adminDist = path.join(__dirname, "admin-dashboard", "dist");
if (require("fs").existsSync(adminDist)) {
  app.use("/admin", express.static(adminDist, { index: "index.html" }));
  // SPA fallback: client-side routes like /admin/plans render index.html
  app.get("/admin/*", (_req, res) => {
    res.sendFile(path.join(adminDist, "index.html"));
  });
  console.log("🖥️ Admin dashboard served at /admin");
}

// -------------------------------------------------------------
// 7. DUAL KEEP-WARM HEALTH ENDPOINT
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

// KEEP-WARM: pings our own /health every 10 minutes so Render's free tier
// never sleeps the service (a cold start takes 30-60s and makes the admin
// dashboard look broken). RENDER_EXTERNAL_URL is set automatically by Render;
// the hardcoded fallback covers manual deploys where it is missing.
const SELF_URL = process.env.RENDER_EXTERNAL_URL || process.env.APP_URL || "https://dreamhatcher-paystack-backend.onrender.com";
if (!process.env.DISABLE_KEEP_ALIVE) {
  const pingUrl = SELF_URL + "/health";
  console.log("♨️ Keep-warm active, pinging " + pingUrl + " every 10 min");
  // Silent by design (matches the battle-tested dreamhatcher-backend pattern):
  // a ping every 10 min must not flood the logs.
  setInterval(() => {
    https.get(pingUrl, (response) => response.resume()).on("error", () => {});
  }, 10 * 60 * 1000);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log("🚀 Dreamhatcher Production Server active on port " + PORT));
