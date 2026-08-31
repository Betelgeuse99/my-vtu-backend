// vtu edge function — port of every Express /api/v2/vtu/* and /api/v2/bills/*
// route. Deployed with verify_jwt = false (mirrors the Express server, which
// had no gateway auth): catalog GETs need no token, purchases authenticate
// per-route via the app's Supabase access token (requestUserId -> 401).
//
// Paths (after /functions/v1/vtu):
//   GET  /data/plans                    GET  /cable/plans
//   POST /data/purchase                 POST /cable/verify
//   POST /airtime/purchase              POST /cable/purchase
//   GET  /recharge-pin/plans            POST /recharge-pin/purchase
//   GET  /bills/electricity/providers   POST /bills/electricity/verify
//   POST /bills/electricity/pay         GET  /bills/result-checker/prices
//   POST /bills/result-checker/purchase

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { handleCors, json, routePath, queryParams } from "../_shared/cors.ts";
import { getSupabase } from "../_shared/supabase.ts";
import {
  requestUserId,
  getNetworkId,
  canonicalNetworkName,
  getCableCode,
  cableDisplayName,
  getActiveProvider,
  effectiveRetailPrice,
  findPlanRow,
  planProviderId,
  logTx,
  newTxRef,
  walletShortfallMessage,
  debitWallet,
  creditWallet,
  bigiFailed,
  bigiPending,
  bigiErrorMessage,
} from "../_shared/helpers.ts";
import { bigiClient, DEFAULT_PIN } from "../_shared/providers/bigisub.ts";
import * as alrahuz from "../_shared/providers/alrahuz.ts";

serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const path = routePath(req);
    const method = req.method;
    const body = ["POST", "PUT", "PATCH"].includes(method)
      ? await req.json().catch(() => ({}))
      : {};

    // ---- CATALOG (no auth needed for reads) ----
    if (method === "GET" && path === "/data/plans") return await dataPlans(req);
    if (method === "GET" && path === "/cable/plans") return await cablePlans(req);
    if (method === "GET" && path === "/recharge-pin/plans") return await rechargePinPlans(req);
    if (method === "GET" && path === "/bills/electricity/providers") return await electricityProviders();
    if (method === "GET" && path === "/bills/result-checker/prices") return await resultCheckerPrices();

    // ---- PURCHASES / VERIFIES (auth required) ----
    if (method === "POST" && path === "/airtime/purchase") return await purchaseAirtime(req, body);
    if (method === "POST" && path === "/data/purchase") return await purchaseData(req, body);
    if (method === "POST" && path === "/cable/verify") return await verifyCable(req, body);
    if (method === "POST" && path === "/cable/purchase") return await purchaseCable(req, body);
    if (method === "POST" && path === "/recharge-pin/purchase") return await purchaseRechargePin(req, body);
    if (method === "POST" && path === "/bills/electricity/verify") return await verifyElectricity(req, body);
    if (method === "POST" && path === "/bills/electricity/pay") return await payElectricity(req, body);
    if (method === "POST" && path === "/bills/result-checker/purchase") return await purchaseResultChecker(req, body);

    return json({ success: false, message: "Not found" }, 404);
  } catch (err: any) {
    console.error("❌ vtu error:", err.message);
    return json({ success: false, message: err.message }, 500);
  }
});

// ---------------------------------------------------------------------------
// CATALOG
// ---------------------------------------------------------------------------

async function dataPlans(req: Request) {
  try {
    const appNetId = Number(queryParams(req).get("network")) || 1;
    const provider = await getActiveProvider("data");

    const { data: plans, error } = await getSupabase()
      .from("data_plans")
      .select("*")
      .eq("network_id", appNetId)
      .eq("is_active", true)
      .order("retail_price", { ascending: true });

    if (error) throw error;

    const formattedPlans = (plans || [])
      .map((p: any) => {
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
          amount: effPrice,
          plan_amount: effPrice,
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

    return json({ success: true, provider, data: formattedPlans });
  } catch (err: any) {
    console.error("❌ Data plans fetch error:", err.message);
    return json({ success: false, message: err.message, data: [] }, 500);
  }
}

async function cablePlans(req: Request) {
  try {
    const cableName = getCableCode(queryParams(req).get("cable_name") || queryParams(req).get("provider") || "gotv");
    const provider = await getActiveProvider("cable");
    let plans: unknown;
    if (provider === "alrahuz") {
      plans = await alrahuz.getCablePlans(cableName);
    } else {
      const response = await bigiClient.get("/api/v2/vtu/cable/plans/?cable_name=" + cableName);
      const data = response.data as any;
      plans = data?.data || (Array.isArray(data) ? data : []);
    }
    return json({ success: true, provider, data: plans });
  } catch (err: any) {
    return json({ success: false, message: err.message, data: [] }, 500);
  }
}

async function rechargePinPlans(req: Request) {
  try {
    const provider = await getActiveProvider("recharge_pin");
    let plans: unknown;
    if (provider === "alrahuz") {
      plans = alrahuz.getRechargePinPlans(queryParams(req).get("network") || undefined);
    } else {
      const netId = getNetworkId(queryParams(req).get("network"));
      const response = await bigiClient.get("/api/v2/vtu/recharge-pin/plans/?network=" + netId);
      const data = response.data as any;
      plans = data?.data || (Array.isArray(data) ? data : []);
    }
    return json({ success: true, provider, data: plans });
  } catch (err: any) {
    return json({ success: false, message: err.message, data: [] }, 500);
  }
}

async function electricityProviders() {
  try {
    const provider = await getActiveProvider("electricity");
    let data: unknown;
    if (provider === "alrahuz") {
      data = alrahuz.getDiscoList();
    } else {
      const response = await bigiClient.get("/api/v2/bills/electricity/providers/");
      const body = response.data as any;
      data = body?.data?.providers || body?.data || [];
    }
    return json({ success: true, provider, data });
  } catch (err: any) {
    return json({ success: false, message: err.message, data: [] }, 500);
  }
}

async function resultCheckerPrices() {
  try {
    // NOTE: Alrahuz has no result-checker price endpoint, so prices always come
    // from Bigisub (mirrors the original server).
    const response = await bigiClient.get("/api/v2/bills/result-checker/prices/");
    const body = response.data as any;
    const prices = body?.data?.prices || body?.data || [];
    return json({ success: true, data: prices });
  } catch (err: any) {
    return json({ success: false, message: err.message, data: [] }, 500);
  }
}

// ---------------------------------------------------------------------------
// PURCHASES
// ---------------------------------------------------------------------------

async function purchaseAirtime(req: Request, body: any) {
  const { network, phone_number, amount } = body;
  let debitCtx: { userId: string; price: number } | null = null;
  try {
    const userId = await requestUserId(req);
    if (!userId) return json({ success: false, message: "Authentication required" }, 401);

    const price = Number(amount) || 0;
    if (price <= 0) return json({ success: false, message: "Invalid amount" }, 400);

    const shortfall = await walletShortfallMessage(userId, price);
    if (shortfall) return json({ success: false, message: shortfall }, 400);

    const newBalance = await debitWallet(userId, price);
    if (newBalance === null) {
      return json({ success: false, message: "Could not debit your wallet. Please try again." }, 400);
    }
    debitCtx = { userId, price };
    const txRef = newTxRef("AIR");

    const provider = await getActiveProvider("airtime");

    let response: any;
    if (provider === "alrahuz") {
      response = await alrahuz.buyAirtime({
        network,
        mobile_number: String(phone_number).trim(),
        amount: price,
      });
    } else {
      response = (await bigiClient.post("/api/v2/vtu/airtime/purchase/", {
        network: getNetworkId(network),
        phone_number: String(phone_number).trim(),
        amount: String(amount),
        airtime_type: "vtu",
        pin: DEFAULT_PIN,
      })).data;
    }
    console.log("📦 AIRTIME raw response (" + provider + "):", JSON.stringify(response));

    if (bigiFailed(response)) {
      await creditWallet(userId, price);
      await logTx({
        user_id: userId,
        title: "Airtime ₦" + price + " — Failed",
        service_type: "airtime",
        amount: price,
        recipient: String(phone_number).trim(),
        status: "failed",
        reference: txRef,
        provider: canonicalNetworkName(network),
      });
      return json({
        success: false,
        message: bigiErrorMessage(response, provider === "alrahuz"
          ? "Alrahuzdata rejected this purchase"
          : "Bigisub rejected this purchase"),
      }, 400);
    }

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
        provider: canonicalNetworkName(network),
      });
      return json({
        success: true,
        status: "pending",
        message: "Your airtime request is being processed. It will deliver shortly.",
        data: response,
        balance: newBalance,
        reference: txRef,
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
      provider: canonicalNetworkName(network),
    });
    console.log("✅ Airtime (" + provider + "): user " + userId + " -₦" + price + " (balance ₦" + newBalance + ")");
    return json({ success: true, message: "Airtime top-up successful", data: response, balance: newBalance, reference: txRef });
  } catch (err: any) {
    console.error("❌ Airtime Error:", err?.response?.data || err.message);
    const provStatus = err?.response?.status || 0;
    if (provStatus >= 400 && provStatus < 500) {
      if (debitCtx) await creditWallet(debitCtx.userId, debitCtx.price);
      console.error("❌ Order rejected by provider:", err?.response?.data || err.message);
      return json({ success: false, message: bigiErrorMessage(err?.response?.data, err.message) }, 400);
    }
    console.error("⚠️ Order outcome uncertain:", err?.response?.data || err.message);
    if (debitCtx) {
      await logTx({
        user_id: debitCtx.userId,
        title: "Airtime — Outcome Pending",
        service_type: "airtime",
        amount: debitCtx.price,
        recipient: String(body.phone_number || "").trim(),
        status: "pending",
        reference: newTxRef("PEND"),
        provider: canonicalNetworkName(body.network),
      });
    }
    return json({
      success: true,
      message: "Request submitted — delivery may take a few minutes. If you don't receive it, contact support for a refund.",
    });
  }
}

async function purchaseData(req: Request, body: any) {
  const { network, plan, plan_id, phone_number } = body;
  let debitCtx: { userId: string; price: number } | null = null;
  try {
    const userId = await requestUserId(req);
    if (!userId) return json({ success: false, message: "Authentication required" }, 401);

    const targetPlan = plan || plan_id;
    if (!targetPlan) return json({ success: false, message: "Invalid or missing plan ID" }, 400);

    let provider = await getActiveProvider("data");
    const planRow = await findPlanRow(targetPlan);

    let fulfillProvider = provider;
    let providerPlanId = planProviderId(planRow, provider);
    if (!providerPlanId && planRow) {
      const other = provider === "alrahuz" ? "bigisub" : "alrahuz";
      const otherId = planProviderId(planRow, other);
      if (otherId) {
        fulfillProvider = other;
        providerPlanId = otherId;
        console.log(`ℹ️ Plan ${targetPlan} not on ${provider} — falling back to ${other}`);
      }
    }

    if (!fulfillProvider || !providerPlanId) {
      return json({ success: false, message: "Data plan not found or unavailable" }, 400);
    }

    let price = planRow ? effectiveRetailPrice(planRow, fulfillProvider) : 0;
    if (!(price > 0)) price = Number(body.amount) || 0;
    if (price <= 0) return json({ success: false, message: "Could not determine plan price" }, 400);

    const shortfall = await walletShortfallMessage(userId, price);
    if (shortfall) return json({ success: false, message: shortfall }, 400);

    const newBalance = await debitWallet(userId, price);
    if (newBalance === null) {
      return json({ success: false, message: "Could not debit your wallet. Please try again." }, 400);
    }
    debitCtx = { userId, price };
    const txRef = newTxRef(fulfillProvider === "alrahuz" ? "ALR" : "BIGI");

    let response: any;
    if (fulfillProvider === "alrahuz") {
      response = await alrahuz.buyData({
        network,
        mobile_number: String(phone_number).trim(),
        plan: Number(providerPlanId),
      });
    } else {
      response = (await bigiClient.post("/api/v2/vtu/data/purchase/", {
        network: getNetworkId(network),
        plan: Number(providerPlanId),
        phone_number: String(phone_number).trim(),
        pin: DEFAULT_PIN,
      })).data;
    }
    console.log(`📦 DATA raw response (${fulfillProvider}):`, JSON.stringify(response));

    if (bigiFailed(response)) {
      await creditWallet(userId, price);
      await logTx({
        user_id: userId,
        title: (planRow?.volume ? planRow.volume + " Data" : "Data Purchase") + " — Failed",
        service_type: "data",
        amount: price,
        recipient: String(phone_number).trim(),
        status: "failed",
        reference: txRef,
        provider: canonicalNetworkName(network),
      });
      return json({
        success: false,
        message: bigiErrorMessage(response, fulfillProvider === "alrahuz"
          ? "Alrahuzdata rejected this purchase"
          : "Bigisub rejected this purchase"),
      }, 400);
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
        provider: canonicalNetworkName(network),
      });
      return json({
        success: true,
        status: "pending",
        message: "Your data request is being processed. It will deliver shortly.",
        provider: fulfillProvider,
        reference: txRef,
        data: response,
        balance: newBalance,
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
      provider: canonicalNetworkName(network),
    });

    console.log("✅ Data purchase (" + fulfillProvider + "): user " + userId + " plan " + providerPlanId + " -₦" + price + " (balance ₦" + newBalance + ")");
    return json({
      success: true,
      message: "Data purchase successful",
      provider: fulfillProvider,
      reference: txRef,
      data: response,
      balance: newBalance,
    });
  } catch (err: any) {
    const provError = err?.response?.data;
    const provStatus = err?.response?.status || 0;
    if (provStatus >= 400 && provStatus < 500) {
      if (debitCtx) {
        await creditWallet(debitCtx.userId, debitCtx.price);
        await logTx({
          user_id: debitCtx.userId,
          title: "Data Purchase — Rejected",
          service_type: "data",
          amount: debitCtx.price,
          recipient: "",
          status: "failed",
          reference: newTxRef("FAIL"),
          provider: canonicalNetworkName(body.network),
        });
      }
      console.error("❌ Data rejected by provider:", JSON.stringify(provError || err.message, null, 2));
      return json({
        success: false,
        message: bigiErrorMessage(provError, err.message),
        errors: provError?.errors || null,
      }, provStatus);
    }
    console.error("⚠️ Data outcome uncertain:", JSON.stringify(provError || err.message, null, 2));
    if (debitCtx) {
      await logTx({
        user_id: debitCtx.userId,
        title: "Data Purchase — Outcome Pending",
        service_type: "data",
        amount: debitCtx.price,
        recipient: String(body.phone_number || "").trim(),
        status: "pending",
        reference: newTxRef("PEND"),
        provider: canonicalNetworkName(body.network),
      });
    }
    return json({
      success: true,
      message: "Data request submitted — delivery may take a few minutes. If you don't receive it, contact support for a refund.",
    });
  }
}

async function verifyCable(req: Request, body: any) {
  try {
    const provider = getCableCode(body.cable_name || body.provider || "gotv");
    const cardNo = String(body.card_no || body.smartCardNo || "").trim().replace(/\s+/g, "");

    if (!cardNo || cardNo.length < 8) {
      return json({ success: false, message: "Smartcard / IUC number must be at least 8 characters" }, 400);
    }

    const activeProvider = await getActiveProvider("cable");
    let verifyData: any = {};
    if (activeProvider === "alrahuz") {
      const code = alrahuz.cableCode(provider);
      if (code == null) {
        return json({ success: false, message: "Cable provider not supported on Alrahuzdata" }, 400);
      }
      const r: any = await alrahuz.validateIUC({ smart_card_number: cardNo, cablename: code });
      verifyData = r?.data || r || {};
    } else {
      const response = await bigiClient.post("/api/v2/vtu/cable/verify/", {
        cable_name: provider,
        card_no: cardNo,
      });
      verifyData = (response.data as any)?.data || {};
    }

    return json({
      success: true,
      message: "Verification successful",
      data: {
        customerName: verifyData.customer_name || verifyData.name || "VERIFIED CUSTOMER",
        currentBouquet: verifyData.current_bouquet || verifyData.bouquet || "",
        cardNumber: verifyData.card_number || cardNo,
        cableProvider: verifyData.cable_provider || provider,
      },
    });
  } catch (err: any) {
    return json({
      success: false,
      message: err?.response?.data?.message || err?.response?.data?.detail || "Customer account not found",
    }, 400);
  }
}

async function purchaseCable(req: Request, body: any) {
  const { cable_type, provider, card_no, phone_number, amount, Customer, customerName } = body;
  let debitCtx: { userId: string; price: number } | null = null;
  try {
    const userId = await requestUserId(req);
    if (!userId) return json({ success: false, message: "Authentication required" }, 401);

    const price = Number(amount) || 0;
    if (price <= 0) return json({ success: false, message: "Invalid amount" }, 400);

    const shortfall = await walletShortfallMessage(userId, price);
    if (shortfall) return json({ success: false, message: shortfall }, 400);

    const newBalance = await debitWallet(userId, price);
    if (newBalance === null) {
      return json({ success: false, message: "Could not debit your wallet. Please try again." }, 400);
    }
    debitCtx = { userId, price };
    const txRef = newTxRef("CBL");

    const activeProvider = await getActiveProvider("cable");

    let response: any;
    if (activeProvider === "alrahuz") {
      const cablenameCode = alrahuz.cableCode(cable_type || provider);
      if (cablenameCode == null || cablenameCode === 4) {
        await creditWallet(userId, price);
        return json({ success: false, message: "Cable provider not supported on Alrahuzdata" }, 400);
      }
      const plan = await alrahuz.resolveCablePlan(cable_type || provider, price);
      if (!plan) {
        await creditWallet(userId, price);
        return json({
          success: false,
          message: "Cable plan not found on Alrahuzdata — please refresh the plan list or route cable back to Bigisub",
        }, 400);
      }
      response = await alrahuz.buyCable({
        cablename: cablenameCode,
        cableplan: Number((plan as any).id),
        smart_card_number: String(card_no).trim(),
      });
    } else {
      response = (await bigiClient.post("/api/v2/vtu/cable/purchase/", {
        cable_type: getCableCode(cable_type || provider),
        card_no: String(card_no).trim(),
        phone_number: String(phone_number).trim(),
        amount: price,
        Customer: String(Customer || customerName).trim(),
        pin: DEFAULT_PIN,
      })).data;
    }
    console.log("📦 CABLE raw response (" + activeProvider + "):", JSON.stringify(response));

    if (bigiFailed(response)) {
      await creditWallet(userId, price);
      await logTx({
        user_id: userId,
        title: "Cable TV — Failed",
        service_type: "cable",
        amount: price,
        recipient: String(card_no).trim(),
        status: "failed",
        reference: txRef,
        provider: cableDisplayName(cable_type || provider),
      });
      return json({
        success: false,
        message: bigiErrorMessage(response, activeProvider === "alrahuz"
          ? "Alrahuzdata rejected this purchase"
          : "Bigisub rejected this purchase"),
      }, 400);
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
        provider: cableDisplayName(cable_type || provider),
      });
      return json({
        success: true,
        status: "pending",
        message: "Your cable subscription is being processed. It will deliver shortly.",
        data: response,
        balance: newBalance,
        reference: txRef,
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
      provider: cableDisplayName(cable_type || provider),
    });
    console.log("✅ Cable (" + activeProvider + "): user " + userId + " -₦" + price + " (balance ₦" + newBalance + ")");
    return json({ success: true, message: "Cable subscription successful", data: response, balance: newBalance, reference: txRef });
  } catch (err: any) {
    const provStatus = err?.response?.status || 0;
    if (provStatus >= 400 && provStatus < 500) {
      if (debitCtx) await creditWallet(debitCtx.userId, debitCtx.price);
      console.error("❌ Order rejected by provider:", err?.response?.data || err.message);
      return json({ success: false, message: bigiErrorMessage(err?.response?.data, err.message) }, 400);
    }
    console.error("⚠️ Order outcome uncertain:", err?.response?.data || err.message);
    return json({
      success: true,
      message: "Request submitted — delivery may take a few minutes. If you don't receive it, contact support for a refund.",
    });
  }
}

async function purchaseRechargePin(req: Request, body: any) {
  const { network, plan, quantity, card_name, name_on_card } = body;
  let debitCtx: { userId: string; price: number } | null = null;
  try {
    const userId = await requestUserId(req);
    if (!userId) return json({ success: false, message: "Authentication required" }, 401);

    const numericPlanId = Number(plan);
    const qty = Number(quantity) || 1;
    if (!plan || isNaN(numericPlanId)) {
      return json({ success: false, message: "Invalid or missing plan ID" }, 400);
    }

    const activeProvider = await getActiveProvider("recharge_pin");

    let unitPrice: number | null = null;
    if (activeProvider === "alrahuz") {
      unitPrice = alrahuz.resolveRechargePinAmount(network, numericPlanId);
    } else {
      const netId = getNetworkId(network);
      const plansRes = await bigiClient.get("/api/v2/vtu/recharge-pin/plans/?network=" + netId);
      const data = plansRes.data as any;
      const plans = data?.data || (Array.isArray(data) ? data : []);
      const planInfo = plans.find((p: any) => Number(p.id) === numericPlanId);
      unitPrice = Number(planInfo?.regular_price || planInfo?.corporate_price || 0);
    }
    const price = (unitPrice || 0) * qty;
    if (price <= 0) return json({ success: false, message: "Could not determine plan price" }, 400);

    const shortfall = await walletShortfallMessage(userId, price);
    if (shortfall) return json({ success: false, message: shortfall }, 400);

    const newBalance = await debitWallet(userId, price);
    if (newBalance === null) {
      return json({ success: false, message: "Could not debit your wallet. Please try again." }, 400);
    }
    debitCtx = { userId, price };
    const txRef = newTxRef("PIN");

    let response: any;
    if (activeProvider === "alrahuz") {
      response = await alrahuz.buyRechargePin({
        network,
        network_amount: numericPlanId,
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
        pin: DEFAULT_PIN,
      })).data;
    }
    console.log("📦 RECHARGE PIN raw response (" + activeProvider + "):", JSON.stringify(response));

    if (bigiFailed(response)) {
      await creditWallet(userId, price);
      await logTx({
        user_id: userId,
        title: "Recharge PINs — Failed",
        service_type: "recharge_pin",
        amount: price,
        recipient: String(network || "").trim(),
        status: "failed",
        reference: txRef,
        provider: canonicalNetworkName(network),
      });
      return json({
        success: false,
        message: bigiErrorMessage(response, activeProvider === "alrahuz"
          ? "Alrahuzdata rejected this purchase"
          : "Bigisub rejected this purchase"),
      }, 400);
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
        provider: canonicalNetworkName(network),
      });
      return json({
        success: true,
        status: "pending",
        message: "Your recharge PINs are being processed. They will deliver shortly.",
        data: response,
        balance: newBalance,
        reference: txRef,
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
      provider: canonicalNetworkName(network),
    });
    console.log("✅ Recharge PIN (" + activeProvider + "): user " + userId + " -₦" + price + " (balance ₦" + newBalance + ")");
    return json({ success: true, message: "Recharge PINs generated", data: response, balance: newBalance, reference: txRef });
  } catch (err: any) {
    const provStatus = err?.response?.status || 0;
    if (provStatus >= 400 && provStatus < 500) {
      if (debitCtx) await creditWallet(debitCtx.userId, debitCtx.price);
      console.error("❌ Order rejected by provider:", err?.response?.data || err.message);
      return json({ success: false, message: bigiErrorMessage(err?.response?.data, err.message) }, 400);
    }
    console.error("⚠️ Order outcome uncertain:", err?.response?.data || err.message);
    return json({
      success: true,
      message: "Request submitted — delivery may take a few minutes. If you don't receive it, contact support for a refund.",
    });
  }
}

async function verifyElectricity(req: Request, body: any) {
  try {
    const { company, meter_no, meter_type } = body;
    const activeProvider = await getActiveProvider("electricity");
    let verifyData: any = {};
    if (activeProvider === "alrahuz") {
      const discoId = alrahuz.discoIdForCode(company);
      if (discoId == null) {
        return json({ success: false, message: "Electricity provider not supported on Alrahuzdata" }, 400);
      }
      const r: any = await alrahuz.validateMeter({
        meternumber: String(meter_no).trim(),
        disconame: discoId,
        mtype: alrahuz.meterTypeCode(meter_type),
      });
      verifyData = r?.data || r || {};
    } else {
      const response = await bigiClient.post("/api/v2/bills/electricity/verify/", {
        company: String(company).trim(),
        meter_no: String(meter_no).trim(),
        meter_type: String(meter_type || "prepaid").trim(),
      });
      verifyData = (response.data as any)?.data || {};
    }
    return json({
      success: true,
      message: "Meter verified",
      data: {
        customerName: verifyData.customer_name || verifyData.name || "VERIFIED CUSTOMER",
        customerAddress: verifyData.customer_address || verifyData.address || "",
        meterNumber: verifyData.meter_number || meter_no,
      },
    });
  } catch (err: any) {
    return json({
      success: false,
      message: err?.response?.data?.message || "Electricity meter verification failed",
    }, 400);
  }
}

async function payElectricity(req: Request, body: any) {
  const { company, meter_no, meter_type, phone_number, amount, Customer_name, customerName } = body;
  let debitCtx: { userId: string; price: number } | null = null;
  try {
    const userId = await requestUserId(req);
    if (!userId) return json({ success: false, message: "Authentication required" }, 401);

    const price = Number(amount) || 0;
    if (price <= 0) return json({ success: false, message: "Invalid amount" }, 400);

    const shortfall = await walletShortfallMessage(userId, price);
    if (shortfall) return json({ success: false, message: shortfall }, 400);

    const newBalance = await debitWallet(userId, price);
    if (newBalance === null) {
      return json({ success: false, message: "Could not debit your wallet. Please try again." }, 400);
    }
    debitCtx = { userId, price };
    const txRef = newTxRef("ELEC");

    const activeProvider = await getActiveProvider("electricity");

    let response: any;
    if (activeProvider === "alrahuz") {
      const discoId = alrahuz.discoIdForCode(company);
      if (discoId == null) {
        await creditWallet(userId, price);
        return json({ success: false, message: "Electricity provider not supported on Alrahuzdata" }, 400);
      }
      response = await alrahuz.buyElectricity({
        disco_name: discoId,
        amount: price,
        meter_number: String(meter_no).trim(),
        MeterType: alrahuz.meterTypeCode(meter_type),
      });
    } else {
      response = (await bigiClient.post("/api/v2/bills/electricity/pay/", {
        company: String(company).trim(),
        meter_no: String(meter_no).trim(),
        meter_type: String(meter_type || "prepaid").trim(),
        phone_number: String(phone_number).trim(),
        amount: price,
        Customer_name: String(Customer_name || customerName || "").trim(),
        pin: DEFAULT_PIN,
      })).data;
    }
    console.log("📦 ELECTRICITY raw response (" + activeProvider + "):", JSON.stringify(response));

    if (bigiFailed(response)) {
      await creditWallet(userId, price);
      await logTx({
        user_id: userId,
        title: "Electricity — Failed",
        service_type: "electricity",
        amount: price,
        recipient: String(meter_no).trim(),
        status: "failed",
        reference: txRef,
        provider: String(company).trim().toUpperCase(),
      });
      return json({
        success: false,
        message: bigiErrorMessage(response, activeProvider === "alrahuz"
          ? "Alrahuzdata rejected this payment"
          : "Bigisub rejected this payment"),
      }, 400);
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
        provider: String(company).trim().toUpperCase(),
      });
      return json({
        success: true,
        status: "pending",
        message: "Your electricity payment is being processed. It will deliver shortly.",
        data: response,
        balance: newBalance,
        reference: txRef,
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
      provider: String(company).trim().toUpperCase(),
    });
    console.log("✅ Electricity (" + activeProvider + "): user " + userId + " -₦" + price + " (balance ₦" + newBalance + ")");
    const token = response?.data?.token || response?.token || null;
    return json({ success: true, message: "Electricity bill paid", data: response, token, balance: newBalance, reference: txRef });
  } catch (err: any) {
    const provStatus = err?.response?.status || 0;
    if (provStatus >= 400 && provStatus < 500) {
      if (debitCtx) await creditWallet(debitCtx.userId, debitCtx.price);
      console.error("❌ Order rejected by provider:", err?.response?.data || err.message);
      return json({ success: false, message: bigiErrorMessage(err?.response?.data, err.message) }, 400);
    }
    console.error("⚠️ Order outcome uncertain:", err?.response?.data || err.message);
    return json({
      success: true,
      message: "Request submitted — delivery may take a few minutes. If you don't receive it, contact support for a refund.",
    });
  }
}

async function purchaseResultChecker(req: Request, body: any) {
  const { exam, quantity, pin_code } = body;
  let debitCtx: { userId: string; price: number } | null = null;
  try {
    const userId = await requestUserId(req);
    if (!userId) return json({ success: false, message: "Authentication required" }, 401);

    const qty = Number(quantity) || 1;
    if (!exam) return json({ success: false, message: "Exam type is required" }, 400);

    // Price always from Bigisub (Alrahuz has no price endpoint) — mirrors original.
    const pricesRes = await bigiClient.get("/api/v2/bills/result-checker/prices/");
    const data = pricesRes.data as any;
    const prices = data?.data?.prices || data?.data || [];
    const examInfo = prices.find((p: any) => String(p.code || p.exam || "").toLowerCase() === String(exam).toLowerCase());
    const unitPrice = Number(examInfo?.amount || examInfo?.plan_amount || 0);
    const price = unitPrice * qty;
    if (price <= 0) return json({ success: false, message: "Could not determine exam price" }, 400);

    const shortfall = await walletShortfallMessage(userId, price);
    if (shortfall) return json({ success: false, message: shortfall }, 400);

    const newBalance = await debitWallet(userId, price);
    if (newBalance === null) {
      return json({ success: false, message: "Could not debit your wallet. Please try again." }, 400);
    }
    debitCtx = { userId, price };
    const txRef = newTxRef("EPIN");

    const activeProvider = await getActiveProvider("epin");

    let response: any;
    if (activeProvider === "alrahuz") {
      response = await alrahuz.buyEPin({
        exam_name: String(exam).trim(),
        quantity: qty,
      });
    } else {
      response = (await bigiClient.post("/api/v2/bills/result-checker/purchase/", {
        exam: String(exam).trim(),
        quantity: qty,
        pin_code: String(pin_code || DEFAULT_PIN).trim(),
      })).data;
    }
    console.log("📦 EXAM PIN raw response (" + activeProvider + "):", JSON.stringify(response));

    if (bigiFailed(response)) {
      await creditWallet(userId, price);
      await logTx({
        user_id: userId,
        title: "Exam PIN — Failed",
        service_type: "exam_pin",
        amount: price,
        recipient: String(exam).trim(),
        status: "failed",
        reference: txRef,
        provider: null,
      });
      return json({
        success: false,
        message: bigiErrorMessage(response, activeProvider === "alrahuz"
          ? "Alrahuzdata rejected this purchase"
          : "Bigisub rejected this purchase"),
      }, 400);
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
        provider: null,
      });
      return json({
        success: true,
        status: "pending",
        message: "Your exam PINs are being processed. They will deliver shortly.",
        data: response,
        balance: newBalance,
        reference: txRef,
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
      provider: null,
    });
    console.log("✅ Exam PIN (" + activeProvider + "): user " + userId + " -₦" + price + " (balance ₦" + newBalance + ")");
    const rawData = response?.data;
    const pins =
      response?.pins ||
      rawData?.pins ||
      (Array.isArray(rawData) ? rawData : []);
    return json({ success: true, message: "Exam PINs generated", data: response, pins, balance: newBalance, reference: txRef });
  } catch (err: any) {
    const provStatus = err?.response?.status || 0;
    if (provStatus >= 400 && provStatus < 500) {
      if (debitCtx) await creditWallet(debitCtx.userId, debitCtx.price);
      console.error("❌ Order rejected by provider:", err?.response?.data || err.message);
      return json({ success: false, message: bigiErrorMessage(err?.response?.data, err.message) }, 400);
    }
    console.error("⚠️ Order outcome uncertain:", err?.response?.data || err.message);
    return json({
      success: true,
      message: "Request submitted — delivery may take a few minutes. If you don't receive it, contact support for a refund.",
    });
  }
}


