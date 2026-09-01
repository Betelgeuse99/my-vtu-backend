require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

(async () => {
  const p = await supabase.from("profiles").select("id", { count: "exact", head: true });
  console.log("LOCAL profiles:", JSON.stringify({ count: p.count, error: p.error?.message || null }));
  const w = await supabase.from("wallets").select("user_id, balance").limit(5);
  console.log("LOCAL wallets:", JSON.stringify({ rows: w.data?.length, sample: w.data?.slice(0,2), error: w.error?.message || null }));
  const t = await supabase.from("transactions").select("id", { count: "exact", head: true });
  console.log("LOCAL transactions:", JSON.stringify({ count: t.count, error: t.error?.message || null }));
})();
