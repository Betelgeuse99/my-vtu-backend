// Second-stage patch for the Dreamhatcher Render backend (server.js).
//
// PREREQUISITE: run .scratch/patch-backend.js FIRST (your server.js is already
// in that state if it has ensureWallet / maybeSingle / "Debit FIRST" blocks).
// Also deploy supabase-migrations/CURRENT_SETUP.sql BEFORE this so the
// debit_wallet / credit_wallet RPCs exist.
//
// Usage: node patch-backend-rpc.js server.js
//
// What it changes:
//   1. debitWallet  -> calls the atomic debit_wallet RPC (no read-modify-write
//                      race, self-heals missing rows, no negative balances).
//   2. creditWallet -> calls the atomic credit_wallet RPC (refunds).
//   3. POST /api/v2/webhooks/squad -> REQUIRES the Squad HMAC-SHA512 signature,
//      credits only payment rows this app created (never by email), uses the
//      credit_wallet RPC, and writes the transactions row with the correct
//      schema. The old handler credited any wallet for any "email + amount"
//      with no signature — a free-money hole.
//   4. Adds the `crypto` require and an express.json raw-body capture (the
//      HMAC is computed over the RAW request bytes, not re-serialized JSON).
//   5. requestUserId -> authenticates the caller via the Supabase session
//      token (Authorization: Bearer <jwt>) instead of trusting the
//      client-sent x-user-id header, so nobody can spend another user's
//      wallet by spoofing a userId. The app must send the token (the
//      Android side of this change is already in VtuViewModel/ApiService).

const fs = require('fs');
const path = require('path');

const target = process.argv[2];
if (!target) { console.error('Usage: node patch-backend-rpc.js <path-to-server.js>'); process.exit(1); }

let src = fs.readFileSync(target, 'utf8');
const hadCRLF = src.includes('\r\n');
if (hadCRLF) src = src.replace(/\r\n/g, '\n');

function rep(oldS, newS, label) {
  const count = src.split(oldS).length - 1;
  if (count === 0) { console.error('MISS [' + label + ']'); process.exit(1); }
  src = src.split(oldS).join(newS);
  console.log('OK [' + label + '] x' + count);
}

// 1. crypto require (HMAC-SHA512 for the webhook signature)
rep(`const https = require("https");`,
`const https = require("https");
const crypto = require("crypto");`,
'crypto require');

// 2. Capture the raw request body (the webhook HMAC is over raw bytes)
rep(`app.use(express.json());`,
`app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));`,
'raw body capture');

// 3. debitWallet -> atomic RPC
rep(`/**
 * Debits [amount] from [userId]'s wallet. Called BEFORE the order is fulfilled
 * so an order can never be delivered without charging the user. Returns the
 * new balance, or null when the debit failed.
 */
async function debitWallet(userId, amount) {
  const wallet = await ensureWallet(userId);
  const balance = Number(wallet?.balance || 0);
  const newBalance = balance - amount;
  const { data, error } = await supabase
    .from("wallets")
    .update({ balance: newBalance })
    .eq("user_id", userId)
    .select("balance")
    .maybeSingle();
  if (error || !data) {
    console.error("❌ Wallet debit error:", error?.message || "0 rows updated");
    return null;
  }
  return Number(data.balance);
}`,
`/**
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
}`,
'debitWallet RPC');

// 4. creditWallet -> atomic RPC
rep(`/**
 * Refunds [amount] to [userId]'s wallet when an order was debited but Bigisub
 * rejected it. Returns the new balance, or null when the credit failed.
 */
async function creditWallet(userId, amount) {
  const wallet = await ensureWallet(userId);
  const balance = Number(wallet?.balance || 0);
  const newBalance = balance + amount;
  const { data, error } = await supabase
    .from("wallets")
    .update({ balance: newBalance })
    .eq("user_id", userId)
    .select("balance")
    .maybeSingle();
  if (error || !data) {
    console.error("❌ Wallet credit error:", error?.message || "0 rows updated");
    return null;
  }
  return Number(data.balance);
}`,
`/**
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
}`,
'creditWallet RPC');

// 5. Harden the Squad webhook: signature REQUIRED, credit only app-created
//    payment rows, atomic RPC credit, schema-correct transaction insert.
rep(`app.post("/api/v2/webhooks/squad", async (req, res) => {
  try {
    const payload = req.body;
    const bodyData = payload?.Body || payload?.data || payload;
    const txRef = payload?.TransactionRef || bodyData?.transaction_ref;
    const status = bodyData?.transaction_status || payload?.status;
    const email = bodyData?.email || payload?.email;
    const rawAmount = Number(bodyData?.amount || payload?.amount || 0);

    const amount = rawAmount > 100000 ? rawAmount / 100 : rawAmount;

    if (status !== "Success" && status !== "success" && payload?.Event !== "charge_successful") {
      return res.status(200).json({ success: true, message: "Ignored non-successful transaction" });
    }

    if (!email || !txRef || amount <= 0) {
      return res.status(200).json({ success: true, message: "Invalid payload parameters" });
    }

    const { data: existingTx } = await supabase.from("transactions").select("id").eq("reference", txRef).single();
    if (existingTx) {
      return res.status(200).json({ success: true, message: "Transaction already processed" });
    }

    const cleanEmail = email.trim();
    const { data: profiles, error: profErr } = await supabase.from("profiles").select("id").ilike("email", cleanEmail);
    if (profErr || !profiles || profiles.length === 0) {
      console.error("❌ Profile Lookup Failed:", profErr?.message || "No profile found");
      return res.status(404).json({ success: false, message: "User profile not found for email: " + cleanEmail });
    }

    const targetUserId = profiles[0].id;

    const { data: walletRow } = await supabase.from("wallets").select("balance").eq("user_id", targetUserId).single();
    const currentBalance = Number(walletRow?.balance || 0);
    const newBalance = currentBalance + amount;

    const { data: updatedWallet, error: updateErr } = await supabase
      .from("wallets")
      .update({ balance: newBalance })
      .eq("user_id", targetUserId)
      .select();

    if (updateErr || !updatedWallet || updatedWallet.length === 0) {
      console.error("❌ Wallet Update Error:", updateErr?.message || "0 rows updated");
      return res.status(500).json({ success: false, message: "Failed to update wallet row" });
    }

    await supabase.from("transactions").insert({
      user_id: targetUserId,
      type: "deposit",
      amount: amount,
      balance_before: currentBalance,
      balance_after: newBalance,
      reference: txRef,
      status: "success",
      description: "Automated Virtual Account Topup via Squad"
    });

    console.log("✅ Wallet funded: " + cleanEmail + " +₦" + amount + " (New Balance: ₦" + newBalance + ")");
    return res.json({ success: true, message: "Wallet funded successfully", wallet_data: updatedWallet[0] });
  } catch (err) {
    console.error("❌ Squad Webhook Exception:", err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});`,
`app.post("/api/v2/webhooks/squad", async (req, res) => {
  // SECURITY: this endpoint must NEVER credit a wallet without proof the
  // webhook came from Squad. The HMAC-SHA512 signature over the RAW body is
  // that proof (the raw bytes are captured by the express.json verify hook
  // above — re-serializing req.body would break the HMAC). The app's live
  // funding flow uses the Supabase squad-webhook edge function; this route
  // is kept for compatibility and must enforce the same rules.
  try {
    const squadSecret = process.env.SQUAD_SECRET_KEY || process.env.SQUADCO_SECRET_KEY || "";
    const signature = req.get("x-squad-signature") || "";
    const rawBody = (req.rawBody || Buffer.from("")).toString("utf8");

    if (!squadSecret || !signature || !rawBody) {
      console.error("❌ Squad Webhook: missing secret/signature/body");
      return res.status(401).json({ success: false, message: "Missing signature" });
    }

    const computed = crypto.createHmac("sha512", squadSecret).update(rawBody).digest("hex");
    if (computed !== signature) {
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
});`,
'squad webhook hardened');

// 6. requestUserId: authenticate via the Supabase session token instead of
//    trusting the client-sent x-user-id header. Anyone with a leaked userId
//    could previously spend that user's wallet and route the purchase to
//    their own phone. The Android app now sends Authorization: Bearer <jwt>.
rep(`function requestUserId(req) {
  return req.get("x-user-id") || req.body.userId || req.body.user_id || null;
}`,
`async function requestUserId(req) {
  const token = (req.get("authorization") || "").replace(/^Bearer\\s+/i, "").trim();
  if (!token) return null;
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user.id;
}`,
'requestUserId token auth');

// 7. Await the now-async identity resolution in all 6 purchase endpoints.
rep(`    const userId = requestUserId(req);`,
`    const userId = await requestUserId(req);`,
'await requestUserId x6');

if (hadCRLF) src = src.replace(/\n/g, '\r\n');
fs.writeFileSync(target, src);
console.log('server.js patched (RPC stage): ' + target);
