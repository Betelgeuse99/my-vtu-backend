// ✅ ALWAYS LOAD .env FIRST
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const axios = require("axios");
const https = require("https");
const crypto = require("crypto");
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
    Authorization: "Token " + BIGISUB_TOKEN,
    "Content-Type": "application/json"
  }
});

const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));

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

    const response = await bigiClient.post("/api/v2/vtu/airtime/purchase/", {
      network: getNetworkId(network),
      phone_number: String(phone_number).trim(),
      amount: String(amount),
      airtime_type: "vtu",
      pin: DEFAULT_PIN
    });
    console.log("📦 AIRTIME raw response:", JSON.stringify(response.data));

    if (bigiFailed(response.data)) {
      // Order was not fulfilled — refund the debit.
      await creditWallet(userId, price);
      return res.status(400).json({
        success: false,
        message: bigiErrorMessage(response.data, "Bigisub rejected this purchase")
      });
    }


    console.log("✅ Airtime: user " + userId + " -₦" + price + " (balance ₦" + newBalance + ")");
    res.json({ success: true, message: "Airtime top-up successful", data: response.data, balance: newBalance });
  } catch (err) {
    console.error("❌ Airtime Error:", err.response?.data || err.message);
    res.status(400).json({ success: false, message: bigiErrorMessage(err.response?.data, err.message) });
  }
});

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
    const { network, plan, plan_id, phone_number } = req.body;
    const userId = await requestUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, message: "Authentication required" });
    }

    const targetPlan = plan || plan_id;
    const numericPlanId = Number(targetPlan);
    if (!targetPlan || isNaN(numericPlanId)) {
      return res.status(400).json({ success: false, message: "Invalid or missing plan ID" });
    }

    // Server-authoritative price: look the plan up in the synced catalog first,
    // fall back to the client-sent amount only if the plan is unknown.
    let price = Number(req.body.amount) || 0;
    const { data: planRow } = await supabase
      .from("data_plans")
      .select("retail_price")
      .eq("bigi_plan_id", numericPlanId)
      .maybeSingle();
    if (planRow && Number(planRow.retail_price) > 0) {
      price = Number(planRow.retail_price);
    }
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

    const payload = {
      network: getNetworkId(network),
      plan: numericPlanId,
      phone_number: String(phone_number).trim(),
      pin: DEFAULT_PIN
    };

    const response = await bigiClient.post("/api/v2/vtu/data/purchase/", payload);
    console.log("📦 DATA raw response:", JSON.stringify(response.data));

    // Never report success unless Bigisub actually fulfilled the order.
    if (bigiFailed(response.data)) {
      // Order was not fulfilled — refund the debit.
      await creditWallet(userId, price);
      return res.status(400).json({
        success: false,
        message: bigiErrorMessage(response.data, "Bigisub rejected this purchase")
      });
    }


    console.log("✅ Data purchase: user " + userId + " plan " + numericPlanId + " -₦" + price + " (balance ₦" + newBalance + ")");
    return res.json({
      success: true,
      message: "Data purchase successful",
      data: response.data,
      balance: newBalance
    });
  } catch (err) {
    const bigiError = err.response?.data;
    console.error("❌ BigiSub API Error:", JSON.stringify(bigiError || err.message, null, 2));
    return res.status(err.response?.status || 400).json({
      success: false,
      message: bigiErrorMessage(bigiError, err.message),
      errors: bigiError?.errors || null
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
      // Order was not fulfilled — refund the debit.
      await creditWallet(userId, price);
      return res.status(400).json({
        success: false,
        message: bigiErrorMessage(response.data, "Bigisub rejected this purchase")
      });
    }


    console.log("✅ Cable: user " + userId + " -₦" + price + " (balance ₦" + newBalance + ")");
    res.json({ success: true, message: "Cable subscription successful", data: response.data, balance: newBalance });
  } catch (err) {
    res.status(400).json({ success: false, message: bigiErrorMessage(err.response?.data, err.message) });
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
      // Order was not fulfilled — refund the debit.
      await creditWallet(userId, price);
      return res.status(400).json({
        success: false,
        message: bigiErrorMessage(response.data, "Bigisub rejected this payment")
      });
    }


    console.log("✅ Electricity: user " + userId + " -₦" + price + " (balance ₦" + newBalance + ")");
    // The Android app shows the recharge token on the receipt — surface Bigisub's
    // token (whatever shape it arrives in) so the payment screen can display it.
    const token = response.data?.data?.token || response.data?.token || null;
    res.json({ success: true, message: "Electricity bill paid", data: response.data, token: token, balance: newBalance });
  } catch (err) {
    res.status(400).json({ success: false, message: bigiErrorMessage(err.response?.data, err.message) });
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
      // Order was not fulfilled — refund the debit.
      await creditWallet(userId, price);
      return res.status(400).json({
        success: false,
        message: bigiErrorMessage(response.data, "Bigisub rejected this purchase")
      });
    }


    console.log("✅ Recharge PIN: user " + userId + " -₦" + price + " (balance ₦" + newBalance + ")");
    res.json({ success: true, message: "Recharge PINs generated", data: response.data, balance: newBalance });
  } catch (err) {
    res.status(400).json({ success: false, message: bigiErrorMessage(err.response?.data, err.message) });
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

    const response = await bigiClient.post("/api/v2/bills/result-checker/purchase/", {
      exam: String(exam).trim(),
      quantity: qty,
      pin_code: String(pin_code || DEFAULT_PIN).trim()
    });
    console.log("📦 EXAM PIN raw response:", JSON.stringify(response.data));

    if (bigiFailed(response.data)) {
      // Order was not fulfilled — refund the debit.
      await creditWallet(userId, price);
      return res.status(400).json({
        success: false,
        message: bigiErrorMessage(response.data, "Bigisub rejected this purchase")
      });
    }


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
    res.status(400).json({ success: false, message: bigiErrorMessage(err.response?.data, err.message) });
  }
});

// -------------------------------------------------------------
// 5. DUAL KEEP-WARM HEALTH ENDPOINT
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

const SELF_URL = process.env.RENDER_EXTERNAL_URL || process.env.APP_URL;
if (SELF_URL) {
  const pingUrl = SELF_URL + "/health";
  setInterval(() => {
    https.get(pingUrl, (response) => {
      response.resume();
    }).on("error", (err) => {
      console.warn("⚠️ Keep-warm ping warning:", err.message);
    });
  }, 10 * 60 * 1000);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log("🚀 Dreamhatcher Production Server active on port " + PORT));
