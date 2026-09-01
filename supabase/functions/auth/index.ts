// auth edge function — port of the Express /auth/* routes.
// Unauthenticated by design: deploy with verify_jwt = false (see config.toml).
// Endpoints (path after /functions/v1/auth):
//   POST /send-otp        -> generate OTP, email it via Brevo, store in temp_otps
//   POST /verify-otp      -> validate OTP, create/update Supabase auth user + profile + wallet
//   POST /login           -> signInWithPassword, return session + profile + wallet
//   POST /refresh         -> exchange refresh_token for a fresh session
//   POST /reset-password  -> validate OTP, update the auth user's password

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { handleCors, json, routePath } from "../_shared/cors.ts";
import { getSupabase, getSupabaseAuth } from "../_shared/supabase.ts";
import { requestJson } from "../_shared/net.ts";

const DEFAULT_PASSWORD = "Dreamhatcher@2026#Secure";

serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const path = routePath(req);
    if (req.method !== "POST") return json({ success: false, message: "Method not allowed" }, 405);

    const body = await req.json().catch(() => ({}));

    switch (path) {
      case "/send-otp":
        return await sendOtp(body);
      case "/verify-otp":
        return await verifyOtp(body);
      case "/login":
        return await login(body);
      case "/refresh":
        return await refresh(body);
      case "/reset-password":
        return await resetPassword(body);
      default:
        return json({ success: false, message: "Not found" }, 404);
    }
  } catch (err: any) {
    console.error("❌ Auth error:", err.message);
    return json({ success: false, message: err.message || "Auth service error" }, 500);
  }
});

async function sendOtp(body: any) {
  const { email } = body;
  if (!email) return json({ success: false, message: "Email required" }, 400);

  const cleanEmail = String(email).toLowerCase().trim();
  const otpCode = Math.floor(100000 + Math.random() * 900000).toString();

  try {
    const { error: dbErr } = await getSupabase()
      .from("temp_otps")
      .upsert({ email: cleanEmail, otp: otpCode, created_at: new Date() }, { onConflict: "email" });
    if (dbErr) console.warn("⚠️ temp_otps warning:", dbErr.message);

    await requestJson("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "api-key": Deno.env.get("BREVO_API_KEY") || "",
        "content-type": "application/json",
      },
      body: {
        sender: {
          name: Deno.env.get("SENDER_NAME") || "Dreamhatcher",
          email: Deno.env.get("SENDER_EMAIL"),
        },
        to: [{ email: cleanEmail }],
        subject: `${otpCode} is your Dreamhatcher Verification Code`,
        htmlContent: `<html><body><h2>Dreamhatcher Verification</h2><p>Your code is: <b>${otpCode}</b></p></body></html>`,
      },
    });

    return json({ success: true, message: "Verification code sent" });
  } catch (err: any) {
    console.error("❌ Send OTP Error:", err.message);
    return json({ success: false, message: "Failed to send OTP code" }, 500);
  }
}

async function verifyOtp(body: any) {
  const email = String(body.email || "").toLowerCase().trim();
  const otp = String(body.otp || "").trim();
  const password = body.password && String(body.password).trim().length >= 6
    ? String(body.password).trim()
    : DEFAULT_PASSWORD;
  const fullName = body.full_name || body.fullName || "User";
  const phoneNumber = body.phone_number || body.phoneNumber || "";

  if (!email || !otp) {
    return json({ success: false, message: "Email and OTP required" }, 400);
  }

  try {
    const { data: otpData } = await getSupabase()
      .from("temp_otps")
      .select("*")
      .eq("email", email)
      .eq("otp", otp)
      .maybeSingle();

    if (!otpData) {
      return json({ success: false, message: "Invalid or expired OTP." }, 400);
    }

    const supabase = getSupabase();
    let userId: string;
    const { data: userList } = await supabase.auth.admin.listUsers();
    const existing = userList?.users?.find((u: any) => u.email === email);

    if (existing) {
      userId = existing.id;
      await supabase.auth.admin.updateUserById(userId, {
        password,
        user_metadata: { full_name: fullName },
      });
    } else {
      const { data: authUser, error: authError } = await supabase.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { full_name: fullName },
      });
      if (authError) throw authError;
      userId = authUser.user.id;
    }

    const { data: profile } = await supabase
      .from("profiles")
      .upsert({
        id: userId,
        full_name: fullName,
        phone_number: phoneNumber,
        email,
        email_verified: true,
      }, { onConflict: "id" })
      .select()
      .single();

    await supabase.from("wallets").upsert({ user_id: userId, balance: 0 }, { onConflict: "user_id" });
    await supabase.from("temp_otps").delete().eq("email", email);

    return json({ success: true, message: "Verification successful", userId, user: profile });
  } catch (err: any) {
    console.error("❌ VERIFY_ERROR:", err.message);
    return json({ success: false, message: err.message }, 500);
  }
}

async function login(body: any) {
  const email = String(body.email || "").toLowerCase().trim();
  const password = String(body.password || "").trim();
  const requireAdmin = body.admin === true;

  if (!email || !password) {
    return json({ success: false, message: "Email and password required" }, 400);
  }

  try {
    const { data: authData, error: authError } = await getSupabaseAuth().auth.signInWithPassword({
      email,
      password,
    });

    if (authError || !authData.user) {
      return json({ success: false, message: "Invalid email or password" }, 401);
    }

    const { data: profile } = await getSupabase()
      .from("profiles")
      .select("*")
      .eq("id", authData.user.id)
      .maybeSingle();

    // Admin-dashboard logins must come from an admin account. Reject others with
    // the same message as bad credentials so we don't leak whether an account exists.
    if (requireAdmin) {
      const isAdmin = profile && (profile.is_admin === true || profile.role === "admin");
      if (!isAdmin) {
        return json({ success: false, message: "Invalid email or password" }, 401);
      }
    }

    const { data: wallet } = await getSupabase()
      .from("wallets")
      .select("*")
      .eq("user_id", authData.user.id)
      .maybeSingle();

    return json({
      success: true,
      message: "Login successful",
      userId: authData.user.id,
      user: profile || { email, id: authData.user.id },
      wallet: wallet || { balance: 0 },
      session: authData.session,
    });
  } catch (err: any) {
    console.error("❌ LOGIN_ERROR:", err.message);
    return json({ success: false, message: "Login service error" }, 500);
  }
}

async function refresh(body: any) {
  const refreshToken = body.refresh_token;
  if (!refreshToken) {
    return json({ success: false, message: "refresh_token required" }, 400);
  }
  try {
    const { data, error } = await getSupabaseAuth().auth.refreshSession({
      refresh_token: refreshToken,
    });
    if (error || !data?.session) {
      return json({ success: false, message: "Session expired — please sign in again" }, 401);
    }
    return json({
      success: true,
      session: {
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
        expires_at: data.session.expires_at,
      },
      user: data.user ? { id: data.user.id, email: data.user.email } : null,
    });
  } catch (err: any) {
    console.error("❌ Token refresh error:", err.message);
    return json({ success: false, message: "Refresh failed" }, 500);
  }
}

/**
 * POST /reset-password — validates the email+OTP pair from temp_otps (the
 * Forgot Password flow reuses the same OTP emailer), then sets the new
 * password on the Supabase auth user. Used by BOTH the Android app and the
 * website; previously this route only existed on the (now decommissioned)
 * Render Express server.
 */
async function resetPassword(body: any) {
  const email = String(body.email || "").toLowerCase().trim();
  const otp = String(body.otp || "").trim();
  const password = String(body.password || "").trim();

  if (!email || !otp) {
    return json({ success: false, message: "Email and OTP required" }, 400);
  }
  if (password.length < 6) {
    return json({ success: false, message: "Password must be at least 6 characters" }, 400);
  }

  try {
    const { data: otpData } = await getSupabase()
      .from("temp_otps")
      .select("*")
      .eq("email", email)
      .eq("otp", otp)
      .maybeSingle();

    if (!otpData) {
      return json({ success: false, message: "Invalid or expired OTP." }, 400);
    }

    const { data: userList } = await getSupabase().auth.admin.listUsers();
    const existing = userList?.users?.find((u: any) => u.email === email);
    if (!existing) {
      return json({ success: false, message: "No account found for this email" }, 400);
    }

    const { error: updateError } = await getSupabase().auth.admin.updateUserById(existing.id, {
      password,
      user_metadata: { ...(existing.user_metadata || {}), full_name: existing.user_metadata?.full_name || "User" },
    });
    if (updateError) throw updateError;

    await getSupabase().from("temp_otps").delete().eq("email", email);

    return json({ success: true, message: "Password reset successful" });
  } catch (err: any) {
    console.error("❌ RESET_PASSWORD_ERROR:", err.message);
    return json({ success: false, message: err.message || "Password reset failed" }, 500);
  }
}
