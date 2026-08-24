const fs = require('fs');
const path = require('path');

const target = process.argv[2];
if (!target) { console.error('Usage: node patch-backend.js <path-to-server.js>'); process.exit(1); }

let src = fs.readFileSync(target, 'utf8');
const hadCRLF = src.includes('\r\n');
if (hadCRLF) src = src.replace(/\r\n/g, '\n');

function rep(oldS, newS, label) {
  const count = src.split(oldS).length - 1;
  if (count === 0) { console.error('MISS [' + label + ']'); process.exit(1); }
  src = src.split(oldS).join(newS);
  console.log('OK [' + label + '] x' + count);
}

// 1. Helpers: getWallet -> walletShortfallMessage -> debitWallet -> creditWallet
rep(`async function getWallet(userId) {
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
 * Returns a user-facing error message when [userId]'s wallet cannot cover
 * [amount], or null when the purchase may proceed. This MUST stay enforced
 * server-side — the app-side check is only a UX nicety.
 */
async function walletShortfallMessage(userId, amount) {
  const wallet = await getWallet(userId);
  if (!wallet) return "Wallet not found. Please fund your wallet first.";
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
 * Debits [amount] from [userId]'s wallet AFTER Bigisub confirms the order was
 * fulfilled. Returns the new balance, or null when the debit failed (the order
 * still went through — log it loudly for manual reconciliation).
 */
async function debitWallet(userId, amount) {
  const wallet = await getWallet(userId);
  const balance = Number(wallet?.balance || 0);
  const newBalance = balance - amount;
  const { data, error } = await supabase
    .from("wallets")
    .update({ balance: newBalance })
    .eq("user_id", userId)
    .select()
    .single();
  if (error || !data) {
    console.error("❌ Wallet debit error:", error?.message || "0 rows updated");
    return null;
  }
  return Number(data.balance);
}`,
`async function getWallet(userId) {
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
}`,
'helpers');

// 2. All 6 endpoints: insert debit BEFORE fulfillment (right after shortfall check)
rep(`    const shortfall = await walletShortfallMessage(userId, price);
    if (shortfall) {
      return res.status(400).json({ success: false, message: shortfall });
    }`,
`    const shortfall = await walletShortfallMessage(userId, price);
    if (shortfall) {
      return res.status(400).json({ success: false, message: shortfall });
    }

    // Debit FIRST so an order can never be delivered without charging the
    // user. Refunded automatically if Bigisub rejects the order below.
    const newBalance = await debitWallet(userId, price);
    if (newBalance === null) {
      return res.status(400).json({ success: false, message: "Could not debit your wallet. Please try again." });
    }`,
'shortfall+debit x6');

// 3. Refund inside the 5 "purchase" bigiFailed blocks
rep(`    if (bigiFailed(response.data)) {
      return res.status(400).json({
        success: false,
        message: bigiErrorMessage(response.data, "Bigisub rejected this purchase")
      });
    }`,
`    if (bigiFailed(response.data)) {
      // Order was not fulfilled — refund the debit.
      await creditWallet(userId, price);
      return res.status(400).json({
        success: false,
        message: bigiErrorMessage(response.data, "Bigisub rejected this purchase")
      });
    }`,
'bigiFailed purchase x5');

// 4. Refund inside the electricity "payment" bigiFailed block
rep(`    if (bigiFailed(response.data)) {
      return res.status(400).json({
        success: false,
        message: bigiErrorMessage(response.data, "Bigisub rejected this payment")
      });
    }`,
`    if (bigiFailed(response.data)) {
      // Order was not fulfilled — refund the debit.
      await creditWallet(userId, price);
      return res.status(400).json({
        success: false,
        message: bigiErrorMessage(response.data, "Bigisub rejected this payment")
      });
    }`,
'bigiFailed payment x1');

// 5. Remove the now-duplicate old debit blocks after fulfillment (per endpoint)
// NOTE: the inner text must start AND end with a double-quote (the original
// line is console.error("log=" + userId + " amount=" + price); — the closing
// quote belongs to the " amount=" segment, so we must NOT wrap it again.
const oldDebit = (inner) => `    const newBalance = await debitWallet(userId, price);
    if (newBalance === null) {
      console.error(${inner});
    }`;
rep(oldDebit('"\u{1F6A8} AIRTIME FULFILLED WITHOUT DEBIT \u2014 userId=" + userId + " amount=" + price'), '', 'remove old airtime debit');
rep(oldDebit('"\u{1F6A8} DATA PURCHASE FULFILLED WITHOUT DEBIT \u2014 userId=" + userId + " plan=" + numericPlanId + " amount=" + price'), '', 'remove old data debit');
rep(oldDebit('"\u{1F6A8} CABLE PURCHASE FULFILLED WITHOUT DEBIT \u2014 userId=" + userId + " amount=" + price'), '', 'remove old cable debit');
rep(oldDebit('"\u{1F6A8} ELECTRICITY FULFILLED WITHOUT DEBIT \u2014 userId=" + userId + " amount=" + price'), '', 'remove old electricity debit');
rep(oldDebit('"\u{1F6A8} RECHARGE PIN FULFILLED WITHOUT DEBIT \u2014 userId=" + userId + " amount=" + price'), '', 'remove old recharge debit');
rep(oldDebit('"\u{1F6A8} EXAM PIN FULFILLED WITHOUT DEBIT \u2014 userId=" + userId + " amount=" + price'), '', 'remove old exam debit');

if (hadCRLF) src = src.replace(/\n/g, '\r\n');
fs.writeFileSync(target, src);
console.log('server.js patched: ' + target);
