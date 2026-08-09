const axios = require("axios");

const BIGISUB_BASE_URL = "https://api.bigisub.ng";
const API_TOKEN = process.env.BIGISUB_API_KEY;

const bigisubClient = axios.create({
  baseURL: BIGISUB_BASE_URL,
  headers: {
    Authorization: `Token ${API_TOKEN}`,
    "Content-Type": "application/json",
  },
});

// -------------------------------------------------------------
// 1. AIRTIME
// -------------------------------------------------------------
exports.purchaseAirtime = async ({ network, phone_number, amount, pin, airtime_type = "vtu" }) => {
  const res = await bigisubClient.post("/api/v2/vtu/airtime/purchase/", {
    network: Number(network), // 1=MTN, 2=Airtel, 3=Glo, 4=9Mobile
    phone_number,
    amount: String(amount),
    airtime_type,
    pin,
  });
  return res.data;
};

// -------------------------------------------------------------
// 2. DATA BUNDLES
// -------------------------------------------------------------
exports.getDataPlans = async (networkId = null) => {
  const url = networkId ? `/api/v2/vtu/data/plans/?network=${networkId}` : "/api/v2/vtu/data/plans/";
  const res = await bigisubClient.get(url);
  return res.data;
};

exports.purchaseData = async ({ network, plan, phone_number, pin, ported_number = true }) => {
  const res = await bigisubClient.post("/api/v2/vtu/data/purchase/", {
    network: Number(network),
    plan: Number(plan), // Plan ID from data plans list
    phone_number,
    pin,
    ported_number,
  });
  return res.data;
};

// -------------------------------------------------------------
// 3. CABLE TV
// -------------------------------------------------------------
exports.getCablePlans = async (cableName) => {
  const res = await bigisubClient.get(`/api/v2/vtu/cable/plans/?cable_name=${cableName}`); // dstv, gotv, startimes, showmax
  return res.data;
};

exports.verifyCable = async ({ cable_name, card_no }) => {
  const res = await bigisubClient.post("/api/v2/vtu/cable/verify/", { cable_name, card_no });
  return res.data;
};

exports.purchaseCable = async ({ cable_type, card_no, phone_number, amount, Customer, pin }) => {
  const res = await bigisubClient.post("/api/v2/vtu/cable/purchase/", {
    cable_type,
    card_no,
    phone_number,
    amount: Number(amount),
    Customer,
    pin,
  });
  return res.data;
};

// -------------------------------------------------------------
// 4. RECHARGE CARD PINS
// -------------------------------------------------------------
exports.getRechargePinPlans = async (networkId) => {
  const url = networkId ? `/api/v2/vtu/recharge-pin/plans/?network=${networkId}` : "/api/v2/vtu/recharge-pin/plans/";
  const res = await bigisubClient.get(url);
  return res.data;
};

exports.purchaseRechargePin = async ({ plan, quantity, name_on_card, pin }) => {
  const res = await bigisubClient.post("/api/v2/vtu/recharge-pin/purchase/", {
    plan: Number(plan),
    quantity: Number(quantity),
    name_on_card,
    pin,
  });
  return res.data;
};

// -------------------------------------------------------------
// 5. ELECTRICITY
// -------------------------------------------------------------
exports.getElectricityProviders = async () => {
  const res = await bigisubClient.get("/api/v2/bills/electricity/providers/");
  return res.data;
};

exports.verifyMeter = async ({ company, meter_no, meter_type }) => {
  const res = await bigisubClient.post("/api/v2/bills/electricity/verify/", {
    company,
    meter_no,
    meter_type, // prepaid or postpaid
  });
  return res.data;
};

exports.payElectricity = async ({ company, meter_no, meter_type, phone_number, amount, Customer_name, pin }) => {
  const res = await bigisubClient.post("/api/v2/bills/electricity/pay/", {
    company,
    meter_no,
    meter_type,
    phone_number,
    amount: Number(amount),
    Customer_name,
    pin,
  });
  return res.data;
};

// -------------------------------------------------------------
// 6. EDUCATION (RESULT CHECKERS)
// -------------------------------------------------------------
exports.getEducationPrices = async () => {
  const res = await bigisubClient.get("/api/v2/bills/result-checker/prices/");
  return res.data;
};

exports.purchaseEducationPin = async ({ exam, quantity, pin_code }) => {
  const res = await bigisubClient.post("/api/v2/bills/result-checker/purchase/", { // WAEC, NECO, NABTEB
    exam,
    quantity: Number(quantity), // 1, 2, or 5
    pin_code,
  });
  return res.data;
};

// -------------------------------------------------------------
// 7. TRANSACTION STATUS & REQUERY
// -------------------------------------------------------------
exports.requeryTransaction = async (tranxId) => {
  const res = await bigisubClient.post(`/api/v2/anubis/transactions/${tranxId}/requery/`);
  return res.data;
};
