// Alrahuzdata VTU API client — Deno port of services/alrahuz.js.
// Docs: https://documenter.getpostman.com/view/18957639/2s9YR6buRK
//
// Auth: Token header (Authorization: Token <API_KEY>)
// Base: https://alrahuzdata.com.ng/api/
//
// NOTE: there is NO plans-list endpoint on the API. Plan IDs live behind the
// website dashboard, so getDataPlans()/getCablePlans() log into the website
// with the web credentials (.env: ALRAHUZ_WEB_USER / ALRAHUZ_WEB_PASS) and
// scrape the same JSON/HTML endpoints the buy pages use (/ajax/load_plans/,
// /ajax/loadcableplans/). The scrape is faithful to the Node original.

import { requestJson, getSetCookie } from "../net.ts";

const ALRAHUZ_BASE = Deno.env.get("ALRAHUZ_BASE_URL") || "https://alrahuzdata.com.ng";
const ALRAHUZ_TOKEN = Deno.env.get("ALRAHUZ_API_TOKEN") || Deno.env.get("ALRAHUZ_TOKEN") || "";
const ALRAHUZ_WEB_USER = Deno.env.get("ALRAHUZ_WEB_USER") || "";
const ALRAHUZ_WEB_PASS = Deno.env.get("ALRAHUZ_WEB_PASS") || "";

function apiHeaders() {
  return { Authorization: "Token " + ALRAHUZ_TOKEN, "Content-Type": "application/json" };
}

const apiClient = {
  get: (
    path: string,
    opts: {
      query?: Record<string, string | number>;
      headers?: Record<string, string>;
      timeoutMs?: number;
    } = {},
  ) =>
    requestJson(ALRAHUZ_BASE + path, {
      headers: { ...apiHeaders(), ...(opts.headers || {}) },
      query: opts.query,
      timeoutMs: opts.timeoutMs ?? 30000,
    }),
  post: (path: string, body: unknown, extraHeaders?: Record<string, string>) =>
    requestJson(ALRAHUZ_BASE + path, {
      method: "POST",
      headers: { ...apiHeaders(), ...(extraHeaders || {}) },
      body,
    }),
};

// Network IDs on Alrahuzdata: 1=MTN, 2=GLO, 3=9MOBILE, 4=AIRTEL, 5=SMILE.
// The Android app's registry is 1=MTN, 2=AIRTEL, 3=GLO, 4=9MOBILE. This map
// translates the APP's ids into ALRAHUZ ids (see sync_alrahuz_plans.js).
export function getNetworkId(network: string | number | undefined | null): number {
  const map: Record<string, number> = {
    "1": 1, "mtn": 1,
    "2": 4, "airtel": 4,
    "3": 2, "glo": 2,
    "4": 3, "9mobile": 3, "eti": 3,
  };
  return map[String(network || "").toLowerCase().trim()] || 1;
}

export async function getBalance(): Promise<number> {
  const res = await apiClient.get("/api/user/", { timeoutMs: 6000 });
  const body = res.data as any;
  const inner = body?.user || body;
  return Number(inner?.wallet_balance ?? inner?.balance ?? 0);
}

// ---------------------------------------------------------------------
// Website session (cookie jar) — only needed for plan scraping
// ---------------------------------------------------------------------
type Jar = Record<string, string>;
let sessionCache: { jar: Jar; expires: number } | null = null;

function jarFromResponse(jar: Jar, headers: Headers): void {
  for (const sc of getSetCookie(headers)) {
    const pair = String(sc).split(";")[0] || "";
    const eq = pair.indexOf("=");
    if (eq > 0) jar[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
}

function cookieHeader(jar: Jar): string {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
}

async function getWebSession(): Promise<{ jar: Jar; expires: number }> {
  if (sessionCache && Date.now() < sessionCache.expires) return sessionCache;

  if (!ALRAHUZ_WEB_USER || !ALRAHUZ_WEB_PASS) {
    throw new Error("Alrahuz website credentials missing (ALRAHUZ_WEB_USER / ALRAHUZ_WEB_PASS)");
  }

  const jar: Jar = {};
  // followRedirect: false is essential — the login POST answers with a 302
  // that carries the sessionid cookie; following redirects automatically loses
  // it. okStatus < 400 keeps the 302 from being treated as an error.
  const loginPage = await requestJson(ALRAHUZ_BASE + "/login/", {
    headers: { "Content-Type": "application/json" },
    okStatus: (s) => s >= 200 && s < 400,
    followRedirect: false,
    timeoutMs: 30000,
  });
  jarFromResponse(jar, loginPage.headers);

  const csrf = String(loginPage.data || "").match(
    /name=['"]csrfmiddlewaretoken['"]\s+value=['"]([^'"]+)['"]/,
  )?.[1];
  if (!csrf) throw new Error("Could not read Alrahuz login CSRF token");

  const form = new URLSearchParams({
    csrfmiddlewaretoken: csrf,
    username: ALRAHUZ_WEB_USER,
    password: ALRAHUZ_WEB_PASS,
  });
  const loginRes = await requestJson(ALRAHUZ_BASE + "/login/", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: ALRAHUZ_BASE + "/login/",
      Cookie: cookieHeader(jar),
    },
    body: form.toString(),
    okStatus: (s) => s >= 200 && s < 400,
    followRedirect: false,
    timeoutMs: 30000,
  });
  jarFromResponse(jar, loginRes.headers);

  if (!jar.sessionid) {
    throw new Error("Alrahuz website login failed — check ALRAHUZ_WEB_USER / ALRAHUZ_WEB_PASS");
  }

  sessionCache = { jar, expires: Date.now() + 20 * 60 * 1000 };
  return sessionCache;
}

/**
 * Fetches Alrahuz data plans for [network] by scraping the logged-in site.
 * [network] is ALREADY an Alrahuz network id — do NOT route it through
 * getNetworkId() (that maps APP ids to Alrahuz ids). Returns BigiSub-shaped
 * rows so callers can treat both providers alike.
 */
export async function getDataPlans(network: string | number): Promise<Array<Record<string, unknown>>> {
  const netId = Number(network) || 1;
  const { jar } = await getWebSession();

  const res = await apiClient.get("/ajax/load_plans/", {
    query: { network: netId },
    headers: {
      Cookie: cookieHeader(jar),
      Referer: ALRAHUZ_BASE + "/data_Create/",
      "X-Requested-With": "XMLHttpRequest",
    },
  });

  const html = String(res.data || "");
  const plans: Array<Record<string, unknown>> = [];
  const optRe = /<option\s+([^>]*)>([\s\S]*?)<\/option>/gi;
  let m: RegExpExecArray | null;
  while ((m = optRe.exec(html)) !== null) {
    const attrs = m[1];
    const label = m[2].replace(/\s+/g, " ").trim();
    const idMatch = attrs.match(/value=["'](\d+)["']/i);
    if (!idMatch) continue;

    const plantype = (attrs.match(/plantype\s*=\s*["']([^"']+)["']/i)?.[1] || "SME").toUpperCase();
    const amount = Number((attrs.match(/amt\s*=\s*["'][^"']*?([\d][\d,.]*)["']/i)?.[1] || "").replace(/,/g, "")) ||
      Number((label.match(/[=]\s*[^=\d]*([\d][\d,.]*)/)?.[1] || "").replace(/,/g, ""));
    const sizeMatch = label.match(/^([\d.]+)\s*(GB|MB)/i);
    const validity = (label.match(/VALIDITY.*$/i)?.[0] ||
      label.split(/\d+\s*(?:DAYS?|HRS?|DAY)\b/i)[1] || "").replace(/^VALIDITY\s*/i, "").trim() ||
      (label.match(/((?:\d+\s*)?(?:DAYS?|HRS?|DAY)[^=]*)$/i)?.[1] || "").trim() || "30 DAYS";

    plans.push({
      id: idMatch[1],
      plan_id: Number(idMatch[1]),
      plantype,
      size: sizeMatch ? `${parseFloat(sizeMatch[1])}${sizeMatch[2].toUpperCase()}` : label.split(" ")[0],
      validity,
      amount,
      netname: attrs.match(/netname\s*=\s*["']([^"']+)["']/i)?.[1] || "",
    });
  }
  return plans;
}

export async function buyData(args: { network: string | number; mobile_number: string; plan: number; Ported_number?: boolean }) {
  const netId = getNetworkId(args.network);
  const res = await apiClient.post("/api/data/", {
    network: netId,
    mobile_number: String(args.mobile_number).trim(),
    plan: Number(args.plan),
    Ported_number: args.Ported_number ?? true,
  });
  return res.data;
}

// Carrier name (stored in transactions.provider) -> Alrahuz network id.
const CARRIER_TO_ALRAHUZ: Record<string, number> = { MTN: 1, GLO: 2, "9MOBILE": 3, AIRTEL: 4 };

/**
 * Queries the account's recent order history (data or airtime) for an order
 * matching the given phone (+ carrier/plan/amount when available) within the
 * last [minutes]. Used ONLY for SAFE reconciliation: refund only on a
 * definitive "failed", mark delivered only on definitive success — never guess.
 */
export async function queryRecentOrder(args: {
  service: string;
  mobile_number: string | null | undefined;
  amount?: number;
  carrier?: string | null;
  plan?: string | number | null;
  minutes?: number;
}): Promise<{ matches: Array<Record<string, unknown>>; order: Record<string, unknown> | null }> {
  const phone = String(args.mobile_number || "").replace(/[^0-9]/g, "");
  if (!phone) return { matches: [], order: null };

  let list: Array<Record<string, unknown>> = [];
  if (args.service === "data") {
    const r = await apiClient.get("/api/data/", { timeoutMs: 20000 });
    const body = r.data as any;
    list = Array.isArray(body) ? body : body?.data || body?.results || [];
  } else if (args.service === "airtime") {
    const r = await apiClient.get("/api/topup/", { timeoutMs: 20000 });
    const body = r.data as any;
    list = body?.results || body?.data || (Array.isArray(body) ? body : []);
  } else {
    return { matches: [], order: null };
  }

  const since = Date.now() - (args.minutes ?? 40) * 60 * 1000;
  const netId = args.service === "data" && args.carrier
    ? CARRIER_TO_ALRAHUZ[String(args.carrier).toUpperCase()]
    : null;

  const matches = list
    .filter((o) => {
      if (String((o as any).mobile_number || "").replace(/[^0-9]/g, "") !== phone) return false;
      const t = Date.parse(String((o as any).create_date || ""));
      if (!t || t < since) return false;
      if (args.service === "data" && netId && Number((o as any).network) !== netId) return false;
      if (args.service === "data" && args.plan && String((o as any).plan) !== String(args.plan)) return false;
      if (args.service === "airtime" && args.amount &&
        Math.abs(Number((o as any).amount || (o as any).paid_amount || 0) - Number(args.amount)) > 1) return false;
      return true;
    })
    .sort((a, b) => Date.parse(String((b as any).create_date || 0)) - Date.parse(String((a as any).create_date || 0)));

  return { matches, order: matches[0] || null };
}

// ---------------------------------------------------------------------
// RECHARGE PIN (VTU scratch card) SUPPORT — POST /api/rechargepin/
// network_amount ids from the official docs (verified 2026-08-24), keyed by
// ALRAHUZ network id (1=MTN, 2=GLO, 3=9MOBILE, 4=AIRTEL):
//   MTN (net 1): ₦100->13, ₦200->2, ₦500->3, ₦1000->20
//   GLO (net 2): ₦100->4,  ₦200->5, ₦500->6, ₦1000->22
//   9MOBILE (net 3): ₦100->7, ₦200->8
//   AIRTEL (net 4): ₦100->10, ₦200->11, ₦500->12, ₦1000->21
// ---------------------------------------------------------------------
const RECHARGE_CARDS: Record<number, Record<number, number>> = {
  1: { 100: 13, 200: 2, 500: 3, 1000: 20 },
  2: { 100: 4, 200: 5, 500: 6, 1000: 22 },
  3: { 100: 7, 200: 8 },
  4: { 100: 10, 200: 11, 500: 12, 1000: 21 },
};

const ALRAHUZ_NET_TO_APP_REG: Record<number, number> = { 1: 1, 2: 3, 3: 4, 4: 2 };

export function getRechargePinPlans(network: string | number | undefined | null) {
  const netId = getNetworkId(network);
  const cards = RECHARGE_CARDS[netId] || {};
  return Object.entries(cards).map(([amount, id]) => ({
    id,
    network: ALRAHUZ_NET_TO_APP_REG[netId] ?? netId,
    size: "₦" + amount,
    regular_price: Number(amount),
    corporate_price: Number(amount),
    plan_amount: Number(amount),
  }));
}

export function resolveRechargePinAmount(network: string | number | undefined | null, planId: number): number | null {
  const netId = getNetworkId(network);
  const cards = RECHARGE_CARDS[netId] || {};
  const entry = Object.entries(cards).find(([, id]) => Number(id) === Number(planId));
  return entry ? Number(entry[0]) : null;
}

export async function buyRechargePin(args: { network: string | number; network_amount: number; quantity: number; name_on_card: string }) {
  const res = await apiClient.post("/api/rechargepin/", {
    network: getNetworkId(args.network),
    network_amount: Number(args.network_amount),
    quantity: Math.min(5, Math.max(1, Number(args.quantity) || 1)),
    name_on_card: String(args.name_on_card || ""),
  });
  return res.data;
}

// ---------------------------------------------------------------------
// CABLE SUPPORT (website plan catalog)
// cablename codes: 1=GOTV, 2=DSTV, 3=STARTIME (4=SHOWMAX is not listed).
// ---------------------------------------------------------------------
export function cableCode(provider: string | undefined | null): number | null {
  const clean = String(provider || "").toLowerCase().trim();
  if (clean.includes("gotv")) return 1;
  if (clean.includes("dstv")) return 2;
  if (clean.includes("star")) return 3;
  if (clean.includes("show")) return 4;
  return null;
}

let cablePlansCache: { ts: number; data: Record<number, Array<Record<string, unknown>>> } | null = null;
const CABLE_PLANS_TTL_MS = 5 * 60 * 1000;

export async function getCablePlans(cablename: string | number | null): Promise<Array<Record<string, unknown>>> {
  const code = cableCode(cablename);
  if (code == null) return [];

  const now = Date.now();
  if (cablePlansCache && now - cablePlansCache.ts < CABLE_PLANS_TTL_MS && cablePlansCache.data[code]) {
    return cablePlansCache.data[code];
  }

  const { jar } = await getWebSession();
  const res = await apiClient.get("/ajax/loadcableplans/", {
    query: { cablename: code },
    headers: {
      Cookie: cookieHeader(jar),
      Referer: ALRAHUZ_BASE + "/Cablesub/",
      "X-Requested-With": "XMLHttpRequest",
    },
  });

  const html = String(res.data || "");
  const plans: Array<Record<string, unknown>> = [];
  const optRe = /<option\s+([^>]*)>([\s\S]*?)<\/option>/gi;
  let m: RegExpExecArray | null;
  while ((m = optRe.exec(html)) !== null) {
    const idMatch = m[1].match(/value=["'](\d+)["']/i);
    if (!idMatch) continue;
    const label = m[2].replace(/\s+/g, " ").trim();
    const amount = Number((label.match(/(?:=|₦|N)\s*([\d,]+)/i)?.[1] || "").replace(/,/g, ""));
    if (!amount) continue;
    plans.push({
      id: idMatch[1],
      product_name: label.replace(/[=].*$/i, "").trim() || "Plan",
      amount,
    });
  }

  if (!cablePlansCache) cablePlansCache = { ts: now, data: {} };
  cablePlansCache.data[code] = plans;
  cablePlansCache.ts = now;
  return plans;
}

export async function resolveCablePlan(cablename: string | number | null, amount: number) {
  const plans = await getCablePlans(cablename);
  const price = Number(amount) || 0;
  return plans.find((p) => Math.abs(Number(p.amount) - price) < 1) || null;
}

// ---------------------------------------------------------------------
// ELECTRICITY — Alrahuz disco ids:
// 1=Ikeja, 2=Eko, 3=Abuja, 4=Kano, 5=Enugu, 6=Port Harcourt, 7=Ibadan,
// 8=Kaduna, 9=Jos, 10=Benin, 11=Yola. MeterType: 1=PREPAID, 2=POSTPAID.
// ---------------------------------------------------------------------
const DISCOS = [
  { id: 1, name: "Ikeja Electric (IKEDC)", code: "ikeja-electric" },
  { id: 2, name: "Eko Electric (EKEDC)", code: "eko-electric" },
  { id: 3, name: "Abuja Electric (AEDC)", code: "abuja-electric" },
  { id: 4, name: "Kano Electric (KEDCO)", code: "kano-electric" },
  { id: 5, name: "Enugu Electric (EEDC)", code: "enugu-electric" },
  { id: 6, name: "Port Harcourt Electric (PHED)", code: "portharcourt-electric" },
  { id: 7, name: "Ibadan Electric (IBEDC)", code: "ibadan-electric" },
  { id: 8, name: "Kaduna Electric (KAEDCO)", code: "kaduna-electric" },
  { id: 9, name: "Jos Electric (JED)", code: "jos-electric" },
  { id: 10, name: "Benin Electric (BEDC)", code: "benin-electric" },
  { id: 11, name: "Yola Electric (YEDC)", code: "yola-electric" },
];

export function getDiscoList() {
  return DISCOS.map((d) => ({ name: d.name, code: d.code }));
}

export function discoIdForCode(code: string | null | undefined): number | null {
  const clean = String(code || "").toLowerCase().replace(/[^a-z]/g, "");
  const hit = DISCOS.find((d) => clean.includes(d.code.replace(/[^a-z]/g, "")));
  return hit ? hit.id : null;
}

export function meterTypeCode(typ: string | null | undefined): number {
  const t = String(typ || "").toLowerCase();
  return t.includes("post") ? 2 : 1;
}

export async function buyAirtime(args: { network: string | number; mobile_number: string; amount: number; airtime_type?: string; Ported_number?: boolean }) {
  const netId = getNetworkId(args.network);
  const res = await apiClient.post("/api/topup/", {
    network: netId,
    amount: Number(args.amount),
    mobile_number: String(args.mobile_number).trim(),
    Ported_number: args.Ported_number ?? true,
    airtime_type: args.airtime_type || "VTU",
  });
  return res.data;
}

export async function buyElectricity(args: { disco_name: number; amount: number; meter_number: string; MeterType: number }) {
  const res = await apiClient.post("/api/billpayment/", {
    disco_name: String(args.disco_name).trim(),
    amount: Number(args.amount),
    meter_number: String(args.meter_number).trim(),
    MeterType: Number(args.MeterType),
  });
  return res.data;
}

export async function validateMeter(args: { meternumber: string; disconame: number; mtype: number }) {
  const res = await apiClient.get(
    `/api/validatemeter?meternumber=${encodeURIComponent(args.meternumber)}&disconame=${args.disconame}&mtype=${args.mtype}`,
  );
  return res.data;
}

export async function buyCable(args: { cablename: number; cableplan: number; smart_card_number: string }) {
  const res = await apiClient.post("/api/cablesub/", {
    cablename: Number(args.cablename),
    cableplan: Number(args.cableplan),
    smart_card_number: String(args.smart_card_number).trim(),
  });
  return res.data;
}

export async function validateIUC(args: { smart_card_number: string; cablename: number }) {
  const res = await apiClient.get(
    `/api/validateiuc?smart_card_number=${encodeURIComponent(args.smart_card_number)}&cablename=${args.cablename}`,
  );
  return res.data;
}

export async function buyEPin(args: { exam_name: string; quantity: number }) {
  const res = await apiClient.post("/api/epin/", {
    exam_name: String(args.exam_name).trim(),
    quantity: Math.min(5, Math.max(1, Number(args.quantity) || 1)),
  });
  return res.data;
}
