const { createClient } = require("@supabase/supabase-js");

const supabaseUrl = process.env.SUPABASE_URL || "";
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const isValidUrl = (url) => {
  try {
    return url.startsWith("http://") || url.startsWith("https://");
  } catch (e) {
    return false;
  }
};

let supabase;

if (isValidUrl(supabaseUrl) && supabaseKey) {
  supabase = createClient(supabaseUrl, supabaseKey);
} else {
  console.warn("⚠️ Warning: Supabase credentials missing or invalid. Using fallback mock client.");
  supabase = {
    from: () => ({
      insert: async () => ({ data: { order_id: "mock-order-uuid" }, error: null }),
      select: () => ({
        eq: () => ({
          single: async () => ({
            data: {
              order_id: "mock-order-uuid",
              status: "pending",
              service_type: "data",
              amount: 1000,
              psp_transactions: [{ receipt_data: null, psp_status: "000" }]
            },
            error: null
          })
        })
      }),
      update: () => ({
        eq: async () => ({ data: null, error: null })
      })
    })
  };
}

module.exports = supabase;
