// wallet edge function — port of the Express /api/v2/wallet/virtual-account.
// Deployed with verify_jwt = true; the app sends its Supabase access token.
// Endpoint (path after /functions/v1/wallet):
//   POST /virtual-account -> create/return the user's Squad virtual account

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { handleCors, json, routePath } from "../_shared/cors.ts";
import { getSupabase } from "../_shared/supabase.ts";
import { requestJson } from "../_shared/net.ts";
import { getUserFromReq, formatLocalPhone, formatSquadGender } from "../_shared/helpers.ts";

serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const path = routePath(req);
    if (req.method !== "POST") return json({ success: false, message: "Method not allowed" }, 405);

    const body = await req.json().catch(() => ({}));

    switch (path) {
      case "/virtual-account":
        return await virtualAccount(req, body);
      default:
        return json({ success: false, message: "Not found" }, 404);
    }
  } catch (error: any) {
    const errorDetails = error?.response?.data || error.message;
    console.error("❌ Squad Integration Error:", JSON.stringify(errorDetails, null, 2));
    return json(
      {
        success: false,
        message: error?.response?.data?.message || "Failed to create virtual account with Squad",
        details: errorDetails,
      },
      error?.response?.status || 500,
    );
  }
});

async function virtualAccount(req: Request, body: any) {
  const {
    userId, customer_identifier,
    firstName, first_name,
    lastName, last_name,
    phone, phone_number, mobile_num,
    bvn, dob, gender, address, email,
  } = body;

  const targetUserId = userId || customer_identifier;

  let userEmail = String(email || "").toLowerCase().trim();
  if (!userEmail) {
    const user = await getUserFromReq(req);
    if (user) userEmail = String(user.email || "").toLowerCase().trim();
  }

  if (!targetUserId || !userEmail) {
    return json({ success: false, message: "User ID and Email are required" }, 400);
  }

  const { data: profile } = await getSupabase()
    .from("profiles")
    .select("virtual_account_number, virtual_bank_name, virtual_account_name")
    .eq("id", targetUserId)
    .maybeSingle();

  if (profile?.virtual_account_number) {
    return json({
      success: true,
      account_number: profile.virtual_account_number,
      bank_name: profile.virtual_bank_name || "GTBank / Squad",
      account_name: profile.virtual_account_name,
    });
  }

  const cleanBvn = String(bvn || "").replace(/\D/g, "");
  if (!cleanBvn || cleanBvn.length !== 11) {
    return json({ success: false, message: "Invalid BVN. Must be exactly 11 digits." }, 400);
  }

  const cleanPhone = formatLocalPhone(phone || phone_number || mobile_num);
  const genderCode = formatSquadGender(gender);

  const squadSecret = Deno.env.get("SQUADCO_SECRET_KEY") || Deno.env.get("SQUAD_SECRET_KEY") || "";
  let squadBaseUrl = Deno.env.get("SQUAD_BASE_URL") ||
    (squadSecret.includes("_test_") ? "https://sandbox-api-d.squadco.com" : "https://api-d.squadco.com");
  squadBaseUrl = squadBaseUrl.trim().replace(/\/+$/, "");

  const payload = {
    customer_identifier: String(targetUserId),
    first_name: String(firstName || first_name || "Customer").trim(),
    last_name: String(lastName || last_name || "User").trim(),
    mobile_num: cleanPhone || "08012345678",
    email: userEmail,
    bvn: cleanBvn,
    dob: String(dob || "01/01/1990").trim(),
    gender: genderCode,
    address: String(address || "Maiduguri, Nigeria").trim(),
    beneficiary_account: Deno.env.get("SQUAD_BENEFICIARY_ACCOUNT") || "0123456789",
  };

  let response: any;
  try {
    response = await requestJson(squadBaseUrl + "/virtual-account/business", {
      method: "POST",
      headers: { Authorization: "Bearer " + squadSecret, "Content-Type": "application/json" },
      body: payload,
    });
  } catch (apiErr: any) {
    if (apiErr?.response?.status === 404) {
      response = await requestJson(squadBaseUrl + "/virtual-account", {
        method: "POST",
        headers: { Authorization: "Bearer " + squadSecret, "Content-Type": "application/json" },
        body: payload,
      });
    } else {
      throw apiErr;
    }
  }

  const squadData = response.data;

  if (squadData.status === 200 || squadData.success) {
    const va = squadData.data || squadData;
    const accNo = va.virtual_account_number || va.account_number;
    const bankName = va.bank_name || "GTBank / Squad";
    const accName = va.account_name || (payload.first_name + " " + payload.last_name);

    await getSupabase()
      .from("profiles")
      .update({
        virtual_account_number: accNo,
        virtual_bank_name: bankName,
        virtual_account_name: accName,
      })
      .eq("id", targetUserId);

    return json({
      success: true,
      account_number: accNo,
      bank_name: bankName,
      account_name: accName,
    });
  }

  return json({
    success: false,
    message: squadData.message || "Squad API error",
    details: squadData.data,
  }, 400);
}
