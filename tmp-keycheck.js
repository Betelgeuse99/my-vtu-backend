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

    const li = await axios.post(`${LIVE}/auth/login`, { email: EMAIL, password: PASS }, { timeout: 60000 });
    const accessToken = li.data?.session?.access_token;

    const r = await axios.get(`${LIVE}/api/v2/admin/keycheck`, {
      headers: { Authorization: `Bearer ${accessToken}` }, timeout: 90000,
    });
    console.log("🔑 LIVE SERVER KEY REPORT:", JSON.stringify(r.data));
  } finally {
    try { if (userId) {
      await axios.delete(`${URL}/rest/v1/profiles?id=eq.${userId}`, srkCfg);
      await axios.delete(`${URL}/auth/v1/admin/users/${userId}`, { headers: { apikey: SRK, Authorization: `Bearer ${SRK}` } });
      console.log("🧹 cleaned up");
    } } catch (e) { console.log("cleanup err:", e.message); }
  }
})().catch(e => console.error("FATAL:", e.response?.status, JSON.stringify(e.response?.data).slice(0, 200), e.message));
