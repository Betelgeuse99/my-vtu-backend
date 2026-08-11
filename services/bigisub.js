const axios = require("axios");

const BIGISUB_BASE_URL = "https://api.bigisub.ng";
const BIGISUB_TOKEN = process.env.BIGISUB_TOKEN || process.env.BIGISUB_API_KEY;

const client = axios.create({
  baseURL: BIGISUB_BASE_URL,
  headers: {
    "Authorization": `Token ${BIGISUB_TOKEN}`,
    "Content-Type": "application/json"
  }
});

// Map string or integer network identifiers to exact spec integers: 1=MTN, 2=Airtel, 3=Glo, 4=9Mobile
function getNetworkId(network) {
  const map = {
    "1": 1, "mtn": 1,
    "2": 2, "airtel": 2,
    "3": 3, "glo": 3,
    "4": 4, "9mobile": 4, "eti": 4
  };
  const key = String(network || "").toLowerCase().trim();
  return map[key] || 1;
}

async function getDataPlans(networkInput) {
  const networkId = getNetworkId(networkInput);
  try {
    const res = await client.get(`/api/v2/vtu/data/plans/?network=${networkId}`);
    // Spec returns: { success: true, data: [ { id, network, network_name, size, amount, validity... } ] }
    if (res.data && res.data.success && Array.isArray(res.data.data)) {
      return res.data.data;
    }
    return Array.isArray(res.data) ? res.data : [];
  } catch (err) {
    console.error("❌ Bigisub getDataPlans Error:", err.response?.data || err.message);
    throw err;
  }
}

async function purchaseData({ network, plan, phone_number, pin }) {
  const networkId = getNetworkId(network);
  try {
    const payload = {
      network: networkId,
      plan: Number(plan),
      phone_number: String(phone_number).trim(),
      pin: String(pin || process.env.BIGISUB_PIN || "1234"),
      ported_number: true
    };
    const res = await client.post("/api/v2/vtu/data/purchase/", payload);
    return res.data;
  } catch (err) {
    console.error("❌ Bigisub purchaseData Error:", err.response?.data || err.message);
    throw err;
  }
}

module.exports = {
  getNetworkId,
  getDataPlans,
  purchaseData
};
