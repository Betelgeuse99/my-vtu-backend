// admin edge function — port of every Express /api/v2/admin/* route.
// Deployed with verify_jwt = true; the dashboard sends the admin's Supabase
// access token. Every route is gated by requireAdmin() (is_admin profile).
//
// Paths (after /functions/v1/admin):
//   GET  /stats                    GET  /users
//   GET  /stats/charts             POST /wallet/adjust
//   GET  /providers                GET  /transactions
//   POST /providers/route          POST /transactions/reconcile
//   GET  /keycheck                 POST /transactions/refund
//   GET  /plans/bigisub            POST /plans/update-price
//   GET  /plans/alrahuz

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { handleCors, json, routePath, queryParams } from "../_shared/cors.ts";
import { getSupabase } from "../_shared/supabase.ts";
import {
  requireAdmin,
  AdminError,
} from "../_shared/helpers.ts";
import { bigiClient } from "../_shared/providers/bigisub.ts";
import * as alrahuz from "../_shared/providers/alrahuz.ts";
import { reconcilePending, refundPendingTx } from "../_shared/reconcile.ts";

const VALID_PROVIDERS = ["bigisub", "alrahuz"];
const VALID_SERVICES = ["airtime", "data", "cable", "electricity", "epin", "recharge_pin"];
const DEFAULT_ROUTES = {
  airtime: "bigisub",
  data: "bigisub",
  cable: "bigisub",
  electricity: "bigisub",
  epin: "bigisub",
  recharge_pin: "bigisub",
};

let _statsBalanceCache: { data: any; ts: number } | null = null;
const STATS_BALANCE_TTL_MS = 60_000;

serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const path = routePath(req);
    const method = req.method;

    let admin: any;
    try {
      admin = await requireAdmin(req);
    } catch (e: any) {
      if (e instanceof AdminError) {
        return json({ success: false, message: e.message }, e.status);
      }
      throw e;
    }

    const body = ["POST", "PUT", "PATCH"].includes(method)
      ? await req.json().catch(() => ({}))
      : {};

    switch (`${method} ${path}`) {
      case "GET /keycheck":
        return await keycheck();
      case "GET /stats":
        return await stats();
      case "GET /stats/charts":
        return await statsCharts();
      case "GET /providers":
        return await providers();
      case "POST /providers/route":
        return await providersRoute(body, admin);
      case "GET /users":
        return await users(req);
      case "POST /wallet/adjust":
        return await walletAdjust(body, admin);
      case "GET /transactions":
        return await transactions(req);
      case "GET /cac":
        return await cacSubmissions(req);
      case "POST /cac/delete":
        return await cacDelete(body);
      case "POST /transactions/reconcile":
        return await reconcile(body);
      case "POST /transactions/refund":
        return await refund(body, admin);
      case "POST /plans/update-price":
        return await updatePlanPrice(body, admin);
      case "GET /plans/bigisub":
        return await plansBigisub(req);
      case "GET /plans/alrahuz":
        return await plansAlrahuz(req);
      default:
        return json({ success: false, message: "Not found" }, 404);
    }
  } catch (err: any) {
    console.error("❌ Admin error:", err.message);
    return json({ success: false, message: err.message }, 500);
  }
});

async function keycheck() {
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const fp = key.slice(-12);
  let role = "unknown";
  try {
    role = JSON.parse(atob(key.split(".")[1])).role || "unknown";
  } catch {
    role = "malformed";
  }

  let raw: any = null;
  try {
    const r = await fetch(`${Deno.env.get("SUPABASE_URL")}/rest/v1/transactions?select=id`, {
      headers: { apikey: key, Authorization: "Bearer " + key },
      signal: AbortSignal.timeout(15000),
    });
    const rows = await r.json();
    raw = {
      status: r.status,
      rows: Array.isArray(rows) ? rows.length : null,
      content_range: r.headers.get("content-range") || null,
    };
  } catch (e: any) {
    raw = { error: e?.response?.status || e.message };
  }

  return json({
    success: true,
    url_host: (() => {
      try {
        return new URL(Deno.env.get("SUPABASE_URL")!).host;
      } catch {
        return null;
      }
    })(),
    key_fingerprint: fp,
    key_role: role,
    raw_postgrest_transactions: raw,
    probes: {},
  });
}

async function fetchBalances() {
  let bigisubBalance = 0;
  let alrahuzBalance = 0;
  const [bigiResult, alrahuzResult] = await Promise.allSettled([
    (async () => {
      try {
        const r = await bigiClient.get("/api/v2/financial/wallet/balance/", { timeoutMs: 6000 });
        return Number((r.data as any)?.data?.balance ?? (r.data as any)?.balance ?? 0);
      } catch {
        try {
          const r = await bigiClient.get("/api/v2/balance/", { timeoutMs: 6000 });
          return Number((r.data as any)?.balance ?? (r.data as any)?.data?.balance ?? 0);
        } catch {
          const r = await bigiClient.get("/api/balance/", { timeoutMs: 6000 });
          const body = r.data as any;
          const raw = body?.balance ?? body?.data?.balance ?? (typeof body === "number" ? body : 0);
          return Number(raw) || 0;
        }
      }
    })(),
    (async () => {
      try {
        return await alrahuz.getBalance();
      } catch {
        return 0;
      }
    })(),
  ]);
  if (bigiResult.status === "fulfilled") bigisubBalance = bigiResult.value;
  if (alrahuzResult.status === "fulfilled") alrahuzBalance = alrahuzResult.value;
  return { bigisub: Number(bigisubBalance.toFixed(2)), alrahuz: Number(alrahuzBalance.toFixed(2)) };
}

async function stats() {
  try {
    let balances;
    const now = Date.now();
    if (_statsBalanceCache && now - _statsBalanceCache.ts < STATS_BALANCE_TTL_MS) {
      balances = _statsBalanceCache.data;
    } else {
      balances = await fetchBalances();
      _statsBalanceCache = { data: balances, ts: now };
    }

    let activeRoutes: Record<string, string> = { ...DEFAULT_ROUTES };
    try {
      const { data: routes } = await getSupabase().from("provider_routing").select("service, provider");
      if (routes) routes.forEach((r: any) => { activeRoutes[r.service] = r.provider; });
    } catch (e: any) {
      console.warn("⚠️ Could not fetch provider_routing (table may not exist yet):", e.message);
    }

    const [usersRes, walletRes, txRes, revenueRes] = await Promise.all([
      getSupabase().from("profiles").select("id", { count: "exact", head: true }),
      getSupabase().from("wallets").select("balance"),
      getSupabase().from("transactions").select("id", { count: "exact", head: true }),
      getSupabase().from("transactions").select("amount").eq("status", "successful"),
    ]);

    const totalUsers = usersRes.count || 0;
    const totalTransactions = txRes.count || 0;
    const totalLiability = (walletRes.data || []).reduce((sum: number, w: any) => sum + Number(w.balance || 0), 0);
    const totalRevenue = (revenueRes.data || []).reduce((sum: number, t: any) => sum + Number(t.amount || 0), 0);

    return json({
      success: true,
      data: {
        balances,
        active_routes: activeRoutes,
        total_registered_users: totalUsers,
        total_transactions: totalTransactions,
        total_wallet_liability: Number(totalLiability.toFixed(2)),
        total_revenue: Number(totalRevenue.toFixed(2)),
      },
    });
  } catch (err: any) {
    console.error("❌ Admin stats error:", err.message);
    return json({ success: false, message: err.message }, 500);
  }
}

async function statsCharts() {
  try {
    const since = new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString();
    const { data: rows, error } = await getSupabase()
      .from("transactions")
      .select("service_type, provider, status, amount, created_at")
      .gte("created_at", since);
    if (error) throw error;

    const dayMap: Record<string, any> = {};
    const days: any[] = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000);
      const key = d.toISOString().slice(0, 10);
      dayMap[key] = { date: key, count: 0, amount: 0 };
      days.push(dayMap[key]);
    }

    const byService: Record<string, any> = {};
    const byProvider: Record<string, any> = {};
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

    return json({
      success: true,
      data: {
        daily: days,
        byService: Object.values(byService).sort((a: any, b: any) => b.count - a.count),
        byProvider: Object.values(byProvider).sort((a: any, b: any) => b.count - a.count),
        totals,
      },
    });
  } catch (err: any) {
    console.error("❌ Admin charts error:", err.message);
    return json({ success: false, message: err.message }, 500);
  }
}

async function providers() {
  try {
    const routes: Record<string, string> = { ...DEFAULT_ROUTES };
    try {
      const { data } = await getSupabase().from("provider_routing").select("service, provider");
      if (data) data.forEach((r: any) => { routes[r.service] = r.provider; });
    } catch {
      // Table may not exist yet
    }
    return json({ success: true, data: routes });
  } catch (err: any) {
    console.error("❌ Admin providers error:", err.message);
    return json({ success: false, message: err.message }, 500);
  }
}

async function providersRoute(body: any, admin: any) {
  try {
    const { global_provider, service, provider } = body;

    if (global_provider) {
      if (!VALID_PROVIDERS.includes(global_provider)) {
        return json({ success: false, message: "Invalid provider. Use 'bigisub' or 'alrahuz'." }, 400);
      }
      try {
        for (const svc of VALID_SERVICES) {
          await getSupabase()
            .from("provider_routing")
            .upsert({ service: svc, provider: global_provider, updated_at: new Date().toISOString() }, { onConflict: "service" });
        }
      } catch {
        for (const svc of VALID_SERVICES) {
          await getSupabase().from("provider_routing").delete().eq("service", svc).catch(() => {});
          await getSupabase().from("provider_routing").insert({ service: svc, provider: global_provider }).catch(() => {});
        }
      }
      console.log(`✅ Global provider switch: all services → ${global_provider} (by ${admin.email})`);
      return json({ success: true, message: `All services switched to ${global_provider}` });
    }

    if (service && provider) {
      if (!VALID_SERVICES.includes(service)) {
        return json({ success: false, message: `Invalid service. Use one of: ${VALID_SERVICES.join(", ")}` }, 400);
      }
      if (!VALID_PROVIDERS.includes(provider)) {
        return json({ success: false, message: "Invalid provider. Use 'bigisub' or 'alrahuz'." }, 400);
      }
      try {
        await getSupabase()
          .from("provider_routing")
          .upsert({ service, provider, updated_at: new Date().toISOString() }, { onConflict: "service" });
      } catch {
        await getSupabase().from("provider_routing").delete().eq("service", service).catch(() => {});
        await getSupabase().from("provider_routing").insert({ service, provider }).catch(() => {});
      }
      console.log(`✅ Provider route: ${service} → ${provider} (by ${admin.email})`);
      return json({ success: true, message: `${service} switched to ${provider}` });
    }

    return json({ success: false, message: "Provide either global_provider or (service + provider)" }, 400);
  } catch (err: any) {
    console.error("❌ Admin provider route error:", err.message);
    return json({ success: false, message: err.message }, 500);
  }
}

async function users(req: Request) {
  try {
    const q = queryParams(req);
    const page = Math.max(1, parseInt(q.get("page") || "1") || 1);
    const limit = Math.min(100, Math.max(1, parseInt(q.get("limit") || "20") || 20));
    const search = (q.get("search") || "").trim();
    const offset = (page - 1) * limit;

    let query = getSupabase()
      .from("profiles")
      .select("id, full_name, email, phone_number, is_admin, role, created_at", { count: "exact" })
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (search) {
      query = query.or(`full_name.ilike.%${search}%,email.ilike.%${search}%,phone_number.ilike.%${search}%`);
    }

    const { data: users, count, error } = await query;
    if (error) throw error;

    const userIds = (users || []).map((u: any) => u.id);
    let wallets: any[] = [];
    if (userIds.length) {
      const { data: w } = await getSupabase().from("wallets").select("user_id, balance").in("user_id", userIds);
      wallets = w || [];
    }
    const walletMap: Record<string, number> = {};
    wallets.forEach((w: any) => { walletMap[w.user_id] = Number(w.balance || 0); });

    const enriched = (users || []).map((u: any) => ({
      ...u,
      wallet_balance: walletMap[u.id] || 0,
    }));

    return json({
      success: true,
      data: enriched,
      pagination: { page, limit, total: count || 0, totalPages: Math.ceil((count || 0) / limit) },
    });
  } catch (err: any) {
    console.error("❌ Admin users error:", err.message);
    return json({ success: false, message: err.message }, 500);
  }
}

async function walletAdjust(body: any, admin: any) {
  try {
    const { target_user_id, amount, action, reason } = body;

    if (!target_user_id) return json({ success: false, message: "target_user_id is required" }, 400);
    if (!amount || Number(amount) <= 0) return json({ success: false, message: "amount must be a positive number" }, 400);
    if (!["credit", "debit"].includes(action)) return json({ success: false, message: "action must be 'credit' or 'debit'" }, 400);
    if (!reason || !reason.trim()) return json({ success: false, message: "reason is required for wallet adjustments" }, 400);

    const amt = Number(amount);
    const rpcName = action === "credit" ? "credit_wallet" : "debit_wallet";
    const { data: newBalance, error } = await getSupabase().rpc(rpcName, {
      p_user_id: target_user_id,
      p_amount: amt,
      p_description: `Admin ${action}: ${reason.trim()} (by ${admin.email})`,
    });

    if (error || newBalance === null || newBalance === undefined) {
      return json({ success: false, message: error?.message || "Wallet adjustment failed" }, 400);
    }

    try {
      await getSupabase().from("transactions").insert({
        user_id: target_user_id,
        title: `Admin ${action === "credit" ? "Credit" : "Debit"}`,
        service_type: "admin_adjust",
        amount: amt,
        recipient: admin.email,
        status: "successful",
        reference: `ADMIN-${Date.now()}`,
      });
    } catch (txErr: any) {
      console.warn("⚠️ Admin adjust audit insert failed:", txErr.message);
    }

    console.log(`✅ Admin ${action}: ${target_user_id} ${action === "credit" ? "+" : "-"}₦${amt} by ${admin.email} (${reason})`);
    return json({ success: true, message: `Wallet ${action}ed successfully`, new_balance: newBalance });
  } catch (err: any) {
    console.error("❌ Admin wallet adjust error:", err.message);
    return json({ success: false, message: err.message }, 500);
  }
}

async function transactions(req: Request) {
  try {
    const q = queryParams(req);
    const page = Math.max(1, parseInt(q.get("page") || "1") || 1);
    const limit = Math.min(100, Math.max(1, parseInt(q.get("limit") || "25") || 25));
    const offset = (page - 1) * limit;
    const statusFilter = (q.get("status") || "").trim();
    const typeFilter = (q.get("service_type") || "").trim();
    const search = (q.get("search") || "").trim();

    let query = getSupabase()
      .from("transactions")
      .select("*", { count: "exact" })
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(offset, offset + limit - 1);

    if (statusFilter) query = query.eq("status", statusFilter);
    if (typeFilter) query = query.eq("service_type", typeFilter);

    if (search) {
      const clean = search.replace(/[(),"'\\]/g, " ").replace(/\s+/g, " ").trim();
      if (clean) {
        const { data: profs } = await getSupabase()
          .from("profiles")
          .select("id")
          .or(`email.ilike.%${clean}%,phone_number.ilike.%${clean}%`)
          .limit(200);
        const ids = (profs || []).map((p: any) => p.id).filter(Boolean);
        const conds = [`recipient.ilike.%${clean}%`];
        if (ids.length) conds.push(`user_id.in.(${ids.join(",")})`);
        query = query.or(conds.join(","));
      }
    }

    const { data: txns, count, error } = await query;
    if (error) throw error;

    const userIds = [...new Set((txns || []).map((t: any) => t.user_id).filter(Boolean))];
    const profileMap: Record<string, any> = {};
    if (userIds.length) {
      const { data: profs } = await getSupabase()
        .from("profiles")
        .select("id, full_name, email")
        .in("id", userIds);
      (profs || []).forEach((p: any) => { profileMap[p.id] = p; });
    }

    const enriched = (txns || []).map((t: any) => ({
      ...t,
      profiles: profileMap[t.user_id] || null,
    }));

    return json({
      success: true,
      data: enriched,
      pagination: { page, limit, total: count || 0, totalPages: Math.ceil((count || 0) / limit) },
    });
  } catch (err: any) {
    console.error("❌ Admin transactions error:", err.message);
    return json({ success: false, message: err.message }, 500);
  }
}

async function reconcile(body: any) {
  try {
    const { transaction_id } = body;
    if (!transaction_id) return json({ success: false, message: "transaction_id is required" }, 400);

    const { data: tx, error } = await getSupabase()
      .from("transactions")
      .select("*")
      .eq("id", transaction_id)
      .maybeSingle();
    if (error || !tx) return json({ success: false, message: "Transaction not found" }, 404);
    if (tx.status !== "pending") {
      return json({ success: false, message: "Only pending transactions can be reconciled" }, 400);
    }

    const r = await reconcilePending(tx);

    if (r.verdict === "delivered") {
      await getSupabase().from("transactions").update({ status: "successful" }).eq("id", tx.id);
      return json({ success: true, action: "marked_successful", message: "Provider confirmed delivery — charge kept", detail: r.orderId });
    }

    if (r.verdict === "failed" || r.verdict === "absent") {
      const refund = await refundPendingTx(tx);
      if (refund.refunded) {
        return json({ success: true, action: "refunded", message: `Refunded ₦${Number(tx.amount).toLocaleString()} (delivery not confirmed)` });
      }
      return json({ success: false, action: "refund_failed", message: refund.error || "Refund failed" }, 500);
    }

    return json({
      success: false,
      action: "unresolved",
      message: "Could not verify delivery against the provider — leave pending or refund manually.",
      detail: r.error || r.orderId || null,
    });
  } catch (err: any) {
    console.error("❌ Admin reconcile error:", err.message);
    return json({ success: false, message: err.message }, 500);
  }
}

async function refund(body: any, admin: any) {
  try {
    const { transaction_id, reason } = body;

    if (!transaction_id) return json({ success: false, message: "transaction_id is required" }, 400);
    if (!reason || !reason.trim()) return json({ success: false, message: "reason is required for refunds" }, 400);

    const { data: tx, error: txErr } = await getSupabase()
      .from("transactions")
      .select("*")
      .eq("id", transaction_id)
      .maybeSingle();
    if (txErr || !tx) return json({ success: false, message: "Transaction not found" }, 404);
    if (tx.status === "refunded") return json({ success: false, message: "Transaction already refunded" }, 400);

    const refundAmount = Number(tx.amount);
    if (!refundAmount || refundAmount <= 0) {
      return json({ success: false, message: "Invalid transaction amount" }, 400);
    }

    const { data: newBalance, error: creditErr } = await getSupabase().rpc("credit_wallet", {
      p_user_id: tx.user_id,
      p_amount: refundAmount,
      p_description: `Refund: ${reason.trim()} (by ${admin.email})`,
    });
    if (creditErr || newBalance === null || newBalance === undefined) {
      return json({ success: false, message: creditErr?.message || "Failed to credit wallet" }, 500);
    }

    await getSupabase().from("transactions").update({ status: "refunded" }).eq("id", transaction_id);

    try {
      await getSupabase().from("transactions").insert({
        user_id: tx.user_id,
        title: `Refund: ${tx.title}`,
        service_type: "refund",
        amount: refundAmount,
        recipient: admin.email,
        status: "successful",
        reference: `REFUND-${Date.now()}`,
      });
    } catch (insErr: any) {
      console.warn("⚠️ Refund audit insert failed:", insErr.message);
    }

    console.log(`✅ Refund: user ${tx.user_id} +₦${refundAmount} for tx ${transaction_id} by ${admin.email}`);
    return json({ success: true, message: "Refund processed successfully", new_balance: newBalance });
  } catch (err: any) {
    console.error("❌ Admin refund error:", err.message);
    return json({ success: false, message: err.message }, 500);
  }
}

async function updatePlanPrice(body: any, admin: any) {
  try {
    const { plan_id, retail_price, is_active, alrahuz_retail_price } = body;

    if (!plan_id) return json({ success: false, message: "plan_id is required" }, 400);

    const updates: Record<string, unknown> = {};
    if (retail_price !== undefined && retail_price !== null) updates.retail_price = Number(retail_price);
    if (alrahuz_retail_price !== undefined) {
      updates.alrahuz_retail_price = alrahuz_retail_price === null ? null : Number(alrahuz_retail_price);
    }
    if (is_active !== undefined) updates.is_active = Boolean(is_active);
    if (Object.keys(updates).length === 0) {
      return json({ success: false, message: "No fields to update" }, 400);
    }
    updates.updated_at = new Date().toISOString();

    const { data, error } = await getSupabase()
      .from("data_plans")
      .update(updates)
      .eq("id", plan_id)
      .select()
      .maybeSingle();

    if (error) throw error;
    if (!data) return json({ success: false, message: "Plan not found" }, 404);

    console.log(`✅ Plan ${plan_id} updated by ${admin.email}:`, updates);
    return json({ success: true, message: "Plan updated successfully", data });
  } catch (err: any) {
    console.error("❌ Admin plan update error:", err.message);
    return json({ success: false, message: err.message }, 500);
  }
}

async function plansBigisub(req: Request) {
  try {
    const appNetId = Number(queryParams(req).get("network")) || null;
    let query = getSupabase()
      .from("data_plans")
      .select("*")
      .not("bigi_plan_id", "is", null)
      .eq("is_active", true)
      .order("retail_price", { ascending: true });
    if (appNetId) query = query.eq("network_id", appNetId);
    const { data: plans, error } = await query;
    if (error) throw error;
    const formatted = (plans || [])
      .filter((p: any) => /^\d+$/.test(String(p.bigi_plan_id)))
      .map((p: any) => ({
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
    return json({ success: true, provider: "bigisub", data: formatted });
  } catch (err: any) {
    console.error("❌ Bigisub plans fetch error:", err.message);
    return json({ success: false, message: err.message, data: [] }, 500);
  }
}

async function plansAlrahuz(req: Request) {
  try {
    const appNetId = Number(queryParams(req).get("network")) || null;
    let query = getSupabase()
      .from("data_plans")
      .select("*")
      .not("alrahuz_plan_id", "is", null)
      .eq("is_active", true)
      .order("retail_price", { ascending: true });
    if (appNetId) query = query.eq("network_id", appNetId);
    const { data: plans, error } = await query;
    if (error) throw error;
    const formatted = (plans || []).map((p: any) => ({
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
    return json({ success: true, provider: "alrahuz", data: formatted });
  } catch (err: any) {
    console.error("❌ Alrahuz plans fetch error:", err.message);
    return json({ success: false, message: err.message, data: [] }, 500);
  }
}

// ---------------------------------------------------------------------------
// CAC business-registration submissions (admin)
// cac_submissions has RLS that hides other users' rows from a normal token.
// These run with the service-role client, so the admin sees EVERY submission
// (web users AND the Android app) and can delete them. The dashboard calls
// these through the admin edge function instead of raw PostgREST.
// ---------------------------------------------------------------------------
async function cacSubmissions(req: Request) {
  try {
    const q = queryParams(req);
    const limit = Math.min(1000, Math.max(1, parseInt(q.get("limit") || "200") || 200));
    const { data, error } = await getSupabase()
      .from("cac_submissions")
      .select("*")
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(limit);
    if (error) throw error;
    return json({ success: true, data: data || [] });
  } catch (err: any) {
    console.error("❌ Admin CAC list error:", err.message);
    return json({ success: false, message: err.message, data: [] }, 500);
  }
}

async function cacDelete(body: any) {
  try {
    const id = Number(body?.id);
    if (!id || Number.isNaN(id)) {
      return json({ success: false, message: "A numeric submission id is required" }, 400);
    }
    const { error, count } = await getSupabase()
      .from("cac_submissions")
      .delete({ count: "exact" })
      .eq("id", id);
    if (error) throw error;
    if (!count) return json({ success: false, message: "Submission not found" }, 404);
    return json({ success: true, message: "Submission deleted" });
  } catch (err: any) {
    console.error("❌ Admin CAC delete error:", err.message);
    return json({ success: false, message: err.message }, 500);
  }
}
