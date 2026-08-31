import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

/**
 * Service-role client for DB writes / admin auth. Mirror of the Node backend:
 * the service key bypasses RLS and powers every purchase, refund and admin op.
 */
let _supabase: ReturnType<typeof createClient> | null = null;
export function getSupabase() {
  if (!_supabase) {
    const url = Deno.env.get("SUPABASE_URL")!;
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set");
    _supabase = createClient(url, key);
  }
  return _supabase;
}

/**
 * Dedicated client for INTERACTIVE auth (signInWithPassword / refreshSession).
 * The Node backend used a separate client because supabase-js stores sessions
 * internally and rewrites the Authorization header — sharing one client made
 * every query run as the last-logged-in user, hiding rows behind RLS. Edge
 * Function isolates are short-lived so the risk is lower, but keep the split
 * for exact parity.
 */
let _supabaseAuth: ReturnType<typeof createClient> | null = null;
export function getSupabaseAuth() {
  if (!_supabaseAuth) {
    const url = Deno.env.get("SUPABASE_URL")!;
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    _supabaseAuth = createClient(url, key);
  }
  return _supabaseAuth;
}
