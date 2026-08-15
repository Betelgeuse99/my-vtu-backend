const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const axios = require("axios");
const https = require("https");

function clean(str) {
  return String(str || "").trim().replace(/^["']+|["']+$/g, "");
}

const SUPABASE_URL = clean(process.env.SUPABASE_URL);
const SUPABASE_KEY = clean(process.env.SUPABASE_SERVICE_ROLE_KEY);
const BIGISUB_TOKEN = clean(process.env.BIGISUB_TOKEN || process.env.BIGISUB_API_KEY);

console.log("ConfigCheck -> URL:", SUPABASE_URL ? "OK" : "MISSING", "| KEY:", SUPABASE_KEY ? "OK" : "MISSING", "| TOKEN:", BIGISUB_TOKEN ? "OK" : "MISSING");

if (!SUPABASE_URL || SUPABASE_URL.includes("your-project") || !SUPABASE_KEY || !BIGISUB_TOKEN) {
  console.error("ERROR: Credentials missing or placeholder found in .env");
  process.exit(1);
}

const bigiClient = axios.create({
  baseURL: "https://api.bigisub.ng",
  headers: { "Authorization": "Token " + BIGISUB_TOKEN, "Content-Type": "application/json" }
});

// App network id (1=MTN, 2=Glo, 3=Airtel, 4=9Mobile) -> BigiSub API network id (1=MTN, 2=Airtel, 3=Glo, 4=9Mobile)
const NETWORKS = [
  { appId: 1, bigiApiId: 1, name: "MTN" },
  { appId: 2, bigiApiId: 3, name: "GLO" },
  { appId: 3, bigiApiId: 2, name: "AIRTEL" },
  { appId: 4, bigiApiId: 4, name: "9MOBILE" }
];

function upsertToSupabase(records) {
  return new Promise((resolve, reject) => {
    const url = new URL(SUPABASE_URL + "/rest/v1/data_plans");
    const data = JSON.stringify(records);
    const req = https.request(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": SUPABASE_KEY,
        "Authorization": "Bearer " + SUPABASE_KEY,
        "Prefer": "resolution=merge-duplicates",
        "Content-Length": Buffer.byteLength(data)
      }
    }, (res) => {
      let body = "";
      res.on("data", c => body += c);
      res.on("end", () => res.statusCode >= 200 && res.statusCode < 300 ? resolve(body) : reject(new Error("Supabase Error " + res.statusCode + ": " + body)));
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

async function startSync() {
  console.log("Syncing BigiSub Data Plans...");
  for (const net of NETWORKS) {
    try {
      const res = await bigiClient.get("/api/v2/vtu/data/plans/?network=" + net.bigiApiId);
      const plans = res.data?.data || (Array.isArray(res.data) ? res.data : []);
      if (plans.length === 0) continue;
      const payload = plans.map(p => ({
        network_id: net.appId,
        bigi_plan_id: String(p.id),
        plan_type: String(p.plantype || "SME").toUpperCase(),
        volume: String(p.size || p.plan_volume || "1GB"),
        validity: String(p.validity || "30 days"),
        buy_price: Number(p.corporate_amount || p.amount || 0),
        retail_price: Number(p.plan_amount || Math.ceil((p.corporate_amount || p.amount || 0) * 1.15)),
        is_active: (p.plan_disabled || false) === false,
        updated_at: new Date().toISOString()
      }));
      await upsertToSupabase(payload);
      console.log("Synced " + net.name + " (" + payload.length + " plans)");
    } catch (err) {
      console.error("Sync failed for " + net.name + ":", err.message);
    }
  }
  console.log("Sync Completed!");
}
startSync();
