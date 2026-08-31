// Shared Squad payment-verification + wallet-credit logic used by the
// squad-verify edge function. Mirrors the guarantees of the squad-webhook:
//   - ATOMIC CLAIM: flip payments.status to "success" only when still pending,
//     so exactly one delivery (webhook OR verify) credits the wallet.
//   - credit_wallet RPC (SECURITY DEFINER) is the idempotent, race-free credit.
//   - The transactions history row is upserted on (user_id, reference).

import { getSupabase } from "./supabase.ts";
import { requestJson } from "./net.ts";

export function squadMethodLabel(m: string): string {
  const v = (m || "").toLowerCase();
  if (v.includes("transfer")) return "Bank Transfer";
  if (v.includes("card")) return "Card";
  if (v.includes("ussd")) return "USSD";
  if (v.includes("bank")) return "Bank Transfer";
  return m || "Card";
}

/** Squad API base + secret (same resolution as the wallet virtual-account flow). */
export function squadConfig(): { base: string; secret: string } {
  const secret = Deno.env.get("SQUADCO_SECRET_KEY") || Deno.env.get("SQUAD_SECRET_KEY") || "";
  let base = Deno.env.get("SQUAD_BASE_URL") ||
    (secret.includes("_test_") ? "https://sandbox-api-d.squadco.com" : "https://api-d.squadco.com");
  base = base.trim().replace(/\/+$/, "");
  return { base, secret };
}

/**
 * Asks Squad whether [reference] was charged successfully. Tries the documented
 * verify endpoint, then the transaction lookup endpoint as a fallback.
 * Returns { ok:false, message } on network/API errors (keep pending), or
 * { ok:true, successful, status, data } on a definitive answer.
 */
export async function verifyPaymentWithSquad(reference: string) {
  const { base, secret } = squadConfig();
  if (!secret) return { ok: false, message: "Squad not configured" };

  const endpoints = [
    `/transaction/verify/${encodeURIComponent(reference)}`,
    `/transaction/${encodeURIComponent(reference)}`,
  ];

  for (const ep of endpoints) {
    try {
      const res = await requestJson(base + ep, {
        headers: { Authorization: "Bearer " + secret },
        timeoutMs: 15000,
      });
      const body = res.data as any;
      const data = body?.data || body || {};
      const raw = String(
        data.transaction_status || data.transactionStatus || data.status ||
        body.transaction_status || data.Event || body.Event || "",
      ).toLowerCase();
      const successful = [
        "success", "successful", "settled", "paid", "completed",
        "processed", "delivered", "charge_successful", "1",
      ].includes(raw);
      return { ok: true, successful, status: raw, data };
    } catch (e: any) {
      if (e?.response?.status === 404) continue; // try the fallback endpoint
      return {
        ok: false,
        message: e?.response?.data?.message || e?.response?.data?.detail || e.message,
      };
    }
  }
  return { ok: false, message: "Could not verify transaction with Squad" };
}

/**
 * ATOMIC claim + credit + history row. Call only after Squad confirms the
 * charge succeeded. Idempotent: a concurrent webhook or a second verify call
 * sees the row already claimed and stops.
 */
export async function claimAndCreditPayment(
  payment: any,
  amount: number,
  description: string,
  source: string,
) {
  const supabase = getSupabase();

  const { data: claimed, error: claimError } = await supabase
    .from("payments")
    .update({ status: "success", squad_response: { credited_by: source, verified_at: new Date().toISOString() } })
    .eq("id", payment.id)
    .eq("status", "pending")
    .select("id")
    .maybeSingle();

  if (claimError) return { ok: false, error: "Failed to claim payment" };
  if (!claimed) return { ok: false, alreadyProcessed: true };

  const { data: newBalance, error: creditError } = await supabase.rpc("credit_wallet", {
    p_user_id: payment.user_id,
    p_amount: amount,
    p_description: description,
  });

  if (creditError || newBalance === null || newBalance === undefined) {
    // Revert the claim so a retry (webhook or verify) can still process it.
    await supabase.from("payments").update({ status: "pending" }).eq("id", payment.id).eq("status", "success");
    return { ok: false, error: "Failed to credit wallet" };
  }

  try {
    await supabase.from("transactions").upsert(
      {
        user_id: payment.user_id,
        title: "Wallet Funding",
        service_type: "funding",
        amount,
        recipient: "Squad",
        status: "successful",
        reference: payment.reference,
      },
      { onConflict: "user_id, reference", ignoreDuplicates: true },
    );
  } catch (txErr: any) {
    console.error("transactions upsert failed:", payment.reference, txErr.message);
  }

  return { ok: true, newBalance };
}
