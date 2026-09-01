// Admin user management via the official Supabase Auth Admin API.
// Usage:
//   node scripts/create-admin.js <email> <password> [full_name]
//   node scripts/remove-admin.js <email>
//   node scripts/list-admins.js
//
// The auth.admin.createUser() API creates the auth user, identity, and
// email confirmation atomically — exactly like the existing dashboard admin.
require("dotenv").config();
const supabase = require("../config/supabase.js");

const [,, cmd, arg1, arg2, arg3] = process.argv;

async function ensureProfileAndWallet(userId, email, fullName) {
  const { data: profile, error: profileErr } = await supabase
    .from("profiles")
    .upsert(
      {
        id: userId,
        full_name: fullName || "Admin",
        email,
        email_verified: true,
        is_admin: true,
        role: "admin",
      },
      { onConflict: "id" }
    )
    .select()
    .single();

  if (profileErr) throw new Error(`profile upsert failed: ${profileErr.message}`);

  const { error: walletErr } = await supabase
    .from("wallets")
    .upsert({ user_id: userId, balance: 0 }, { onConflict: "user_id" });

  if (walletErr) throw new Error(`wallet upsert failed: ${walletErr.message}`);
  return profile;
}

async function createAdmin() {
  const email = (arg1 || "").toLowerCase().trim();
  const password = (arg2 || "").trim();
  const fullName = (arg3 || "").trim() || "Admin";

  if (!email || !password) {
    console.error("Usage: node scripts/create-admin.js <email> <password> [full_name]");
    process.exit(1);
  }

  // Check if the user already exists in auth
  const { data: existingList } = await supabase.auth.admin.listUsers();
  const existing = existingList?.users?.find((u) => u.email === email);

  if (existing) {
    // Promote existing user to admin (their password stays as-is)
    await ensureProfileAndWallet(existing.id, email, fullName);
    console.log(`✅ Existing user promoted to admin: ${email} (${existing.id})`);
    return;
  }

  // Create via official admin API — correct auth user + identity + confirmation
  const { data: created, error: createErr } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName },
  });

  if (createErr) {
    console.error(`❌ Failed to create user: ${createErr.message}`);
    process.exit(1);
  }

  await ensureProfileAndWallet(created.user.id, email, fullName);
  console.log(`✅ Admin created: ${email} (${created.user.id})`);
}

async function removeAdmin() {
  const email = (arg1 || "").toLowerCase().trim();
  if (!email) {
    console.error("Usage: node scripts/remove-admin.js <email>");
    process.exit(1);
  }

  const { data: list } = await supabase.auth.admin.listUsers();
  const user = list?.users?.find((u) => u.email === email);

  if (!user) {
    console.error(`❌ No auth user found for ${email}`);
    process.exit(1);
  }

  // Safety: keep at least one admin
  const { data: admins } = await supabase
    .from("profiles")
    .select("id")
    .eq("is_admin", true)
    .neq("id", user.id);

  if (!admins || admins.length === 0) {
    console.error("❌ Cannot remove the last admin.");
    process.exit(1);
  }

  // Demote profile (do NOT delete the account, just remove admin role)
  const { error } = await supabase
    .from("profiles")
    .update({ is_admin: false, role: "user" })
    .eq("id", user.id);

  if (error) {
    console.error(`❌ Failed to demote: ${error.message}`);
    process.exit(1);
  }
  console.log(`✅ Admin removed (demoted to user): ${email}`);
}

async function listAdmins() {
  const { data, error } = await supabase
    .from("profiles")
    .select("id, full_name, email, role, is_admin, created_at")
    .or("is_admin.eq.true,role.eq.admin")
    .order("created_at", { ascending: true });

  if (error) {
    console.error(`❌ Failed to list admins: ${error.message}`);
    process.exit(1);
  }
  console.log(JSON.stringify(data || [], null, 2));
}

(async () => {
  switch (cmd) {
    case "create":
      await createAdmin();
      break;
    case "remove":
      await removeAdmin();
      break;
    case "list":
      await listAdmins();
      break;
    default:
      console.error("Commands: create <email> <password> [name] | remove <email> | list");
      process.exit(1);
  }
})();
