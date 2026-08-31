// Shared business helpers — faithful ports of the pure/DB helpers from the
// Node Express server (server.js), so edge functions behave identically.

import { getSupabase } from "./supabase.ts";

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Bigisub network id from an app slug/id (1=MTN, 2=AIRTEL, 3=GLO, 4=9MOBILE app registry). */
export function getNetworkId(net: string | number | undefined | null): number {
  const map: Record<string, number> = {
    "1": 1, "mtn": 1,
    "2": 3, "glo": 2,
    "3": 2, "airtel": 3,
    "4": 4, "9mobile": 4, "eti": 4,
  };
  return map[String(net || "").toLowerCase().trim()] || 1;
}

/** Canonical carrier ("MTN"/"GLO"/"AIRTEL"/"9MOBILE") for transactions.provider. */
export function canonicalNetworkName(net: string | number | undefined | null): string | null {
  const map: Record<string, string> = {
    "1": "MTN", "mtn": "MTN",
    "2": "AIRTEL", "airtel": "AIRTEL",
    "3": "GLO", "glo": "GLO",
    "4": "9MOBILE", "9mobile": "9MOBILE", "eti": "9MOBILE",
  };
  return map[String(net || "").toLowerCase().trim()] || null;
}

export function getCableCode(provider: string | undefined | null): string {
  const clean = String(provider || "").toLowerCase().trim();
  if (clean.includes("gotv")) return "gotv";
  if (clean.includes("dstv")) return "dstv";
  if (clean.includes("star")) return "startimes";
  if (clean.includes("show")) return "showmax";
  return clean;
}

export function cableDisplayName(provider: string | undefined | null): string {
  const clean = String(provider || "").toLowerCase().trim();
  if (clean.includes("gotv")) return "GOTV";
  if (clean.includes("dstv")) return "DSTV";
  if (clean.includes("star")) return "STARTIMES";
  if (clean.includes("show")) return "SHOWMAX";
  return String(provider || "").trim().toUpperCase();
}

export function formatLocalPhone(phone: string | number | undefined | null): string {
  let clean = String(phone || "").replace(/[^0-9]/g, "");
  if (clean.startsWith("234") && clean.length > 10) clean = "0" + clean.slice(3);
  else if (clean.length === 10 && !clean.startsWith("0")) clean = "0" + clean;
  return clean;
}

export function formatSquadGender(g: string | undefined | null): string {
  const clean = String(g || "").toLowerCase().trim();
  if (clean === "female" || clean === "f" || clean === "2") return "2";
  return "1";
}

export function newTxRef(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(3));
  const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
  return `${prefix}-${Date.now()}-${hex}`;
}

/** Active provider for [service] from provider_routing (default bigisub). */
export async function getActiveProvider(service: string): Promise<"bigisub" | "alrahuz"> {
  try {
    const { data } = await getSupabase()
      .from("provider_routing")
      .select("provider")
      .eq("service", service)
      .maybeSingle();
    return data?.provider === "alrahuz" ? "alrahuz" : "bigisub";
  } catch {
    return "bigisub";
  }
}

export function effectiveRetailPrice(planRow: any, provider: string): number {
  if (provider === "alrahuz") {
    const override = Number(planRow.alrahuz_retail_price);
    if (override > 0) return override;
  }
  return Number(planRow.retail_price || 0);
}

/** Resolves a plan ref (uuid | bigisub id | alrahuz id) to the data_plans row. */
export async function findPlanRow(planRef: string | number): Promise<any | null> {
  const ref = String(planRef).trim();
  const supabase = getSupabase();
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

export function planProviderId(planRow: any, provider: string): string | null {
  if (!planRow) return null;
  if (provider === "alrahuz") {
    return planRow.alrahuz_plan_id ? String(planRow.alrahuz_plan_id) : null;
  }
  const id = String(planRow.bigi_plan_id || "");
  return /^\d+$/.test(id) ? id : null;
}

/** Idempotent write to the transactions ledger (mirrors server.js logTx). */
export async function logTx(args: {
  user_id: string;
  title?: string;
  service_type?: string;
  amount?: number;
  recipient?: string;
  status?: string;
  reference?: string | null;
  provider?: string | null;
}): Promise<void> {
  const { user_id, title, service_type, amount, recipient, status, reference, provider } = args;
  try {
    const supabase = getSupabase();
    const ref = reference || null;
    if (ref) {
      const { data: existing } = await supabase
        .from("transactions")
        .select("id")
        .eq("user_id", user_id)
        .eq("reference", ref)
        .maybeSingle();
      if (existing) {
        const patch: Record<string, unknown> = { status: status || "successful" };
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
  } catch (err: any) {
    if (reference && err?.code === "23505") {
      try {
        const supabase = getSupabase();
        const { data: existing } = await supabase
          .from("transactions")
          .select("id")
          .eq("user_id", user_id)
          .eq("reference", reference)
          .maybeSingle();
        if (existing) {
          const patch: Record<string, unknown> = { status: status || "successful" };
          if (provider) patch.provider = provider;
          await supabase.from("transactions").update(patch).eq("id", existing.id);
        }
      } catch (e2: any) {
        console.warn("⚠️ transactions idempotent-repatch failed:", e2.message);
      }
      return;
    }
    console.warn("⚠️ transactions log failed:", err.message);
  }
}

export async function ensureWallet(userId: string) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("wallets")
    .select("balance")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  if (data) return data;
  const { data: created, error: insertError } = await supabase
    .from("wallets")
    .insert({ user_id: userId, balance: 0 })
    .select("balance")
    .single();
  if (insertError) throw insertError;
  return created;
}

export async function walletShortfallMessage(userId: string, amount: number): Promise<string | null> {
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

/** Atomic debit via the debit_wallet RPC. Returns new balance or null. */
export async function debitWallet(userId: string, amount: number): Promise<number | null> {
  const { data, error } = await getSupabase().rpc("debit_wallet", {
    p_user_id: userId,
    p_amount: amount,
  });
  if (error || data === null || data === undefined) {
    console.error("❌ Wallet debit error:", error?.message || "0 rows updated");
    return null;
  }
  return Number(data);
}

/** Atomic credit via the credit_wallet RPC. Returns new balance or null. */
export async function creditWallet(userId: string, amount: number): Promise<number | null> {
  const { data, error } = await getSupabase().rpc("credit_wallet", {
    p_user_id: userId,
    p_amount: amount,
  });
  if (error || data === null || data === undefined) {
    console.error("❌ Wallet credit error:", error?.message || "0 rows updated");
    return null;
  }
  return Number(data);
}

/** Resolves the signed-in user from the Authorization bearer token (Supabase JWT). */
export async function getUserFromReq(req: Request): Promise<any | null> {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  const { data, error } = await getSupabase().auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user;
}

export async function requestUserId(req: Request): Promise<string | null> {
  const user = await getUserFromReq(req);
  return user ? user.id : null;
}

export class AdminError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Admin gate — returns the admin user or throws AdminError (mirrors requireAdmin). */
export async function requireAdmin(req: Request): Promise<any> {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) throw new AdminError(401, "No token provided");

  const { data, error } = await getSupabase().auth.getUser(token);
  if (error || !data?.user) throw new AdminError(401, "Invalid or expired token");

  const { data: profile } = await getSupabase()
    .from("profiles")
    .select("is_admin, role")
    .eq("id", data.user.id)
    .maybeSingle();

  if (!profile || (profile.is_admin !== true && profile.role !== "admin")) {
    throw new AdminError(403, "Admin access required");
  }
  return data.user;
}

// ---------------------------------------------------------------------------
// Provider response inspection (bigiFailed / bigiPending / bigiErrorMessage)
// ---------------------------------------------------------------------------
const FAILURE_KEY_HINTS = ["success", "status", "error", "code", "status_code", "statuscode", "api_response", "detail", "message"];
const FAILURE_VALUE_HINTS = ["false", "0", "no", "failed", "error", "failure", "fail", "declined", "cancelled", "invalid"];
const PENDING_VALUE_HINTS = ["pending", "processing", "queued", "waiting", "in_progress", "in progress", "submitted", "running"];

export function bigiFailed(node: any, depth = 0): boolean {
  if (!node || depth > 3) return false;
  if (typeof node === "string") return FAILURE_VALUE_HINTS.includes(node.toLowerCase());
  if (typeof node !== "object" || Array.isArray(node)) return false;

  const isFailureValue = (v: unknown) => {
    if (v === false) return true;
    if (typeof v === "number") return v >= 400;
    if (typeof v === "string") return FAILURE_VALUE_HINTS.includes(v.toLowerCase());
    return false;
  };

  for (const key of Object.keys(node)) {
    const lk = key.toLowerCase();
    if (!FAILURE_KEY_HINTS.includes(lk)) continue;
    const v = node[key];
    if (lk === "error" && v) return true;
    if (isFailureValue(v)) return true;
  }

  const nested = node.data;
  if (nested && typeof nested === "object") {
    if (Array.isArray(nested)) return nested.some((item) => bigiFailed(item, depth + 1));
    return bigiFailed(nested, depth + 1);
  }
  return false;
}

export function bigiPending(node: any, depth = 0): boolean {
  if (!node || depth > 3) return false;
  if (typeof node === "string") return PENDING_VALUE_HINTS.includes(node.toLowerCase());
  if (typeof node !== "object" || Array.isArray(node)) return false;

  const isPendingValue = (v: unknown) => {
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
    if (Array.isArray(nested)) return nested.some((item) => bigiPending(item, depth + 1));
    return bigiPending(nested, depth + 1);
  }
  return false;
}

export function bigiErrorMessage(data: any, fallback: string): string {
  return (
    data?.message ||
    data?.detail ||
    data?.api_response ||
    (typeof data?.error === "string" ? data.error : data?.error?.message) ||
    fallback
  );
}
