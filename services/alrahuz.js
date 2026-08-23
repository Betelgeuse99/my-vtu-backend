/**
 * Alrahuzdata VTU API client
 * Docs: https://documenter.getpostman.com/view/18957639/2s9YR6buRK
 *
 * Auth: Token header (Authorization: Token <API_KEY>)
 * Base: https://alrahuzdata.com.ng/api/
 *
 * Endpoints:
 *   GET  /user/               — wallet balance
 *   POST /data/               — buy data
 *   GET  /data/               — all data transactions
 *   GET  /data/{id}           — query data transaction
 *   POST /topup/              — buy airtime
 *   POST /epin/               — buy education pin
 *   POST /billpayment/        — pay electricity
 *   GET  /billpayment/{id}    — query bill payment
 *   POST /cablesub/           — buy cable subscription
 *   GET  /cablesub/{id}       — query cable sub
 *   GET  /validateiuc         — validate IUC (smartcard)
 *   GET  /validatemeter       — validate meter
 *
 * NOTE: there is NO plans-list endpoint on the API. Plan IDs live behind the
 * website dashboard, so getDataPlans() logs into the website with the web
 * credentials (.env: ALRAHUZ_WEB_USER / ALRAHUZ_WEB_PASS) and scrapes the
 * same JSON/HTML endpoint the buy-data page uses (/ajax/load_plans/).
 */

const axios = require("axios");

const ALRAHUZ_BASE = process.env.ALRAHUZ_BASE_URL || "https://alrahuzdata.com.ng";
const ALRAHUZ_TOKEN = process.env.ALRAHUZ_API_TOKEN || process.env.ALRAHUZ_TOKEN || "";
const ALRAHUZ_WEB_USER = process.env.ALRAHUZ_WEB_USER || "";
const ALRAHUZ_WEB_PASS = process.env.ALRAHUZ_WEB_PASS || "";

const apiClient = axios.create({
  baseURL: ALRAHUZ_BASE,
  headers: {
    Authorization: `Token ${ALRAHUZ_TOKEN}`,
    "Content-Type": "application/json",
  },
  timeout: 30000,
});

// Network IDs on Alrahuzdata: 1=MTN, 2=GLO, 3=9MOBILE, 4=AIRTEL, 5=SMILE.
// The app sends EITHER slugs OR its own registry numbers (1=MTN,2=GLO,
// 3=AIRTEL,4=9MOBILE) — translate both into Alrahuz ids here.
function getNetworkId(network) {
  const map = {
    "1": 1, "mtn": 1,
    "2": 2, "glo": 2,
    "3": 4, "airtel": 4,
    "4": 3, "9mobile": 3, "eti": 3
  };
  return map[String(network || "").toLowerCase().trim()] || 1;
}

async function getBalance() {
  const res = await apiClient.get("/api/user/");
  const body = res.data?.user || res.data;
  return Number(body?.wallet_balance ?? body?.balance ?? 0);
}

// ---------------------------------------------------------------------
// Website session (cookie jar) — only needed for plan scraping
// ---------------------------------------------------------------------
let sessionCache = null; // { cookies, expires }

function jarFromResponse(jar, res) {
  const setCookies = res.headers["set-cookie"] || [];
  for (const sc of setCookies) {
    const [pair] = String(sc).split(";");
    const eq = pair.indexOf("=");
    if (eq > 0) jar[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
}

function cookieHeader(jar) {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
}

async function getWebSession() {
  if (sessionCache && Date.now() < sessionCache.expires) return sessionCache;

  if (!ALRAHUZ_WEB_USER || !ALRAHUZ_WEB_PASS) {
    throw new Error("Alrahuz website credentials missing (ALRAHUZ_WEB_USER / ALRAHUZ_WEB_PASS)");
  }

  const jar = {};
  // maxRedirects: 0 is essential — the login POST answers with a 302 that
  // carries the sessionid cookie; following redirects automatically loses it.
  const web = axios.create({
    baseURL: ALRAHUZ_BASE,
    timeout: 30000,
    maxRedirects: 0,
    validateStatus: (s) => (s >= 200 && s < 400),
  });

  const loginPage = await web.get("/login/");
  jarFromResponse(jar, loginPage);

  const csrf = String(loginPage.data).match(
    /name=['"]csrfmiddlewaretoken['"]\s+value=['"]([^'"]+)['"]/
  )?.[1];
  if (!csrf) throw new Error("Could not read Alrahuz login CSRF token");

  const form = new URLSearchParams({
    csrfmiddlewaretoken: csrf,
    username: ALRAHUZ_WEB_USER,
    password: ALRAHUZ_WEB_PASS,
  });
  const loginRes = await web.post("/login/", form.toString(), {
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: ALRAHUZ_BASE + "/login/",
      Cookie: cookieHeader(jar),
    },
  });
  jarFromResponse(jar, loginRes);

  if (!jar.sessionid) {
    throw new Error("Alrahuz website login failed — check ALRAHUZ_WEB_USER / ALRAHUZ_WEB_PASS");
  }

  sessionCache = { jar, expires: Date.now() + 20 * 60 * 1000 };
  return sessionCache;
}

/**
 * Fetches Alrahuz data plans for [network] by scraping the logged-in site.
 * Returns BigiSub-shaped rows so callers can treat both providers alike:
 *   { id, plan_id, plantype, size, validity, amount }
 */
async function getDataPlans(network) {
  const netId = getNetworkId(network);
  const { jar } = await getWebSession();

  const res = await apiClient.get("/ajax/load_plans/", {
    params: { network: netId },
    headers: {
      Cookie: cookieHeader(jar),
      Referer: ALRAHUZ_BASE + "/data_Create/",
      "X-Requested-With": "XMLHttpRequest",
    },
  });

  const html = String(res.data || "");
  const plans = [];
  const optRe = /<option\s+([^>]*)>([\s\S]*?)<\/option>/gi;
  let m;
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

async function buyData({ network, mobile_number, plan, Ported_number = true }) {
  const netId = getNetworkId(network);
  const res = await apiClient.post("/api/data/", {
    network: netId,
    mobile_number: String(mobile_number).trim(),
    plan: Number(plan),
    Ported_number,
  });
  return res.data;
}

async function buyAirtime({ network, mobile_number, amount, airtime_type = "VTU", Ported_number = true }) {
  const netId = getNetworkId(network);
  const res = await apiClient.post("/api/topup/", {
    network: netId,
    amount: Number(amount),
    mobile_number: String(mobile_number).trim(),
    Ported_number,
    airtime_type,
  });
  return res.data;
}

async function buyElectricity({ disco_name, amount, meter_number, MeterType }) {
  const res = await apiClient.post("/api/billpayment/", {
    disco_name: String(disco_name).trim(),
    amount: Number(amount),
    meter_number: String(meter_number).trim(),
    MeterType: Number(MeterType), // 1=PREPAID, 2=POSTPAID
  });
  return res.data;
}

async function validateMeter({ meternumber, disconame, mtype }) {
  const res = await apiClient.get(`/api/validatemeter?meternumber=${meternumber}&disconame=${disconame}&mtype=${mtype}`);
  return res.data;
}

async function buyCable({ cablename, cableplan, smart_card_number }) {
  const res = await apiClient.post("/api/cablesub/", {
    cablename: Number(cablename),
    cableplan: Number(cableplan),
    smart_card_number: String(smart_card_number).trim(),
  });
  return res.data;
}

async function validateIUC({ smart_card_number, cablename }) {
  const res = await apiClient.get(`/api/validateiuc?smart_card_number=${smart_card_number}&cablename=${cablename}`);
  return res.data;
}

async function buyEPin({ exam_name, quantity }) {
  const res = await apiClient.post("/api/epin/", {
    exam_name: String(exam_name).trim(),
    quantity: Math.min(5, Math.max(1, Number(quantity) || 1)),
  });
  return res.data;
}

module.exports = {
  client: apiClient,
  getNetworkId,
  getBalance,
  getDataPlans,
  buyData,
  buyAirtime,
  buyElectricity,
  validateMeter,
  buyCable,
  validateIUC,
  buyEPin,
};
