require("dotenv").config();
const axios = require("axios");
const SUPA = process.env.SUPABASE_URL;
const SRK = process.env.SUPABASE_SERVICE_ROLE_KEY;
const srkCfg = { headers: { apikey: SRK, Authorization: `Bearer ${SRK}`, "Content-Type": "application/json" } };
const EMAIL = `diag3+${Date.now()}@dreamhatchertech.com`;

(async () => {
  let uid = null;
  try {
    const cu = await axios.post(`${SUPA}/auth/v1/admin/users`, { email: EMAIL, password: "Diag-Temp-9931!", email_confirm: true }, srkCfg);
    uid = cu.data.id;
    await axios.patch(`${SUPA}/rest/v1/profiles?id=eq.${uid}`, { is_admin: true, role: "admin" }, srkCfg);
    try {
      const r = await axios.post("http://localhost:3001/auth/login", { email: EMAIL, password: "Diag-Temp-9931!" }, { timeout: 60000 });
      console.log("LOCAL LOGIN OK", r.status, JSON.stringify(r.data).slice(0, 120));
    } catch (e) {
      console.log("LOCAL LOGIN FAIL", e.response?.status, JSON.stringify(e.response?.data));
    }
    try {
      const r2 = await axios.get("http://localhost:3001/api/v2/admin/stats", { headers: { Authorization: `Bearer ${uid}` }, timeout: 30000 });
      console.log("(ignore) stats with bogus token:", r2.status);
    } catch (e) {
      console.log("stats bogus-token (expect 401):", e.response?.status);
    }
  } finally {
    if (uid) {
      await axios.delete(`${SUPA}/rest/v1/profiles?id=eq.${uid}`, srkCfg);
      await axios.delete(`${SUPA}/auth/v1/admin/users/${uid}`, { headers: { apikey: SRK, Authorization: `Bearer ${SRK}` } });
      console.log("cleaned");
    }
  }
})();
