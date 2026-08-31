// PENDING-ORDER RECONCILIATION (safe auto-refund) — shared by the `admin`
// function (manual reconcile/refund) and the `reconcile` cron function.
//
// A pending transaction means the wallet was debited but the provider's
// outcome was unknown (timeout/5xx). We NEVER refund without proof it was
// not delivered — that would hand out free service. We reconcile against the
// provider's own order history:
//   delivered  -> mark successful (keep the charge)
//   failed     -> auto-refund (credit wallet + log refund audit row)
//   absent     -> the provider never created the order -> safe to refund
//   unknown    -> leave pending for the admin to decide

import { getSupabase } from "./supabase.ts";
import { getActiveProvider, creditWallet, logTx, newTxRef } from "./helpers.ts";
import * as alrahuz from "./providers/alrahuz.ts";

export async function reconcilePending(tx: any): Promise<any> {
  const svc = String(tx.service_type || "").toLowerCase();
  if (svc !== "data" && svc !== "airtime") return { verdict: "unsupported" };

  const provider = await getActiveProvider(svc === "data" ? "data" : "airtime");
  if (provider !== "alrahuz") {
    return { verdict: "unsupported", reason: "reconciliation only wired for Alrahuz" };
  }

  try {
    const { matches, order } = await alrahuz.queryRecentOrder({
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
  } catch (e: any) {
    return { verdict: "error", error: e.message };
  }
}

export async function refundPendingTx(tx: any): Promise<any> {
  const newBalance = await creditWallet(tx.user_id, Number(tx.amount));
  if (newBalance === null) return { refunded: false, error: "Wallet credit failed" };

  await getSupabase().from("transactions").update({ status: "refunded" }).eq("id", tx.id);
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
