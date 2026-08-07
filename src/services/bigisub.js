const axios = require("axios");

const BIGISUB_BASE_URL = process.env.BIGISUB_BASE_URL || "https://api.bigisub.ng";
const BIGISUB_API_TOKEN = process.env.BIGISUB_API_TOKEN;

// Create pre-configured Axios Instance for Bigisub API
const bigiClient = axios.create({
  baseURL: BIGISUB_BASE_URL,
  headers: {
    Authorization: `Token ${BIGISUB_API_TOKEN}`,
    "Content-Type": "application/json",
  },
  timeout: 15000,
});

/**
 * Fetch Bigisub Wallet / User Info
 */
const getProviderBalance = async () => {
  try {
    const response = await bigiClient.get("/user");
    return response.data;
  } catch (error) {
    console.error("Bigisub user query failed:", error.response?.data || error.message);
    throw error;
  }
};

/**
 * Validate Cable TV Smartcard or Electricity Meter
 */
const validateCustomerAccount = async (service, customerId, type = null) => {
  try {
    const payload = { service, customer_id: customerId };
    if (type) payload.type = type;

    const response = await bigiClient.post("/merchant-verify", payload);
    return response.data;
  } catch (error) {
    console.error("Bigisub verification failed:", error.response?.data || error.message);
    throw error;
  }
};

/**
 * Dispatch Purchase Order (Airtime, Data, Cable TV, Electricity)
 */
const executePurchase = async ({ orderId, serviceType, customerTarget, amount, billCode, variationCode }) => {
  try {
    const payload = {
      request_id: orderId,
      network: billCode,
      phone: customerTarget,
      amount: amount,
    };

    if (variationCode) {
      payload.plan = variationCode;
    }

    // Dynamic endpoint selection based on VTU product type
    let endpoint = "/data/";
    if (serviceType === "airtime") endpoint = "/topup/";
    if (serviceType === "electricity") endpoint = "/billpayment/";
    if (serviceType === "tv") endpoint = "/cablesub/";

    const response = await bigiClient.post(endpoint, payload);
    return response.data;
  } catch (error) {
    return {
      status: "error",
      message: error.response?.data?.message || error.message,
      raw: error.response?.data || null,
    };
  }
};

module.exports = {
  getProviderBalance,
  validateCustomerAccount,
  executePurchase,
};
