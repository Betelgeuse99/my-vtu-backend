// ✅ ALWAYS LOAD .env FIRST
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const axios = require("axios");
const https = require("https");
const crypto = require("crypto");
const cron = require("node-cron");
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

// Startup check: decode the role claim of the configured service key.
// A pasted anon key here silently hides transactions/wallets behind RLS —
// this makes that failure loud at boot instead of invisible in prod.
(() => {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  let role = "missing";
  try {
    role = JSON.parse(Buffer.from(key.split(".")[1], "base64").toString()).role || "unknown";
  } catch { role = "malformed"; }
  if (role !== "service_role") {
    console.error(`🚨🚨 SUPABASE_SERVICE_ROLE_KEY has role="${role}" — expected "service_role". Transactions/wallets WILL be hidden by RLS. Fix the env var in your hosting dashboard and redeploy.`);
  } else {
    console.log("✅ SUPABASE_SERVICE_ROLE_KEY verified (role=service_role)");
  }
})();

// Dedicated client for INTERACTIVE auth (signInWithPassword / refreshSession).
// CRITICAL: supabase-js stores these sessions internally and rewrites the
// client's Authorization header — sharing one client for auth + DB queries
// makes every admin query run as the last-logged-in user, so RLS hides all
// other users' transactions/wallets until restart.
const supabaseAuth = createClient(
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

/**
 * CANONICAL TELECOM CARRIER — maps a Bigisub network id/slug to the
 * end-user carrier name ("MTN", "GLO", "AIRTEL", "9MOBILE").
 *
 * This is what MUST be stored in transactions.provider. The app and admin
 * dashboard render the carrier's logo from this column, so storing the
 * upstream gateway's brand ("bigisub" / "alrahuz") here is what made the UI
 * show vendor branding instead of the telecom logo. Keep the id keys in sync
 * with getNetworkId(): Bigisub uses 2=GLO / 3=AIRTEL (the Android registry
 * has them swapped), so both helpers must agree on that translation.
 */
function canonicalNetworkName(net) {
  // Numeric keys are the APP's network ids (TransactionManager.NETWORKS:
  // 2=AIRTEL, 3=GLO — the same translation getNetworkId applies, where app
  // id 2 is Bigisub's airtel id 3 and app id 3 is Bigisub's glo id 2).
  // Slug keys map straight to the carrier. Airtime/recharge-pin send slugs;
  // data sends the app's numeric id.
  const map = {
    "1": "MTN", "mtn": "MTN",
    "2": "AIRTEL", "airtel": "AIRTEL",
    "3": "GLO", "glo": "GLO",
    "4": "9MOBILE", "9mobile": "9MOBILE", "eti": "9MOBILE"
  };
  return map[String(net || "").toLowerCase().trim()] || null;
}

/** Canonical cable brand for the transactions.provider column (logo key). */
function cableDisplayName(provider) {
  const clean = String(provider || "").toLowerCase().trim();
  if (clean.includes("gotv")) return "GOTV";
  if (clean.includes("dstv")) return "DSTV";
  if (clean.includes("star")) return "STARTIMES";
  if (clean.includes("show")) return "SHOWMAX";
  return String(provider || "").trim().toUpperCase();
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
 * IDEMPOTENT write to the transactions ledger. The Android app reads this
 * table directly from Supabase for purchase history, and the admin dashboard
 * ledger reads it via /api/v2/admin/transactions — logging here keeps both in
 * sync with wallet movements. Failures inside logTx must never break a
 * purchase response, so everything is caught.
 *
 * Idempotency: the transactions table has a UNIQUE index on (user_id,
 * reference), so a second insert for the same purchase is a hard DB error —
 * never a silent duplicate. This method therefore:
 *   1. finds the existing row by (user_id, reference) and PATCHES
 *      status/provider/title onto it (preserves created_at, so sort order is
 *      untouched), or
 *   2. inserts only when no row exists yet, and
 *   3. if a concurrent writer (the app client, a webhook retry) wins the race
 *      and the insert trips the unique index (23505), re-resolves and patches
 *      instead of failing or duplicating.
 */
async function logTx({ user_id, title, service_type, amount, recipient, status, reference, provider }) {
  try {
    const ref = reference || null;
    if (ref) {
      const { data: existing } = await supabase
        .from("transactions")
        .select("id")
        .eq("user_id", user_id)
        .eq("reference", ref)
        .maybeSingle();
      if (existing) {
        const patch = { status: status || "successful" };
        if (provider) patch.provider = provider;
        if (title) patch.title = String(title);
        await supabase.from("transactions").update(patch).eq("id", existing.id);
        return;
      }
    }
    await supabase.from("transactions").insert({
      user_id,
      title: String(title || service_type || "Transaction"),
      service_type,
      amount: Number(amount) || 0,
      recipient: String(recipient || "").trim(),
      status: status || "successful",
      reference: ref,
      provider: provider || null,
    });
  } catch (err) {
    // Lost a race against another writer: the unique index rejected our
    // insert (code 23505 = unique_violation). Patch the winner instead.
    if (reference && err?.code === "23505") {
      try {
        const { data: existing } = await supabase
          .from("transactions")
          .select("id")
          .eq("user_id", user_id)
          .eq("reference", reference)
          .maybeSingle();
        if (existing) {
          const patch = { status: status || "successful" };
          if (provider) patch.provider = provider;
          await supabase.from("transactions").update(patch).eq("id", existing.id);
        }
      } catch (e2) {
        console.warn("⚠️ transactions idempotent-repatch failed:", e2.message);
      }
      return;
    }
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

// Detects failure signals in a provider purchase response. A provider can
// answer with an HTTP error OR with an HTTP 200/201 that still means failure
// (Bigisub nests failure inside data; Alrahuz returns HTTP 201 with
// `"Status": "failed"` — note the capital S — and an `api_response` string
// like "Invalid airtel phone number"). We must catch EVERY shape: a missed
// rejection means the user is debited, told it succeeded, and gets nothing.
// Detection is CASE-INSENSITIVE and walks nested `data`. If nothing indicates
// failure, the order is treated as placed.
const FAILURE_KEY_HINTS = ["success", "status", "error", "code", "status_code", "statuscode", "api_response", "detail", "message"];
const FAILURE_VALUE_HINTS = ["false", "0", "no", "failed", "error", "failure", "fail", "declined", "cancelled", "invalid"];
const PENDING_VALUE_HINTS = ["pending", "processing", "queued", "waiting", "in_progress", "in progress", "submitted", "running"];

function bigiFailed(node, depth = 0) {
  if (!node || depth > 3) return false;

  if (typeof node === "string") {
    return FAILURE_VALUE_HINTS.includes(node.toLowerCase());
  }
  if (typeof node !== "object" || Array.isArray(node)) return false;

  const isFailureValue = (v) => {
    if (v === false) return true;
    if (typeof v === "number") return v >= 400;
    if (typeof v === "string") return FAILURE_VALUE_HINTS.includes(v.toLowerCase());
    return false;
  };

  for (const key of Object.keys(node)) {
    const lk = key.toLowerCase();
    if (!FAILURE_KEY_HINTS.includes(lk)) continue;
    const v = node[key];
    if (lk === "error" && v) return true; // any error field present = failure
    if (isFailureValue(v)) return true;
  }

  const nested = node.data;
  if (nested && typeof nested === "object") {
    if (Array.isArray(nested)) {
      return nested.some((item) => bigiFailed(item, depth + 1));
    }
    return bigiFailed(nested, depth + 1);
  }
  return false;
}

// Detect if a Bigisub response indicates the order is still processing / pending.
// Returns true when the response is neither clearly successful nor clearly failed.
function bigiPending(node, depth = 0) {
  if (!node || depth > 3) return false;

  if (typeof node === "string") {
    return PENDING_VALUE_HINTS.includes(node.toLowerCase());
  }
  if (typeof node !== "object" || Array.isArray(node)) return false;

  const isPendingValue = (v) => {
    if (typeof v === "string") return PENDING_VALUE_HINTS.includes(v.toLowerCase());
    return false;
  };

  for (const key of Object.keys(node)) {
    const lk = key.toLowerCase();
    if (!FAILURE_KEY_HINTS.includes(lk)) continue;
    const v = node[key];
    if (isPendingValue(v)) return true;
  }

  const nested = node.data;
  if (nested && typeof nested === "object") {
    if (Array.isArray(nested)) {
      return nested.some((item) => bigiPending(item, depth + 1));
    }
    return bigiPending(nested, depth + 1);
  }
  return false;
}

function bigiErrorMessage(data, fallback) {
  return (
    data?.message ||
    data?.detail ||
    data?.api_response ||
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
    const { data, error } = await supabaseAuth.auth.refreshSession({ refresh_token: refreshToken });
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
    const { data: authData, error: authError } = await supabaseAuth.auth.signInWithPassword({ email, password });

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
    const paymentAmount = Number(payment.amount);
    if (!paymentAmount || paymentAmount <= 0) {
      return res.status(500).json({ success: false, message: "Invalid payment amount" });
    }

    // ATOMIC CLAIM: flip the payment to "success" ONLY if it is still pending.
    // This single conditional UPDATE is the idempotency guard — exactly one
    // webhook delivery (retries and concurrent deliveries included) wins the
    // claim; repeat deliveries match 0 rows and stop here. Without it, two
    // simultaneous deliveries of the same webhook would BOTH pass the read
    // above and credit the wallet twice.
    const { data: claimed, error: claimError } = await supabase
      .from("payments")
      .update({ status: "success", squad_response: payload })
      .eq("id", payment.id)
      .eq("status", "pending")
      .select("id")
      .maybeSingle();
    if (claimError) {
      console.error("❌ Failed to claim payment:", claimError.message);
      return res.status(500).json({ success: false, message: "Failed to update payment" });
    }
    if (!claimed) {
      return res.status(200).json({ success: true, message: "Already processed" });
    }

    // Atomic credit via the credit_wallet RPC: self-heals the wallet row,
    // serializes concurrent webhooks, writes the audit trail.
    const { data: newBalance, error: creditError } = await supabase.rpc("credit_wallet", {
      p_user_id: payment.user_id,
      p_amount: paymentAmount,
      p_description: "Wallet funding via Squad - Verified"
    });
    if (creditError || newBalance === null || newBalance === undefined) {
      // Revert the claim so Squad's automatic retry can process it again —
      // a failed credit must never leave the payment stuck as "success".
      console.error("❌ Wallet Update Error:", creditError?.message || "0 rows updated");
      await supabase.from("payments").update({ status: "pending" }).eq("id", payment.id).eq("status", "success");
      return res.status(500).json({ success: false, message: "Failed to update wallet row" });
    }

    // Purchase-history row (schema matches the transactions table). Uses the
    // same idempotent logTx (find-by-reference → patch) so a webhook retry or
    // a concurrent writer can never create a second funding row.
    await logTx({
      user_id: payment.user_id,
      title: "Wallet Funding",
      service_type: "funding",
      amount: paymentAmount,
      recipient: "Squad",
      status: "successful",
      reference: txRef
    });

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
    // user. Refunded automatically if the provider rejects the order below.
    const newBalance = await debitWallet(userId, price);
    if (newBalance === null) {
      return res.status(400).json({ success: false, message: "Could not debit your wallet. Please try again." });
    }
    // Stash the debit on the request so the catch block (which cannot see
    // try-block consts) can refund the exact amount if the provider rejects it.
    req._debit = { userId: userId, price: price };
    const txRef = newTxRef("AIR");

    // Route to the ACTIVE provider for airtime (provider_routing) — same as
    // the data route. Never silently buy from Bigisub when Alrahuz is toggled.
    const provider = await getActiveProvider("airtime");

    let response;
    if (provider === "alrahuz") {
      response = await alrahuzService.buyAirtime({
        network: network, // slug / app id — alrahuz.getNetworkId maps it
        mobile_number: String(phone_number).trim(),
        amount: price,
      });
    } else {
      response = (await bigiClient.post("/api/v2/vtu/airtime/purchase/", {
        network: getNetworkId(network),
        phone_number: String(phone_number).trim(),
        amount: String(amount),
        airtime_type: "vtu",
        pin: DEFAULT_PIN
      })).data;
    }
    console.log("📦 AIRTIME raw response (" + provider + "):", JSON.stringify(response));

    if (bigiFailed(response)) {
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
        provider: canonicalNetworkName(network)
      });
      return res.status(400).json({
        success: false,
        message: bigiErrorMessage(response, provider === "alrahuz"
          ? "Alrahuzdata rejected this purchase"
          : "Bigisub rejected this purchase")
      });
    }

    // Provider returned a non-failure response but it signals "pending" / "processing"
    // — the order was accepted but NOT yet delivered. Keep the debit and log as pending
    // so the admin can reconcile later. Do NOT mark as successful yet.
    if (bigiPending(response)) {
      console.log("⏳ Airtime (" + provider + ") marked PENDING for user " + userId + " —₦" + price);
      await logTx({
        user_id: userId,
        title: "Airtime ₦" + price + " — Pending",
        service_type: "airtime",
        amount: price,
        recipient: String(phone_number).trim(),
        status: "pending",
        reference: txRef,
        provider: canonicalNetworkName(network)
      });
      return res.json({
        success: true,
        message: "Your airtime request is being processed. It will deliver shortly.",
        data: response,
        balance: newBalance,
        reference: txRef
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
      provider: canonicalNetworkName(network)
    });
    console.log("✅ Airtime (" + provider + "): user " + userId + " -₦" + price + " (balance ₦" + newBalance + ")");
    // reference is the idempotency key the app uses to find-and-patch this
    // row instead of inserting a duplicate.
    res.json({ success: true, message: "Airtime top-up successful", data: response, balance: newBalance, reference: txRef });
  } catch (err) {
    console.error("❌ Airtime Error:", err.response?.data || err.message);
    // try-block consts are invisible to catch, so the debit context comes
    // from the request (stashed right after the debit succeeded).
    const ctx = req._debit || null;
    const provStatus = err.response?.status || 0;
    if (provStatus >= 400 && provStatus < 500) {
      // The provider rejected the request outright (bad amount, bad phone, auth…)
      // — the order was NOT placed. Refund the debit so the user is never
      // charged for an order that didn't happen.
      if (ctx) {
        await creditWallet(ctx.userId, ctx.price);
      }
      console.error("❌ Order rejected by provider:", err.response?.data || err.message);
      return res.status(400).json({ success: false, message: bigiErrorMessage(err.response?.data, err.message) });
    }
    // 5xx / timeout / connection error: the provider may STILL have processed
    // the order (it has delivered airtime while returning "An error occurred…").
    // Keep the charge (refunding blindly could hand out free airtime) but ALWAYS
    // record the debited-but-unconfirmed order so it is never invisible to the
    // admin, who can refund it from the ledger if delivery never lands.
    console.error("⚠️ Order outcome uncertain:", err.response?.data || err.message);
    if (ctx) {
      await logTx({
        user_id: ctx.userId,
        title: "Airtime — Outcome Pending",
        service_type: "airtime",
        amount: ctx.price,
        recipient: String(req.body.phone_number || "").trim(),
        status: "pending",
        reference: newTxRef("PEND"),
        provider: canonicalNetworkName(req.body.network)
      });
    }
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
        // The CARRIER (MTN/AIRTEL/GLO/9MOBILE), never the gateway brand.
        provider: canonicalNetworkName(network)
      });
      return res.status(400).json({
        success: false,
        message: bigiErrorMessage(response, fulfillProvider === "alrahuz"
          ? "Alrahuzdata rejected this purchase"
          : "Bigisub rejected this purchase")
      });
    }

    if (bigiPending(response)) {
      console.log("⏳ Data (" + fulfillProvider + ") marked PENDING for user " + userId + " —₦" + price);
      await logTx({
        user_id: userId,
        title: (planRow?.volume ? planRow.volume + " Data" : "Data Purchase") + " — Pending",
        service_type: "data",
        amount: price,
        recipient: String(phone_number).trim(),
        status: "pending",
        reference: txRef,
        provider: canonicalNetworkName(network)
      });
      return res.json({
        success: true,
        message: "Your data request is being processed. It will deliver shortly.",
        provider: fulfillProvider,
        reference: txRef,
        data: response,
        balance: newBalance
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
      // The CARRIER (MTN/AIRTEL/GLO/9MOBILE), never the gateway brand.
      provider: canonicalNetworkName(network)
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
          provider: canonicalNetworkName(req.body.network)
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
    // Keep the charge (refunding blindly could hand out free data) but ALWAYS
    // record the debited-but-unconfirmed order so it is never invisible to the
    // admin, who can refund it from the ledger if delivery never lands.
    console.error("⚠️ Data outcome uncertain:", JSON.stringify(provError || err.message, null, 2));
    if (ctx) {
      await logTx({
        user_id: ctx.userId,
        title: "Data Purchase — Outcome Pending",
        service_type: "data",
        amount: ctx.price,
        recipient: String(req.body.phone_number || "").trim(),
        status: "pending",
        reference: newTxRef("PEND"),
        provider: canonicalNetworkName(req.body.network)
      });
    }
    return res.json({
      success: true,
      message: "Data request submitted — delivery may take a few minutes. If you don't receive it, contact support for a refund."
    });
  }
});

app.get("/api/v2/vtu/cable/plans", async (req, res) => {
  try {
    const cableName = getCableCode(req.query.cable_name || req.query.provider || "gotv");
    // Return the ACTIVE provider's catalog so the prices the app shows are the
    // prices that provider will actually charge (mirrors the data plans route).
    const provider = await getActiveProvider("cable");
    let plans;
    if (provider === "alrahuz") {
      plans = await alrahuzService.getCablePlans(cableName);
    } else {
      const response = await bigiClient.get("/api/v2/vtu/cable/plans/?cable_name=" + cableName);
      plans = response.data?.data || (Array.isArray(response.data) ? response.data : []);
    }
    res.json({ success: true, provider, data: plans });
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

    const activeProvider = await getActiveProvider("cable");
    let verifyData = {};
    if (activeProvider === "alrahuz") {
      const code = alrahuzService.cableCode(provider);
      if (code == null) {
        return res.status(400).json({ success: false, message: "Cable provider not supported on Alrahuzdata" });
      }
      const r = await alrahuzService.validateIUC({ smart_card_number: cardNo, cablename: code });
      verifyData = r?.data || r || {};
    } else {
      const response = await bigiClient.post("/api/v2/vtu/cable/verify/", {
        cable_name: provider,
        card_no: cardNo
      });
      verifyData = response.data?.data || {};
    }

    res.json({
      success: true,
      message: "Verification successful",
      data: {
        customerName: verifyData.customer_name || verifyData.name || "VERIFIED CUSTOMER",
        currentBouquet: verifyData.current_bouquet || verifyData.bouquet || "",
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
    // user. Refunded automatically if the provider rejects the order below.
    const newBalance = await debitWallet(userId, price);
    if (newBalance === null) {
      return res.status(400).json({ success: false, message: "Could not debit your wallet. Please try again." });
    }
    // Stash the debit on the request so the catch block (which cannot see
    // try-block consts) can refund the exact amount if the provider rejects it.
    req._debit = { userId: userId, price: price };
    const txRef = newTxRef("CBL");

    // Route to the ACTIVE provider for cable (provider_routing).
    const activeProvider = await getActiveProvider("cable");

    let response;
    if (activeProvider === "alrahuz") {
      // Alrahuz needs a numeric cablename + cableplan id (no plans API, so we
      // resolve the plan from the scraped catalog by the exact price shown in
      // the app — which is the ACTIVE provider's catalog, so it matches).
      const cablenameCode = alrahuzService.cableCode(cable_type || provider);
      // Alrahuz only offers GOTV(1), DSTV(2), STARTIME(3) — not SHOWMAX.
      if (cablenameCode == null || cablenameCode === 4) {
        await creditWallet(userId, price);
        return res.status(400).json({ success: false, message: "Cable provider not supported on Alrahuzdata" });
      }
      const plan = await alrahuzService.resolveCablePlan(cable_type || provider, price);
      if (!plan) {
        await creditWallet(userId, price);
        return res.status(400).json({
          success: false,
          message: "Cable plan not found on Alrahuzdata — please refresh the plan list or route cable back to Bigisub"
        });
      }
      response = await alrahuzService.buyCable({
        cablename: cablenameCode,
        cableplan: Number(plan.id),
        smart_card_number: String(card_no).trim(),
      });
    } else {
      response = (await bigiClient.post("/api/v2/vtu/cable/purchase/", {
        cable_type: getCableCode(cable_type || provider),
        card_no: String(card_no).trim(),
        phone_number: String(phone_number).trim(),
        amount: price,
        Customer: String(Customer || customerName).trim(),
        pin: DEFAULT_PIN
      })).data;
    }
    console.log("📦 CABLE raw response (" + activeProvider + "):", JSON.stringify(response));

    if (bigiFailed(response)) {
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
        provider: cableDisplayName(cable_type || provider)
      });
      return res.status(400).json({
        success: false,
        message: bigiErrorMessage(response, activeProvider === "alrahuz"
          ? "Alrahuzdata rejected this purchase"
          : "Bigisub rejected this purchase")
      });
    }

    if (bigiPending(response)) {
      console.log("⏳ Cable (" + activeProvider + ") marked PENDING for user " + userId + " —₦" + price);
      await logTx({
        user_id: userId,
        title: "Cable TV — Pending",
        service_type: "cable",
        amount: price,
        recipient: String(card_no).trim(),
        status: "pending",
        reference: txRef,
        provider: cableDisplayName(cable_type || provider)
      });
      return res.json({
        success: true,
        message: "Your cable subscription is being processed. It will deliver shortly.",
        data: response,
        balance: newBalance,
        reference: txRef
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
      provider: cableDisplayName(cable_type || provider)
    });
    console.log("✅ Cable (" + activeProvider + "): user " + userId + " -₦" + price + " (balance ₦" + newBalance + ")");
    res.json({ success: true, message: "Cable subscription successful", data: response, balance: newBalance, reference: txRef });
  } catch (err) {
    // try-block consts are invisible to catch, so the debit context comes
    // from the request (stashed right after the debit succeeded).
    const ctx = req._debit || null;
    const provStatus = err.response?.status || 0;
    if (provStatus >= 400 && provStatus < 500) {
      // The provider rejected the request outright (bad amount, bad card, auth…)
      // — the order was NOT placed. Refund the debit so the user is never
      // charged for an order that didn't happen.
      if (ctx) {
        await creditWallet(ctx.userId, ctx.price);
      }
      console.error("❌ Order rejected by provider:", err.response?.data || err.message);
      return res.status(400).json({ success: false, message: bigiErrorMessage(err.response?.data, err.message) });
    }
    // 5xx / timeout / connection error: the provider may STILL have processed
    // the order (it has delivered airtime while returning "An error occurred…").
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
    // Return the ACTIVE provider's recharge-pin denominations so the app shows
    // the prices/catalog the provider will actually fulfil (mirrors data plans).
    const provider = await getActiveProvider("recharge_pin");
    let plans;
    if (provider === "alrahuz") {
      plans = alrahuzService.getRechargePinPlans(req.query.network);
    } else {
      const netId = getNetworkId(req.query.network);
      const response = await bigiClient.get("/api/v2/vtu/recharge-pin/plans/?network=" + netId);
      plans = response.data?.data || (Array.isArray(response.data) ? response.data : []);
    }
    res.json({ success: true, provider, data: plans });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message, data: [] });
  }
});

app.get("/api/v2/bills/electricity/providers", async (_req, res) => {
  try {
    // Return the ACTIVE provider's disco list so the app shows what the
    // provider can actually fulfil (mirrors the data plans route).
    const provider = await getActiveProvider("electricity");
    let data;
    if (provider === "alrahuz") {
      data = alrahuzService.getDiscoList();
    } else {
      const response = await bigiClient.get("/api/v2/bills/electricity/providers/");
      data = response.data?.data?.providers || response.data?.data || [];
    }
    res.json({ success: true, provider, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message, data: [] });
  }
});

app.post("/api/v2/bills/electricity/verify", async (req, res) => {
  try {
    const { company, meter_no, meter_type } = req.body;
    const activeProvider = await getActiveProvider("electricity");
    let verifyData = {};
    if (activeProvider === "alrahuz") {
      const discoId = alrahuzService.discoIdForCode(company);
      if (discoId == null) {
        return res.status(400).json({ success: false, message: "Electricity provider not supported on Alrahuzdata" });
      }
      const r = await alrahuzService.validateMeter({
        meternumber: String(meter_no).trim(),
        disconame: discoId,
        mtype: alrahuzService.meterTypeCode(meter_type),
      });
      verifyData = r?.data || r || {};
    } else {
      const response = await bigiClient.post("/api/v2/bills/electricity/verify/", {
        company: String(company).trim(),
        meter_no: String(meter_no).trim(),
        meter_type: String(meter_type || "prepaid").trim()
      });
      verifyData = response.data?.data || {};
    }
    res.json({
      success: true,
      message: "Meter verified",
      data: {
        customerName: verifyData.customer_name || verifyData.name || "VERIFIED CUSTOMER",
        customerAddress: verifyData.customer_address || verifyData.address || "",
        meterNumber: verifyData.meter_number || meter_no
      }
    });
  } catch (err) {
    res.status(400).json({ success: false, message: err.response?.data?.message || "Electricity meter verification failed" });
  }
});

app.get("/api/v2/bills/result-checker/prices", async (_req, res) => {
  try {
    // NOTE: Alrahuz has no result-checker price endpoint, so prices always come
    // from Bigisub. The exam PIN purchase route still routes to the ACTIVE
    // provider (epin) — the admin is responsible for setting prices that cover
    // the active provider's cost.
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
    // user. Refunded automatically if the provider rejects the order below.
    const newBalance = await debitWallet(userId, price);
    if (newBalance === null) {
      return res.status(400).json({ success: false, message: "Could not debit your wallet. Please try again." });
    }
    // Stash the debit on the request so the catch block (which cannot see
    // try-block consts) can refund the exact amount if the provider rejects it.
    req._debit = { userId: userId, price: price };
    const txRef = newTxRef("ELEC");

    // Route to the ACTIVE provider for electricity (provider_routing).
    const activeProvider = await getActiveProvider("electricity");

    let response;
    if (activeProvider === "alrahuz") {
      const discoId = alrahuzService.discoIdForCode(company);
      if (discoId == null) {
        await creditWallet(userId, price);
        return res.status(400).json({ success: false, message: "Electricity provider not supported on Alrahuzdata" });
      }
      response = await alrahuzService.buyElectricity({
        disco_name: discoId,
        amount: price,
        meter_number: String(meter_no).trim(),
        MeterType: alrahuzService.meterTypeCode(meter_type),
      });
    } else {
      response = (await bigiClient.post("/api/v2/bills/electricity/pay/", {
        company: String(company).trim(),
        meter_no: String(meter_no).trim(),
        meter_type: String(meter_type || "prepaid").trim(),
        phone_number: String(phone_number).trim(),
        amount: price,
        Customer_name: String(Customer_name || customerName || "").trim(),
        pin: DEFAULT_PIN
      })).data;
    }
    console.log("📦 ELECTRICITY raw response (" + activeProvider + "):", JSON.stringify(response));

    if (bigiFailed(response)) {
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
        provider: String(company).trim().toUpperCase()
      });
      return res.status(400).json({
        success: false,
        message: bigiErrorMessage(response, activeProvider === "alrahuz"
          ? "Alrahuzdata rejected this payment"
          : "Bigisub rejected this payment")
      });
    }

    if (bigiPending(response)) {
      console.log("⏳ Electricity (" + activeProvider + ") marked PENDING for user " + userId + " —₦" + price);
      await logTx({
        user_id: userId,
        title: "Electricity — Pending",
        service_type: "electricity",
        amount: price,
        recipient: String(meter_no).trim(),
        status: "pending",
        reference: txRef,
        provider: String(company).trim().toUpperCase()
      });
      return res.json({
        success: true,
        message: "Your electricity payment is being processed. It will deliver shortly.",
        data: response,
        balance: newBalance,
        reference: txRef
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
      provider: String(company).trim().toUpperCase()
    });
    console.log("✅ Electricity (" + activeProvider + "): user " + userId + " -₦" + price + " (balance ₦" + newBalance + ")");
    // The Android app shows the recharge token on the receipt — surface the
    // provider's token (whatever shape it arrives in) so the screen can show it.
    const token = response?.data?.token || response?.token || null;
    res.json({ success: true, message: "Electricity bill paid", data: response, token: token, balance: newBalance, reference: txRef });
  } catch (err) {
    // try-block consts are invisible to catch, so the debit context comes
    // from the request (stashed right after the debit succeeded).
    const ctx = req._debit || null;
    const provStatus = err.response?.status || 0;
    if (provStatus >= 400 && provStatus < 500) {
      // The provider rejected the request outright (bad amount, bad phone, auth…)
      // — the order was NOT placed. Refund the debit so the user is never
      // charged for an order that didn't happen.
      if (ctx) {
        await creditWallet(ctx.userId, ctx.price);
      }
      console.error("❌ Order rejected by provider:", err.response?.data || err.message);
      return res.status(400).json({ success: false, message: bigiErrorMessage(err.response?.data, err.message) });
    }
    // 5xx / timeout / connection error: the provider may STILL have processed
    // the order (it has delivered airtime while returning "An error occurred…").
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

    // Route to the ACTIVE provider for recharge pins (provider_routing).
    const activeProvider = await getActiveProvider("recharge_pin");

    // Resolve the unit price from the ACTIVE provider's denomination catalog,
    // then charge qty x price.
    let unitPrice;
    if (activeProvider === "alrahuz") {
      unitPrice = alrahuzService.resolveRechargePinAmount(network, numericPlanId);
    } else {
      const netId = getNetworkId(network);
      const plansRes = await bigiClient.get("/api/v2/vtu/recharge-pin/plans/?network=" + netId);
      const plans = plansRes.data?.data || (Array.isArray(plansRes.data) ? plansRes.data : []);
      const planInfo = plans.find(p => Number(p.id) === numericPlanId);
      unitPrice = Number(planInfo?.regular_price || planInfo?.corporate_price || 0);
    }
    const price = (unitPrice || 0) * qty;
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
    const txRef = newTxRef("PIN");

    let response;
    if (activeProvider === "alrahuz") {
      response = await alrahuzService.buyRechargePin({
        network: network, // slug / app id — alrahuz.getNetworkId maps it
        network_amount: numericPlanId, // the Alrahuz network_amount id from the catalog
        quantity: qty,
        name_on_card: String(name_on_card || card_name || "").trim(),
      });
    } else {
      response = (await bigiClient.post("/api/v2/vtu/recharge-pin/purchase/", {
        network: getNetworkId(network),
        plan: numericPlanId,
        quantity: qty,
        card_name: String(card_name || "").trim(),
        name_on_card: String(name_on_card || "").trim(),
        pin: DEFAULT_PIN
      })).data;
    }
    console.log("📦 RECHARGE PIN raw response (" + activeProvider + "):", JSON.stringify(response));

    if (bigiFailed(response)) {
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
        provider: canonicalNetworkName(network)
      });
      return res.status(400).json({
        success: false,
        message: bigiErrorMessage(response, activeProvider === "alrahuz"
          ? "Alrahuzdata rejected this purchase"
          : "Bigisub rejected this purchase")
      });
    }

    if (bigiPending(response)) {
      console.log("⏳ Recharge PIN (" + activeProvider + ") marked PENDING for user " + userId + " —₦" + price);
      await logTx({
        user_id: userId,
        title: "Recharge PINs — Pending",
        service_type: "recharge_pin",
        amount: price,
        recipient: String(network || "").trim(),
        status: "pending",
        reference: txRef,
        provider: canonicalNetworkName(network)
      });
      return res.json({
        success: true,
        message: "Your recharge PINs are being processed. They will deliver shortly.",
        data: response,
        balance: newBalance,
        reference: txRef
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
      provider: canonicalNetworkName(network)
    });
    console.log("✅ Recharge PIN (" + activeProvider + "): user " + userId + " -₦" + price + " (balance ₦" + newBalance + ")");
    res.json({ success: true, message: "Recharge PINs generated", data: response, balance: newBalance, reference: txRef });
  } catch (err) {
    // try-block consts are invisible to catch, so the debit context comes
    // from the request (stashed right after the debit succeeded).
    const ctx = req._debit || null;
    const provStatus = err.response?.status || 0;
    if (provStatus >= 400 && provStatus < 500) {
      // The provider rejected the request outright (bad amount, bad network, auth…)
      // — the order was NOT placed. Refund the debit so the user is never
      // charged for an order that didn't happen.
      if (ctx) {
        await creditWallet(ctx.userId, ctx.price);
      }
      console.error("❌ Order rejected by provider:", err.response?.data || err.message);
      return res.status(400).json({ success: false, message: bigiErrorMessage(err.response?.data, err.message) });
    }
    // 5xx / timeout / connection error: the provider may STILL have processed
    // the order (it has delivered airtime while returning "An error occurred…").
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
    // user. Refunded automatically if the provider rejects the order below.
    const newBalance = await debitWallet(userId, price);
    if (newBalance === null) {
      return res.status(400).json({ success: false, message: "Could not debit your wallet. Please try again." });
    }
    // Stash the debit on the request so the catch block (which cannot see
    // try-block consts) can refund the exact amount if the provider rejects it.
    req._debit = { userId: userId, price: price };
    const txRef = newTxRef("EPIN");

    // Route to the ACTIVE provider for epin (provider_routing).
    const activeProvider = await getActiveProvider("epin");

    let response;
    if (activeProvider === "alrahuz") {
      response = await alrahuzService.buyEPin({
        exam_name: String(exam).trim(),
        quantity: qty,
      });
    } else {
      response = (await bigiClient.post("/api/v2/bills/result-checker/purchase/", {
        exam: String(exam).trim(),
        quantity: qty,
        pin_code: String(pin_code || DEFAULT_PIN).trim()
      })).data;
    }
    console.log("📦 EXAM PIN raw response (" + activeProvider + "):", JSON.stringify(response));

    if (bigiFailed(response)) {
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
        provider: null
      });
      return res.status(400).json({
        success: false,
        message: bigiErrorMessage(response, activeProvider === "alrahuz"
          ? "Alrahuzdata rejected this purchase"
          : "Bigisub rejected this purchase")
      });
    }

    if (bigiPending(response)) {
      console.log("⏳ Exam PIN (" + activeProvider + ") marked PENDING for user " + userId + " —₦" + price);
      await logTx({
        user_id: userId,
        title: "Exam PIN — Pending",
        service_type: "exam_pin",
        amount: price,
        recipient: String(exam).trim(),
        status: "pending",
        reference: txRef,
        provider: null
      });
      return res.json({
        success: true,
        message: "Your exam PINs are being processed. They will deliver shortly.",
        data: response,
        balance: newBalance,
        reference: txRef
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
      provider: null
    });
    console.log("✅ Exam PIN (" + activeProvider + "): user " + userId + " -₦" + price + " (balance ₦" + newBalance + ")");
    // The Android app shows the purchased PINs in a dialog — extract them from
    // whatever shape the provider returns (wrapped in data, or a bare array).
    const rawData = response?.data;
    const pins =
      response?.pins ||
      rawData?.pins ||
      (Array.isArray(rawData) ? rawData : []);
    res.json({ success: true, message: "Exam PINs generated", data: response, pins: pins, balance: newBalance, reference: txRef });
  } catch (err) {
    // try-block consts are invisible to catch, so the debit context comes
    // from the request (stashed right after the debit succeeded).
    const ctx = req._debit || null;
    const provStatus = err.response?.status || 0;
    if (provStatus >= 400 && provStatus < 500) {
      // The provider rejected the request outright (bad amount, bad phone, auth…)
      // — the order was NOT placed. Refund the debit so the user is never
      // charged for an order that didn't happen.
      if (ctx) {
        await creditWallet(ctx.userId, ctx.price);
      }
      console.error("❌ Order rejected by provider:", err.response?.data || err.message);
      return res.status(400).json({ success: false, message: bigiErrorMessage(err.response?.data, err.message) });
    }
    // 5xx / timeout / connection error: the provider may STILL have processed
    // the order (it has delivered airtime while returning "An error occurred…").
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

// GET /api/v2/admin/keycheck — reports the role claim of the key this
// server is actually using, AND runs the real stats queries so we can see
// exactly what the server's own client returns, errors included.
app.get("/api/v2/admin/keycheck", requireAdmin, async (_req, res) => {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  const fp = key.slice(-12);
  let role = "unknown";
  try {
    role = JSON.parse(Buffer.from(key.split(".")[1], "base64").toString()).role || "unknown";
  } catch { role = "malformed"; }

  // Raw PostgREST call with explicit headers — no supabase-js involved
  let raw = null;
  try {
    const r = await axios.get(`${process.env.SUPABASE_URL}/rest/v1/transactions`, {
      params: { select: "id" },
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      timeout: 15000,
    });
    raw = {
      status: r.status,
      rows: Array.isArray(r.data) ? r.data.length : null,
      content_range: r.headers["content-range"] || null,
    };
  } catch (e) {
    raw = { error: e.response?.status || e.message };
  }

  res.json({
    success: true,
    url_host: (() => { try { return new URL(process.env.SUPABASE_URL).host } catch { return null } })(),
    key_fingerprint: fp,
    key_role: role,
    raw_postgrest_transactions: raw,
    probes: {},
  });
});

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
// Provider balances are cached for 60s: vendor APIs are slow/flaky from Render
// and the dashboard polls every 15s — live-calling vendors per poll piles up
// requests and kills the endpoint. Wallet liability / user counts come straight
// from Postgres and are always fresh regardless of vendor health.

const _statsBalanceCache = { data: null, ts: 0 };
const STATS_BALANCE_TTL_MS = 60_000;

app.get("/api/v2/admin/stats", requireAdmin, async (_req, res) => {
  try {
    // Fetch both provider balances in parallel — a provider failing must
    // never take down the whole dashboard. 6s hard timeout each so a dead
    // vendor can never stall this endpoint.
    const fetchBalances = async () => {
      let bigisubBalance = 0;
      let alrahuzBalance = 0;
      const [bigiResult, alrahuzResult] = await Promise.allSettled([
        (async () => {
          try {
            const r = await bigiClient.get("/api/v2/financial/wallet/balance/", { timeout: 6000 });
            return Number(r.data?.data?.balance ?? r.data?.balance ?? 0);
          } catch {
            try {
              const r = await bigiClient.get("/api/v2/balance/", { timeout: 6000 });
              return Number(r.data?.balance ?? r.data?.data?.balance ?? 0);
            } catch {
              const r = await bigiClient.get("/api/balance/", { timeout: 6000 });
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
      return { bigisub: Number(bigisubBalance.toFixed(2)), alrahuz: Number(alrahuzBalance.toFixed(2)) };
    };

    let balances;
    const now = Date.now();
    if (_statsBalanceCache.data && now - _statsBalanceCache.ts < STATS_BALANCE_TTL_MS) {
      balances = _statsBalanceCache.data;
    } else {
      balances = await fetchBalances();
      _statsBalanceCache.data = balances;
      _statsBalanceCache.ts = now;
    }

    // Fetch active provider routes
    let activeRoutes = { airtime: "bigisub", data: "bigisub", cable: "bigisub", electricity: "bigisub", epin: "bigisub", recharge_pin: "bigisub" };
    try {
      const { data: routes } = await supabase.from("provider_routing").select("service, provider");
      if (routes) routes.forEach(r => { activeRoutes[r.service] = r.provider; });
    } catch (e) {
      console.warn("⚠️ Could not fetch provider_routing (table may not exist yet):", e.message);
    }

    const [usersRes, walletRes, txRes, revenueRes] = await Promise.all([
      supabase.from("profiles").select("id", { count: "exact", head: true }),
      supabase.from("wallets").select("balance"),
      supabase.from("transactions").select("id", { count: "exact", head: true }),
      // Revenue = ONLY successful transactions (refunded / failed / pending
      // must never count). Summed in JS to be safe across statuses.
      supabase.from("transactions").select("amount").eq("status", "successful")
    ]);

    const totalUsers = usersRes.count || 0;
    const totalTransactions = txRes.count || 0;
    const totalLiability = (walletRes.data || []).reduce((sum, w) => sum + Number(w.balance || 0), 0);
    const totalRevenue = (revenueRes.data || []).reduce((sum, t) => sum + Number(t.amount || 0), 0);

    res.json({
      success: true,
      data: {
        // RAW NUMBERS — the dashboard formats them. Pre-formatted strings
        // like "1,234.00" become NaN when the UI runs Number() on them.
        balances: {
          bigisub: balances.bigisub,
          alrahuz: balances.alrahuz
        },
        active_routes: activeRoutes,
        total_registered_users: totalUsers,
        total_transactions: totalTransactions,
        total_wallet_liability: Number(totalLiability.toFixed(2)),
        total_revenue: Number(totalRevenue.toFixed(2))
      }
    });
  } catch (err) {
    console.error("❌ Admin stats error:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/v2/admin/stats/charts — purchase statistics for the dashboard
// charts (last 14 days). Returns:
//   daily:       14 buckets { date, count, amount }
//   byService:   [{ service_type, count, amount }]
//   byProvider:  [{ provider, count, amount }]  (provider may be a carrier name)
//   totals:      { purchases, volume, success, failed, refunded }
app.get("/api/v2/admin/stats/charts", requireAdmin, async (_req, res) => {
  try {
    const since = new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString();
    const { data: rows, error } = await supabase
      .from("transactions")
      .select("service_type, provider, status, amount, created_at")
      .gte("created_at", since);
    if (error) throw error;

    // 14 daily buckets (oldest first).
    const dayMap = {};
    const days = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000);
      const key = d.toISOString().slice(0, 10);
      dayMap[key] = { date: key, count: 0, amount: 0 };
      days.push(dayMap[key]);
    }

    const byService = {};
    const byProvider = {};
    const totals = { purchases: 0, volume: 0, success: 0, failed: 0, refunded: 0 };

    for (const r of rows || []) {
      const key = (r.created_at || "").slice(0, 10);
      if (dayMap[key]) {
        dayMap[key].count++;
        dayMap[key].amount += Number(r.amount || 0);
      }

      const svc = (r.service_type || "other").toLowerCase();
      byService[svc] = byService[svc] || { service_type: svc, count: 0, amount: 0 };
      byService[svc].count++;
      byService[svc].amount += Number(r.amount || 0);

      const prov = (r.provider || "unknown").toUpperCase();
      byProvider[prov] = byProvider[prov] || { provider: prov, count: 0, amount: 0 };
      byProvider[prov].count++;
      byProvider[prov].amount += Number(r.amount || 0);

      totals.purchases++;
      totals.volume += Number(r.amount || 0);
      const st = (r.status || "").toLowerCase();
      if (st === "successful") totals.success++;
      else if (st === "failed") totals.failed++;
      else if (st === "refunded") totals.refunded++;
    }

    res.json({
      success: true,
      data: {
        daily: days,
        byService: Object.values(byService).sort((a, b) => b.count - a.count),
        byProvider: Object.values(byProvider).sort((a, b) => b.count - a.count),
        totals,
      },
    });
  } catch (err) {
    console.error("❌ Admin charts error:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/v2/admin/providers — current routing state
app.get("/api/v2/admin/providers", requireAdmin, async (_req, res) => {
  try {
    let routes = { airtime: "bigisub", data: "bigisub", cable: "bigisub", electricity: "bigisub", epin: "bigisub", recharge_pin: "bigisub" };
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
    const validServices = ["airtime", "data", "cable", "electricity", "epin", "recharge_pin"];

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
    const search = (req.query.search || "").trim();

    // NOTE: no PostgREST embed here — the transactions table has NO foreign
    // key on user_id, so `profiles:user_id(...)` fails with "Could not find a
    // relationship between 'transactions' and 'user_id'". Profiles are joined
    // manually below instead.
    let query = supabase
      .from("transactions")
      .select("*", { count: "exact" })
      // Newest first. The `id` tiebreaker keeps ordering stable when multiple
      // rows share the same created_at (same-second writes) — without it,
      // Postgres can return equal timestamps in arbitrary order and a fresh
      // transaction can appear to jump to the bottom of the ledger.
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(offset, offset + limit - 1);

    if (statusFilter) query = query.eq("status", statusFilter);
    if (typeFilter) query = query.eq("service_type", typeFilter);

    // Search matches the recipient phone OR the customer's email / phone
    // number. PostgREST filter values must not contain its DSL delimiters,
    // so strip them before interpolating.
    if (search) {
      const clean = search.replace(/[(),"'\\]/g, " ").replace(/\s+/g, " ").trim();
      if (clean) {
        const { data: profs } = await supabase
          .from("profiles")
          .select("id")
          .or(`email.ilike.%${clean}%,phone_number.ilike.%${clean}%`)
          .limit(200);
        const ids = (profs || []).map((p) => p.id).filter(Boolean);
        const conds = [`recipient.ilike.%${clean}%`];
        if (ids.length) conds.push(`user_id.in.(${ids.join(",")})`);
        query = query.or(conds.join(","));
      }
    }

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

// ---------------------------------------------------------------------
// PENDING-ORDER RECONCILIATION (safe auto-refund)
// A pending transaction means the wallet was debited but the provider's
// outcome was unknown (timeout/5xx). We NEVER refund without proof it was
// not delivered — that would hand out free service. We reconcile against the
// provider's own order history:
//   delivered  -> mark the transaction successful (keep the charge)
//   failed     -> auto-refund (credit wallet + log refund audit row)
//   absent     -> the provider never created the order -> safe to refund
//   unknown    -> leave pending for the admin to decide
// ---------------------------------------------------------------------

async function reconcilePending(tx) {
  const svc = (tx.service_type || "").toLowerCase();
  if (svc !== "data" && svc !== "airtime") return { verdict: "unsupported" };

  const provider = await getActiveProvider(svc === "data" ? "data" : "airtime");
  if (provider !== "alrahuz") return { verdict: "unsupported", reason: "reconciliation only wired for Alrahuz" };

  try {
    const { matches, order } = await alrahuzService.queryRecentOrder({
      service: svc,
      mobile_number: tx.recipient,
      amount: Number(tx.amount || 0),
      carrier: tx.provider,
      plan: svc === "data" ? tx.plan_id : null,
    });
    if (!order) return { verdict: "absent", matches: matches.length };

    const status = String(order.Status || order.status || "").toLowerCase();
    if (["successful", "success", "delivered", "1"].includes(status)) {
      return { verdict: "delivered", orderId: order.id };
    }
    if (["failed", "error", "failure", "reversed", "refunded", "0"].includes(status)) {
      return { verdict: "failed", orderId: order.id };
    }
    return { verdict: "unknown", orderId: order.id };
  } catch (e) {
    return { verdict: "error", error: e.message };
  }
}

async function refundPendingTx(tx) {
  const newBalance = await creditWallet(tx.user_id, Number(tx.amount));
  if (newBalance === null) return { refunded: false, error: "Wallet credit failed" };

  await supabase.from("transactions").update({ status: "refunded" }).eq("id", tx.id);
  await logTx({
    user_id: tx.user_id,
    title: "Auto-refund: " + (tx.title || "Transaction"),
    service_type: "refund",
    amount: Number(tx.amount),
    recipient: tx.recipient || "system",
    status: "successful",
    reference: newTxRef("REFUND"),
    provider: tx.provider,
  });
  return { refunded: true, newBalance };
}

// POST /api/v2/admin/transactions/reconcile — verify a pending transaction
// against the provider and refund ONLY when delivery is disproven.
app.post("/api/v2/admin/transactions/reconcile", requireAdmin, async (req, res) => {
  try {
    const { transaction_id } = req.body;
    if (!transaction_id) return res.status(400).json({ success: false, message: "transaction_id is required" });

    const { data: tx, error } = await supabase
      .from("transactions")
      .select("*")
      .eq("id", transaction_id)
      .maybeSingle();
    if (error || !tx) return res.status(404).json({ success: false, message: "Transaction not found" });
    if (tx.status !== "pending") {
      return res.status(400).json({ success: false, message: "Only pending transactions can be reconciled" });
    }

    const r = await reconcilePending(tx);

    if (r.verdict === "delivered") {
      await supabase.from("transactions").update({ status: "successful" }).eq("id", tx.id);
      return res.json({ success: true, action: "marked_successful", message: "Provider confirmed delivery — charge kept", detail: r.orderId });
    }

    if (r.verdict === "failed" || r.verdict === "absent") {
      const refund = await refundPendingTx(tx);
      if (refund.refunded) {
        return res.json({ success: true, action: "refunded", message: `Refunded ₦${Number(tx.amount).toLocaleString()} (delivery not confirmed)` });
      }
      return res.status(500).json({ success: false, action: "refund_failed", message: refund.error || "Refund failed" });
    }

    return res.json({
      success: false,
      action: "unresolved",
      message: "Could not verify delivery against the provider — leave pending or refund manually.",
      detail: r.error || r.orderId || null,
    });
  } catch (err) {
    console.error("❌ Admin reconcile error:", err.message);
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

// GET /api/v2/admin/plans/bigisub — all plans with Bigisub IDs for admin view
app.get("/api/v2/admin/plans/bigisub", requireAdmin, async (req, res) => {
  try {
    const appNetId = Number(req.query.network) || null;
    let query = supabase
      .from("data_plans")
      .select("*")
      .not("bigi_plan_id", "is", null)
      .eq("is_active", true)
      .order("retail_price", { ascending: true });
    if (appNetId) query = query.eq("network_id", appNetId);
    const { data: plans, error } = await query;
    if (error) throw error;
    const formatted = (plans || [])
      .filter(p => /^\d+$/.test(String(p.bigi_plan_id)))
      .map(p => ({
        row_id: p.id,
        volume: p.volume,
        validity: p.validity,
        network_id: p.network_id,
        plan_type: p.plan_type,
        bigi_plan_id: p.bigi_plan_id,
        buy_price: p.buy_price,
        retail_price: p.retail_price,
        is_active: p.is_active,
      }));
    res.json({ success: true, provider: "bigisub", data: formatted });
  } catch (err) {
    console.error("❌ Bigisub plans fetch error:", err.message);
    res.status(500).json({ success: false, message: err.message, data: [] });
  }
});

// GET /api/v2/admin/plans/alrahuz — all plans with Alrahuz IDs for admin view
app.get("/api/v2/admin/plans/alrahuz", requireAdmin, async (req, res) => {
  try {
    const appNetId = Number(req.query.network) || null;
    let query = supabase
      .from("data_plans")
      .select("*")
      .not("alrahuz_plan_id", "is", null)
      .eq("is_active", true)
      .order("retail_price", { ascending: true });
    if (appNetId) query = query.eq("network_id", appNetId);
    const { data: plans, error } = await query;
    if (error) throw error;
    const formatted = (plans || []).map(p => ({
      row_id: p.id,
      volume: p.volume,
      validity: p.validity,
      network_id: p.network_id,
      plan_type: p.plan_type,
      alrahuz_plan_id: p.alrahuz_plan_id,
      alrahuz_buy_price: p.alrahuz_buy_price,
      retail_price: p.retail_price,
      is_active: p.is_active,
    }));
    res.json({ success: true, provider: "alrahuz", data: formatted });
  } catch (err) {
    console.error("❌ Alrahuz plans fetch error:", err.message);
    res.status(500).json({ success: false, message: err.message, data: [] });
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
  // Cache policy that makes every deploy visible immediately:
  //  - index.html: NEVER cached (browser re-fetches it each load), so it
  //    always points at the newest hashed bundle after a deploy.
  //  - hashed assets (index-*.js / *.css): immutable, cached long-term
  //    (Vite content-hashes the filenames, so a new deploy = new filename =
  //    no stale JS ever served).
  const setAdminHeaders = (res, filePath) => {
    if (filePath.endsWith("index.html")) {
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      res.setHeader("Pragma", "no-cache");
    } else {
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    }
  };
  app.use("/admin", express.static(adminDist, { index: "index.html", setHeaders: setAdminHeaders }));
  // SPA fallback: client-side routes like /admin/plans render index.html
  app.get("/admin/*", (_req, res) => {
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
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

// ---------------------------------------------------------------------
// AUTO-RECONCILE PENDING ORDERS (safe auto-refund)
// Every 2 minutes, pending transactions (debited, outcome unknown) within the
// last hour are reconciled against the provider's order history. We refund
// ONLY when the provider confirms the order FAILED — never on a guess. A
// delivered order is flipped to successful; absent/unknown stays pending so
// the admin can decide. Disable with DISABLE_AUTO_RECONCILE=1 if ever needed.
// ---------------------------------------------------------------------
if (!process.env.DISABLE_AUTO_RECONCILE) {
  cron.schedule("*/2 * * * *", async () => {
    try {
      const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const { data: pending } = await supabase
        .from("transactions")
        .select("*")
        .eq("status", "pending")
        .gte("created_at", since)
        .limit(20);
      if (!pending || pending.length === 0) return;

      for (const tx of pending) {
        const r = await reconcilePending(tx);
        if (r.verdict === "failed") {
          const refund = await refundPendingTx(tx);
          console.log(`✅ Auto-reconcile refund (confirmed failed): ${tx.reference} -> ${refund.refunded ? "refunded ₦" + tx.amount : "FAILED " + (refund.error || "")}`);
        } else if (r.verdict === "delivered") {
          await supabase.from("transactions").update({ status: "successful" }).eq("id", tx.id);
          console.log(`ℹ️ Auto-reconcile delivered (charge kept): ${tx.reference}`);
        }
        // absent / unknown / error: leave pending for the admin to decide.
      }
    } catch (e) {
      console.error("❌ Auto-reconcile job error:", e.message);
    }
  });
  console.log("♻️ Auto-reconcile active (every 2 min): refunds only provider-confirmed failures");
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log("🚀 Dreamhatcher Production Server active on port " + PORT));
