require("dotenv").config();
const axios = require("axios");
const SUPA = process.env.SUPABASE_URL;
const SRK = process.env.SUPABASE_SERVICE_ROLE_KEY;
const srkCfg = { headers: { apikey: SRK, Authorization: `Bearer ${SRK}`, "Content-Type": "application/json" } };
const BASE = `http://localhost:${process.env.TEST_PORT || 3002}`;
const EMAIL = `diag4+${Date.now()}@dreamhatchertech.com`;

(async () => {
  let uid = null;
  try {
    const cu = await axios.post(`${SUPA}/auth/v1/admin/users`, { email: EMAIL, password: "Diag-Temp-9931!", email_confirm: true }, srkCfg);
    uid = cu.data.id;
    await axios.patch(`${SUPA}/rest/v1/profiles?id=eq.${uid}`, { is_admin: true, role: "admin" }, srkCfg);
    console.log("diag user ready");

    // STEP 1: LOGIN (this used to poison the shared client)
    const li = await axios.post(`${BASE}/auth/login`, { email: EMAIL, password: "Diag-Temp-9931!" }, { timeout: 60000 });
    const token = li.data?.session?.access_token;
    console.log(`STEP1 login: ok=${li.data?.success} gotToken=${!!token}`);

    if (!token) return;

    const authCfg = { headers: { Authorization: `Bearer ${token}` }, timeout: 60000 };

    // STEP 2: STATS IMMEDIATELY AFTER LOGIN — the moment it used to break
    for (let i = 1; i <= 3; i++) {
      try {
        const r = await axios.get(`${BASE}/api/v2/admin/stats`, authCfg);
        const d = r.data?.data || {};
        console.log(`STEP2 stats#${i}: liability=${d.total_wallet_liability} users=${d.total_registered_users} txns=${d.total_transactions}`);
      } catch (e) {
        console.log(`STEP2 stats#${i} FAILED ${e.response?.status} ${JSON.stringify(e.response?.data).slice(0, 120)}`);
      }
      await new Promise(r => setTimeout(r, 2000));
    }

    // STEP 3: TRANSACTIONS
    try {
      const r = await axios.get(`${BASE}/api/v2/admin/transactions?page=1&limit=8`, authCfg);
      console.log(`STEP3 txns: rows=${r.data?.data?.length} total=${r.data?.pagination?.total}`);
    } catch (e) {
      console.log(`STEP3 txns FAILED ${e.response?.status}`);
    }

    // STEP 4: REFRESH (the other poisoner)
    try {
      const r = await axios.post(`${BASE}/auth/refresh`, { refresh_token: li.data.session.refresh_token }, { timeout: 60000 });
      console.log(`STEP4 refresh: ok=${r.data?.success}`);

      // STEP 5: STATS AGAIN AFTER REFRESH
      const newToken = r.data?.session?.access_token || token;
      const r5 = await axios.get(`${BASE}/api/v2/admin/stats`, { headers: { Authorization: `Bearer ${newToken}` }, timeout: 60000 });
      const d5 = r5.data?.data || {};
      console.log(`STEP5 stats-after-refresh: liability=${d5.total_wallet_liability} txns=${d5.total_transactions}`);
    } catch (e) {
      console.log(`STEP4/5 FAILED ${e.response?.status} ${JSON.stringify(e.response?.data).slice(0, 120)}`);
    }
  } finally {
    if (uid) {
      await axios.delete(`${SUPA}/rest/v1/profiles?id=eq.${uid}`, srkCfg);
      await axios.delete(`${SUPA}/auth/v1/admin/users/${uid}`, { headers: { apikey: SRK, Authorization: `Bearer ${SRK}` } });
      console.log("cleaned up diag user");
    }
  }
})().catch(e => console.error("FATAL:", e.message));
