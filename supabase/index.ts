// Supabase Edge Function: create-virtual-account
// Creates virtual accounts via Squad API with proper BVN verification
//
// Deploy: supabase functions deploy create-virtual-account
// Set environment variable: SQUAD_SECRET_KEY

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const squadSecretKey = Deno.env.get("SQUAD_SECRET_KEY")!;

    if (!squadSecretKey) {
      console.error("SQUAD_SECRET_KEY is missing");
      return new Response(
        JSON.stringify({ error: "Server configuration error" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Get the authenticated user
    const authHeader = req.headers.get("Authorization") || "";
    const userSupabase = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user }, error: authError } = await userSupabase.auth.getUser();
    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Parse request body
    const body = await req.json();
    const { bvn, dob, gender, address, phone_number, first_name, last_name } = body;

    console.log("REQUEST BODY:", JSON.stringify({ ...body, bvn: "****" }));

    // Validate required fields
    if (!bvn || bvn.length !== 11) {
      return new Response(
        JSON.stringify({ error: "BVN must be 11 digits" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!dob) {
      return new Response(
        JSON.stringify({ error: "Date of birth is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Get user profile for fallback and email
    const { data: profile } = await supabase
      .from("profiles")
      .select("full_name, email, phone_number")
      .eq("id", user.id)
      .single();

    // Use names from request if provided, otherwise fallback to profile
    let firstName = first_name;
    let lastName = last_name;

    if (!firstName || !lastName) {
      const fullName = profile?.full_name || user.user_metadata?.full_name || user.email?.split("@")[0] || "User";
      const nameParts = fullName.split(" ").filter(Boolean);
      firstName = firstName || nameParts[0] || "User";
      lastName = lastName || (nameParts.length > 1 ? nameParts[nameParts.length - 1] : "Account");
    }

    const email = user.email || profile?.email || "";
    const phone = phone_number || profile?.phone_number || user.user_metadata?.phone_number || "";

    if (!phone) {
      return new Response(
        JSON.stringify({ error: "Phone number is required. Please update your profile." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Format phone to exactly 11 digits (remove +234 or any non-digits)
    let formattedPhone = phone.replace(/\D/g, "");
    if (formattedPhone.startsWith("234") && formattedPhone.length > 11) {
      formattedPhone = "0" + formattedPhone.substring(3);
    }
    // Ensure it's 11 digits
    if (formattedPhone.length !== 11) {
      // If it's 10 digits and doesn't start with 0, prepend 0
      if (formattedPhone.length === 10 && !formattedPhone.startsWith("0")) {
          formattedPhone = "0" + formattedPhone;
      }
    }

    // Format DOB to MM/DD/YYYY for Squad API (docs sample: "07/19/1990")
    let formattedDob = dob.trim();
    if (formattedDob.includes("/")) {
      const parts = formattedDob.split("/");
      if (parts.length === 3) {
        // If DD/MM/YYYY -> MM/DD/YYYY
        if (parts[0].length <= 2 && parts[2].length === 4) {
          formattedDob = `${parts[1].padStart(2, "0")}/${parts[0].padStart(2, "0")}/${parts[2]}`;
        }
        // If YYYY/MM/DD -> MM/DD/YYYY
        else if (parts[0].length === 4) {
          formattedDob = `${parts[1].padStart(2, "0")}/${parts[2].padStart(2, "0")}/${parts[0]}`;
        }
      }
    } else if (formattedDob.includes("-")) {
      const parts = formattedDob.split("-");
      if (parts.length === 3) {
          // If YYYY-MM-DD -> MM/DD/YYYY
          if (parts[0].length === 4) {
              formattedDob = `${parts[1].padStart(2, "0")}/${parts[2].padStart(2, "0")}/${parts[0]}`;
          }
          // If DD-MM-YYYY -> MM/DD/YYYY
          else if (parts[0].length <= 2 && parts[2].length === 4) {
              formattedDob = `${parts[1].padStart(2, "0")}/${parts[0].padStart(2, "0")}/${parts[2]}`;
          }
      }
    }

    // Gender mapping for Squad API: '1' = Male, '2' = Female
    const genderCode = (gender === "Male" || gender === "1") ? "1" : "2";
    const dbGender = (gender === "Male" || gender === "1") ? "Male" : "Female";

    // Generate unique customer identifier
    const customerIdentifier = `VTU_${user.id.substring(0, 8)}_${Date.now()}`;

    // Call Squad Virtual Account API (Customer/B2C model)
    const squadPayload: any = {
      customer_identifier: customerIdentifier,
      first_name: firstName,
      last_name: lastName,
      mobile_num: formattedPhone,
      email: email,
      bvn: bvn,
      dob: formattedDob,
      address: address,
      gender: genderCode,
    };

    // middle_name is expected by the API when available; omitted otherwise.
    if (body.middle_name) {
      squadPayload.middle_name = body.middle_name;
    }

    // Determine API URL based on key or environment
    let squadBaseUrl = "https://api.squadco.com";
    if (squadSecretKey.includes("_test_") || squadSecretKey.includes("_sandbox_") || Deno.env.get("SQUAD_ENV") === "sandbox") {
      squadBaseUrl = "https://sandbox-api-d.squadco.com";
    }

    // Customer (B2C) model: creates a virtual account for an individual, validating
    // the BVN against the provided name, DOB, gender and phone number.
    // (The /virtual-account/business endpoint is for businesses and rejects these fields.)
    const squadEndpoint = `${squadBaseUrl}/virtual-account`;

    console.log("Using Squad URL:", squadEndpoint);
    console.log("FULL REQUEST TO SQUAD:", JSON.stringify({ ...squadPayload, bvn: "****" }));

    let squadResult;
    try {
        const squadResponse = await fetch(squadEndpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${squadSecretKey}`,
          },
          body: JSON.stringify(squadPayload),
        });

        squadResult = await squadResponse.json();
    } catch (fetchErr) {
        console.error("Squad fetch error:", fetchErr);
        return new Response(
            JSON.stringify({
                success: false,
                error: "Failed to connect to Squad API",
                details: fetchErr.message
            }),
            { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
    }

    console.log("FULL RESPONSE FROM SQUAD:", JSON.stringify(squadResult));

    if (!squadResult.success || squadResult.status !== 200) {
      console.error("Squad API Failure Details:", JSON.stringify(squadResult));

      // Extract specific error message from Squad response
      let errorMessage = squadResult.message || "Squad API error";

      // Squad sometimes returns detailed validation errors in 'data'
      if (squadResult.data) {
          if (typeof squadResult.data === 'string') {
              errorMessage = squadResult.data;
          } else if (typeof squadResult.data === 'object') {
              // Handle case where data is an object with field-specific errors
              errorMessage = Object.values(squadResult.data).flat().join(", ") || errorMessage;
          }
      }

      // If it's a BVN mismatch, be explicit
      if (errorMessage.toLowerCase().includes("bvn") && errorMessage.toLowerCase().includes("match")) {
          errorMessage = "BVN details do not match the provided name or date of birth.";
      }

      // Save failed attempt (Only include notes if you've run the SQL migration)
      try {
          await supabase.from("kyc_submissions").upsert({
            user_id: user.id,
            bvn: bvn,
            dob: dob,
            gender: dbGender,
            address: address,
            status: "rejected"
            // notes: errorMessage // Uncomment this after running SQL to add 'notes' column
          });
      } catch (dbErr) {
          console.error("Database logging failed:", dbErr);
      }

      return new Response(
        JSON.stringify({
          success: false,
          error: errorMessage,
          message: errorMessage,
          squad_response: squadResult,
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Success — save to multiple tables for maximum compatibility
    const vaData = squadResult.data;
    const accountNumber = vaData.virtual_account_number;
    const bankName = vaData.bank_name || "GTBank";
    const accountName = vaData.account_name || `${firstName} ${lastName}`;

    // 1. Update KYC status
    await supabase.from("kyc_submissions").upsert({
      user_id: user.id,
      bvn: bvn,
      dob: dob,
      gender: dbGender,
      address: address,
      status: "approved",
    });

    // 2. Update virtual_accounts table (Legacy support)
    await supabase.from("virtual_accounts").upsert({
      user_id: user.id,
      account_number: accountNumber,
      bank_name: bankName,
      bank_code: vaData.bank_code || "058",
      account_name: accountName,
      customer_identifier: customerIdentifier,
    });

    // 3. Update profiles table (New standard) - will work even if columns are missing but best to run SQL
    try {
        await supabase.from("profiles").update({
          squad_account_number: accountNumber,
          squad_bank_name: bankName,
          squad_account_name: accountName,
          kyc_status: "verified"
        }).eq("id", user.id);
    } catch (e) {
        console.warn("Profiles update failed (columns might be missing):", e.message);
    }

    // 4. Update wallets table
    try {
        await supabase.from("wallets").update({
          // account_number: accountNumber, // Uncomment if you add this column to wallets
          updated_at: new Date().toISOString()
        }).eq("user_id", user.id);
    } catch (e) {
        console.warn("Wallets update failed:", e.message);
    }

    return new Response(
      JSON.stringify({
        success: true,
        data: {
          account_number: accountNumber,
          bank_name: bankName,
          account_name: accountName,
        },
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (err) {
    console.error("create-virtual-account error:", err);
    return new Response(
      JSON.stringify({ error: "Internal server error", details: err.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
