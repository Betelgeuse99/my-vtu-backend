// reconcile edge function — the every-2-minutes auto-reconcile job that the
// Node server ran with node-cron. Triggered by pg_cron → pg_net (see
// supabase/migrations/*_schedule_reconcile.sql), NOT by a timer here.
//
// Security: deployed with verify_jwt = false, so it is protected by the
// `x-reconcile-key` header, which the pg_cron job sends. Anyone who hits the
// public URL without that header gets 401 — they cannot trigger refunds.
//
// Behavior (mirrors server.js cron): reconcile pending transactions (debited,
// outcome unknown) within the last hour against the provider's order history.
// Refund ONLY when the provider confirms the order FAILED — never on a guess.
// A delivered order is flipped to successful; absent/unknown stays pending so
// the admin can decide.

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { handleCors, json } from "../_shared/cors.ts";
import { getSupabase } from "../_shared/supabase.ts";
import { reconcilePending, refundPendingTx } from "../_shared/reconcile.ts";

serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (req.method !== "POST") return json({ success: false, message: "Method not allowed" }, 405);

  const expected = Deno.env.get("RECONCILE_KEY") || "";
  const supplied = req.headers.get("x-reconcile-key") || "";
  if (!expected || supplied !== expected) {
    return json({ success: false, message: "Unauthorized" }, 401);
  }

  const started = Date.now();
  // Supabase kills an edge function after 150s. Each provider lookup can take
  // up to its request timeout, so a large pending batch would blow past the
  // cap. We cap the batch AND stop processing once a hard time budget is used,
  // leaving the rest for the next 2-min run.
  const BATCH_LIMIT = 5;
  const BUDGET_MS = 90_000;
  const results = { scanned: 0, refunded: 0, markedSuccessful: 0, skipped: 0, errors: [] as string[] };

  try {
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { data: pending, error } = await getSupabase()
      .from("transactions")
      .select("*")
      .eq("status", "pending")
      .gte("created_at", since)
      .limit(BATCH_LIMIT);

    if (error) throw error;
    if (!pending || pending.length === 0) {
      return json({ ok: true, results, ms: Date.now() - started });
    }
    results.scanned = pending.length;

    for (const tx of pending) {
      if (Date.now() - started > BUDGET_MS) {
        console.warn("⏱️ Reconcile hit time budget — deferring remaining pending transactions");
        results.skipped++;
        continue;
      }
      try {
        const r = await reconcilePending(tx);
        if (r.verdict === "failed") {
          const refund = await refundPendingTx(tx);
          if (refund.refunded) {
            results.refunded++;
            console.log(`✅ Auto-reconcile refund (confirmed failed): ${tx.reference} -> refunded ₦${tx.amount}`);
          } else {
            results.errors.push(`${tx.reference}: refund failed ${refund.error || ""}`);
          }
        } else if (r.verdict === "delivered") {
          await getSupabase().from("transactions").update({ status: "successful" }).eq("id", tx.id);
          results.markedSuccessful++;
          console.log(`ℹ️ Auto-reconcile delivered (charge kept): ${tx.reference}`);
        } else {
          results.skipped++;
        }
      } catch (e: any) {
        results.errors.push(`${tx.reference}: ${e.message}`);
      }
    }

    return json({ ok: true, results, ms: Date.now() - started });
  } catch (e: any) {
    console.error("❌ Auto-reconcile job error:", e.message);
    return json({ ok: false, error: e.message, results, ms: Date.now() - started }, 500);
  }
});
