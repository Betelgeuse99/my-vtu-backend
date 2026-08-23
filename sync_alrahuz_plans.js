/**
 * Syncs Alrahuzdata's plan catalog into the unified data_plans table.
 *
 * For every Alrahuz plan it finds:
 *   - If a data_plans row with the SAME network + volume already exists,
 *     that row gets its alrahuz_plan_id / alrahuz_buy_price filled in
 *     (the row can then be fulfilled by either provider).
 *   - Otherwise a NEW row is inserted keyed by the Alrahuz ID
 *     (bigi_plan_id = "ALR-<id>") so it still shows up in the admin Plans page.
 *
 * Run: node sync_alrahuz_plans.js
 */

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const { createClient } = require("@supabase/supabase-js");
const alrahuz = require("./services/alrahuz");

function clean(str) {
  return String(str || "").trim().replace(/^["']+|["']+$/g, "");
}

const SUPABASE_URL = clean(process.env.SUPABASE_URL);
const SUPABASE_KEY = clean(process.env.SUPABASE_SERVICE_ROLE_KEY);

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("ERROR: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing in .env");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Alrahuz network ids -> our app network ids (1=MTN, 2=GLO, 3=AIRTEL, 4=9MOBILE)
const ALRAHUZ_NET_TO_APP = { 1: 1, 2: 2, 3: 4, 4: 3 }; // skip 5 (SMILE)

function volumeToMb(size) {
  const m = String(size || "").trim().match(/^([\d.]+)\s*(GB|MB|KB)$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (isNaN(n)) return null;
  const unit = m[2].toUpperCase();
  if (unit === "GB") return Math.round(n * 1000);
  if (unit === "MB") return Math.round(n);
  return Math.max(1, Math.round(n / 1000));
}

async function main() {
  console.log("Logging into Alrahuz website & scraping plan catalog...");
  const existingRes = await supabase.from("data_plans").select("id, network_id, volume, alrahuz_plan_id");
  if (existingRes.error) throw existingRes.error;
  const existing = existingRes.data || [];
  console.log(`Existing catalog rows: ${existing.length}`);

  let matched = 0;
  let inserted = 0;

  for (const [alraNetStr, appNet] of Object.entries(ALRAHUZ_NET_TO_APP)) {
    const alraNet = Number(alraNetStr);
    let plans;
    try {
      plans = await alrahuz.getDataPlans(alraNet);
    } catch (err) {
      console.error(`Failed to fetch plans for alrahuz network ${alraNet}: ${err.message}`);
      continue;
    }
    console.log(`Alrahuz network ${alraNet}: ${plans.length} plans`);

    for (const p of plans) {
      const mb = volumeToMb(p.size);
      if (!mb) continue;

      // 1) Already mapped to this exact Alrahuz ID? Just refresh its cost.
      const alreadyMapped = existing.find(
        (row) => String(row.alrahuz_plan_id) === String(p.id)
      );
      if (alreadyMapped) {
        const { error } = await supabase
          .from("data_plans")
          .update({
            alrahuz_buy_price: Number(p.amount) || null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", alreadyMapped.id);
        if (error) {
          console.warn(`  ⚠️ price refresh ${p.size} (#${p.id}): ${error.message}`);
        } else {
          matched++;
        }
        continue;
      }

      // 2) Same network + equivalent volume without an Alrahuz mapping yet?
      const candidate = existing.find((row) => {
        return (
          row.network_id === appNet &&
          volumeToMb(row.volume) === mb &&
          !row.alrahuz_plan_id
        );
      });

      if (candidate) {
        const { error } = await supabase
          .from("data_plans")
          .update({
            alrahuz_plan_id: String(p.id),
            alrahuz_buy_price: Number(p.amount) || null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", candidate.id);
        if (error) {
          console.warn(`  ⚠️ could not map ${p.size} (#${p.id}): ${error.message}`);
        } else {
          candidate.alrahuz_plan_id = String(p.id); // keep local cache fresh
          matched++;
        }
      } else {
        const buyPrice = Number(p.amount) || 0;
        const retail = Math.ceil(buyPrice * 1.15);
        const { error } = await supabase.from("data_plans").upsert(
          {
            network_id: appNet,
            bigi_plan_id: `ALR-${p.id}`,
            plan_type: (p.plantype || "SME").toUpperCase(),
            volume: p.size.replace(/\.0+/, ""),
            validity: p.validity || "30 DAYS",
            buy_price: buyPrice,
            retail_price: retail > buyPrice ? retail : buyPrice,
            is_active: true,
            alrahuz_plan_id: String(p.id),
            alrahuz_buy_price: buyPrice,
          },
          { onConflict: "bigi_plan_id", ignoreDuplicates: false }
        );
        if (error) {
          console.warn(`  ⚠️ upsert ${p.size} (#${p.id}) failed: ${error.message}`);
        } else {
          existing.push({
            network_id: appNet,
            volume: p.size,
            alrahuz_plan_id: String(p.id),
            id: "new",
          });
          inserted++;
        }
      }
    }
  }

  console.log(`\nDone. Matched existing plans: ${matched}, inserted new: ${inserted}`);
}

main().catch((err) => {
  console.error("Sync failed:", err.message);
  process.exit(1);
});
