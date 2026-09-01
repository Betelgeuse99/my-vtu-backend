-- =============================================================
-- ADMIN USER MANAGEMENT FUNCTIONS
-- Provides safe, reusable functions to create, remove, and list
-- admin users without the "profile not found" silent failure.
-- =============================================================

-- Ensure pgcrypto is available (Supabase stores it in the extensions schema)
CREATE EXTENSION IF NOT EXISTS pgcrypto SCHEMA extensions;
GRANT USAGE ON SCHEMA extensions TO postgres, anon, authenticated, service_role;

-- =============================================================
-- 1. create_admin_user(email, password, full_name)
--    Creates a complete admin: auth user + profile + wallet.
--    If the auth user already exists, promotes them to admin.
-- =============================================================
CREATE OR REPLACE FUNCTION public.create_admin_user(
  p_email TEXT,
  p_password TEXT,
  p_full_name TEXT DEFAULT 'Admin'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_user_id UUID;
  v_email TEXT;
BEGIN
  v_email := lower(trim(p_email));

  -- Check if auth user already exists
  SELECT id INTO v_user_id FROM auth.users WHERE email = v_email;

  IF v_user_id IS NOT NULL THEN
    -- User exists — promote to admin (use UPDATE to avoid conflict issues)
    UPDATE public.profiles
    SET is_admin = true, role = 'admin', full_name = p_full_name, email = v_email
    WHERE id = v_user_id;

    -- If no profile row existed, insert one
    IF NOT FOUND THEN
      INSERT INTO public.profiles (id, full_name, email, email_verified, is_admin, role)
      VALUES (v_user_id, p_full_name, v_email, true, true, 'admin');
    END IF;

    INSERT INTO public.wallets (user_id, balance)
    VALUES (v_user_id, 0)
    ON CONFLICT (user_id) DO NOTHING;

    RETURN jsonb_build_object(
      'success', true,
      'message', 'Existing user promoted to admin',
      'user_id', v_user_id,
      'email', v_email
    );
  END IF;

  -- Create new auth user
  v_user_id := gen_random_uuid();

  INSERT INTO auth.users (
    id,
    instance_id,
    email,
    encrypted_password,
    email_confirmed_at,
    created_at,
    updated_at,
    raw_user_meta_data,
    is_super_admin,
    role
  ) VALUES (
    v_user_id,
    '00000000-0000-0000-0000-000000000000',
    v_email,
    crypt(p_password, extensions.gen_salt('bf')),
    now(),
    now(),
    now(),
    jsonb_build_object('full_name', p_full_name),
    false,
    'authenticated'
  );

  -- CRITICAL: also create the email identity in auth.identities.
  -- signInWithPassword requires this row or login fails with "Invalid email or password".
  IF NOT EXISTS (
    SELECT 1 FROM auth.identities
    WHERE provider = 'email' AND identity_data->>'sub' = v_user_id::text
  ) THEN
    INSERT INTO auth.identities (
      id, provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at
    ) VALUES (
      v_user_id, v_email, v_user_id,
      jsonb_build_object('sub', v_user_id, 'email', v_email),
      'email', now(), now(), now()
    );
  END IF;

  -- Create profile with admin flags (ON CONFLICT in case a trigger
  -- on auth.users already auto-created this profile row)
  INSERT INTO public.profiles (id, full_name, email, email_verified, is_admin, role)
  VALUES (v_user_id, p_full_name, v_email, true, true, 'admin')
  ON CONFLICT (id) DO UPDATE SET
    is_admin = true,
    role = 'admin',
    full_name = EXCLUDED.full_name,
    email = EXCLUDED.email,
    email_verified = true;

  -- Create wallet (ON CONFLICT in case the trigger created it too)
  INSERT INTO public.wallets (user_id, balance)
  VALUES (v_user_id, 0)
  ON CONFLICT (user_id) DO NOTHING;

  RETURN jsonb_build_object(
    'success', true,
    'message', 'Admin user created successfully',
    'user_id', v_user_id,
    'email', v_email
  );
END;
$$;

-- =============================================================
-- 2. remove_admin_user(email)
--    Demotes an admin back to regular user. Cannot remove the
--    last remaining admin as a safety measure.
-- =============================================================
CREATE OR REPLACE FUNCTION public.remove_admin_user(
  p_email TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email TEXT;
  v_user_id UUID;
  v_admin_count INT;
BEGIN
  v_email := lower(trim(p_email));

  -- Find the user
  SELECT id INTO v_user_id FROM auth.users WHERE email = v_email;

  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'message', 'User not found'
    );
  END IF;

  -- Safety: count remaining admins (excluding this user)
  SELECT count(*) INTO v_admin_count
  FROM public.profiles
  WHERE is_admin = true AND id != v_user_id;

  IF v_admin_count = 0 THEN
    RETURN jsonb_build_object(
      'success', false,
      'message', 'Cannot remove the last admin. Promote another user first.'
    );
  END IF;

  -- Demote to regular user
  UPDATE public.profiles
  SET is_admin = false, role = 'user'
  WHERE id = v_user_id;

  RETURN jsonb_build_object(
    'success', true,
    'message', 'Admin removed successfully',
    'user_id', v_user_id,
    'email', v_email
  );
END;
$$;

-- =============================================================
-- 3. list_admins()
--    Returns all users with admin privileges.
-- =============================================================
CREATE OR REPLACE FUNCTION public.list_admins()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result JSONB;
BEGIN
  SELECT jsonb_agg(jsonb_build_object(
    'id', p.id,
    'full_name', p.full_name,
    'email', p.email,
    'role', p.role,
    'is_admin', p.is_admin,
    'created_at', p.created_at
  )) INTO v_result
  FROM public.profiles p
  WHERE p.is_admin = true OR p.role = 'admin'
  ORDER BY p.created_at ASC;

  RETURN jsonb_build_object(
    'success', true,
    'data', COALESCE(v_result, '[]'::jsonb)
  );
END;
$$;

-- =============================================================
-- 4. Ensure the original admin is properly set up
-- =============================================================
DO $$
BEGIN
  -- Promote existing admin if they're in profiles but not yet admin
  UPDATE public.profiles
  SET is_admin = true, role = 'admin'
  WHERE email = 'admin@dreamhatchertech.com'
    AND (is_admin = false OR role != 'admin');

  -- If no profile exists for the admin email, log a reminder
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE email = 'admin@dreamhatchertech.com') THEN
    RAISE NOTICE 'No profile found for admin@dreamhatchertech.com — run: SELECT create_admin_user(''admin@dreamhatchertech.com'', ''your_password'', ''Admin Name'');';
  END IF;
END $$;

-- =============================================================
-- USAGE EXAMPLES (uncomment to run):
--
-- Create a new admin:
--   SELECT create_admin_user('newadmin@example.com', 'securepass123', 'New Admin');
--
-- Promote existing user to admin:
--   SELECT create_admin_user('existinguser@example.com', 'ignored', 'Their Name');
--
-- Remove admin (demote to user):
--   SELECT remove_admin_user('newadmin@example.com');
--
-- List all admins:
--   SELECT list_admins();
-- =============================================================
