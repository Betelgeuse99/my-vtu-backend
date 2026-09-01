require("dotenv").config();
const axios = require("axios");
const URL = process.env.SUPABASE_URL;
const SRK = process.env.SUPABASE_SERVICE_ROLE_KEY;
const LIVE = "https://dreamhatcher-paystack-backend.onrender.com";
const EMAIL = `diag+${Date.now()}@dreamhatchertech.com`;
const PASS = "Diag-Temp-9931!";
const srkCfg = { headers: { apikey: SRK, Authorization: `Bearer ${SRK}`, "Content-Type": "application/json" } };

(async () => {
  let userId = null;
  try {
    const cu = await axios.post(`${URL}/auth/v1/admin/users`, { email: EMAIL, password: PASS, email_confirm: true }, srkCfg);
    userId = cu.data?.id;
    await axios.patch(`${URL}/rest/v1/profiles?id=eq.${userId}`, { is_admin: true, role: "admin" }, srkCfg);
    console.log("✅ diag admin ready");

    const li = await axios.post(`${LIVE}/auth/login`, { email: EMAIL, password: PASS }, { timeout: 60000 });
    const accessToken = li.data?.session?.access_token;
    console.log(`✅ live login ok=${!!accessToken}`);
    const authCfg = { headers: { Authorization: `Bearer ${accessToken}` }, timeout: 90000 };

    for (let i = 1; i <= 4; i++) {
      const t = Date.now();
      try {
        const r = await axios.get(`${LIVE}/api/v2/admin/stats`, authCfg);
        const d = r.data?.data || {};
        console.log(`#${i} stats ${r.status} ${Date.now() - t}ms | liability=${d.total_wallet_liability} users=${d.total_registered_users} txns=${d.total_transactions}`);
      } catch (e) {
        console.log(`#${i} stats FAILED ${e.response?.status || "NET"} | ${JSON.stringify(e.response?.data).slice(0, 150) || e.message}`);
      }
      await new Promise(r2 => setTimeout(r2, 4000));
    }

    try {
      const r = await axios.get(`${LIVE}/api/v2/admin/transactions?page=1&limit=8`, authCfg);
      console.log(`txns ${r.status} rows=${r.data?.data?.length} total=${r.data?.pagination?.total}`);
    } catch (e) {
      console.log(`txns FAILED ${e.response?.status || "NET"} | ${JSON.stringify(e.response?.data).slice(0, 150) || e.message}`);
    }
  } finally {
    try { if (userId) {
      await axios.delete(`${URL}/rest/v1/profiles?id=eq.${userId}`, srkCfg);
      await axios.delete(`${URL}/auth/v1/admin/users/${userId}`, { headers: { apikey: SRK, Authorization: `Bearer ${SRK}` } });
      console.log("🧹 cleaned up");
    } } catch (e) { console.log("cleanup err:", e.message); }
  }
})().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
