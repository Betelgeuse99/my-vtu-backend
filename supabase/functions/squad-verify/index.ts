// squad-verify edge function — makes wallet funding reliable even when the
// Squad webhook is delayed or lost.
//
// The app creates a payments row (status=pending), opens the Squad checkout,
// and only the squad-webhook flips it to "success". If that webhook never
// arrives, a user is charged but not credited. This endpoint lets the app
// (or an admin, or the cron) check Squad's own transaction API by reference
// and credit the wallet idempotently when the charge DID succeed.
//
// Security: deployed with verify_jwt = true (see config.toml). A user may only
// verify their OWN payment; admins may verify any. Crediting goes through the
// same atomic claim + credit_wallet RPC as the webhook, so it can never
// double-credit.
//
// POST /squad-verify   body: { "reference": "..." }
//   -> { success:true,  verified:true,   newBalance }   (credited now)
//   -> { success:true,  verified:true,   alreadyProcessed:true } (already credited)
//   -> { success:false, verified:false,  status:"pending"|"failed"|"unknown" }
//   -> { success:false, verified:false,  message }       (error — keep pending)

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { handleCors, json } from "../_shared/cors.ts";
import { getSupabase } from "../_shared/supabase.ts";
import { getUserFromReq } from "../_shared/helpers.ts";
import {
  squadMethodLabel,
  verifyPaymentWithSquad,
  claimAndCreditPayment,
} from "../_shared/squad.ts";

serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (req.method !== "POST") return json({ success: false, message: "Method not allowed" }, 405);

  try {
    const body = await req.json().catch(() => ({}));
    const reference = String(body.reference || "").trim();
    if (!reference) return json({ success: false, verified: false, message: "reference required" }, 400);

    const caller = await getUserFromReq(req);
    if (!caller) return json({ success: false, verified: false, message: "Authentication required" }, 401);

    const { data: payment, error: paymentError } = await getSupabase()
      .from("payments")
      .select("*")
      .eq("reference", reference)
      .maybeSingle();
    if (paymentError || !payment) {
      return json({ success: false, verified: false, message: "Payment not found" }, 404);
    }

    // Ownership: only the payer or an admin may verify a payment.
    if (payment.user_id !== caller.id) {
      const { data: profile } = await getSupabase()
        .from("profiles")
        .select("is_admin, role")
        .eq("id", caller.id)
        .maybeSingle();
      const isAdmin = profile && (profile.is_admin === true || profile.role === "admin");
      if (!isAdmin) {
        return json({ success: false, verified: false, message: "Forbidden" }, 403);
      }
    }

    // Already credited (webhook won the race)? Idempotent happy path.
    if (payment.status === "success") {
      return json({ success: true, verified: true, alreadyProcessed: true, message: "Payment already confirmed" });
    }

    const amount = Number(payment.amount);
    if (!amount || amount <= 0) {
      return json({ success: false, verified: false, message: "Invalid payment amount" }, 500);
    }

    const squad = await verifyPaymentWithSquad(reference);
    if (!squad.ok) {
      // Network / API hiccup — do NOT guess. Leave pending; the poll retries.
      console.error("❌ squad-verify lookup failed:", reference, squad.message);
      return json({ success: false, verified: false, status: "unknown", message: squad.message });
    }

    if (!squad.successful) {
      // Squad says not yet successful (pending / failed / reversed / not found).
      const status = ["failed", "reversed", "cancelled", "timeout"].includes(squad.status) ? "failed" : "pending";
      return json({ success: false, verified: false, status, message: `Payment not confirmed (${squad.status || "pending"})` });
    }

    // Squad confirms the charge succeeded — credit (atomic + idempotent).
    const description = `${squadMethodLabel(payment.payment_method)} funding via Squad - Verified (${reference})`;
    const result = await claimAndCreditPayment(payment, amount, description, "squad-verify");

    if (result.alreadyProcessed) {
      return json({ success: true, verified: true, alreadyProcessed: true, message: "Payment already confirmed" });
    }
    if (!result.ok) {
      console.error("❌ squad-verify credit failed:", reference, result.error);
      return json({ success: false, verified: false, message: result.error }, 500);
    }

    console.log(`✅ squad-verify credited: user=${payment.user_id} ref=${reference} new_balance=₦${result.newBalance}`);
    return json({
      success: true,
      verified: true,
      newBalance: result.newBalance,
      message: "Payment confirmed",
    });
  } catch (err: any) {
    console.error("❌ squad-verify error:", err.message);
    return json({ success: false, verified: false, message: "Internal error" }, 500);
  }
});
