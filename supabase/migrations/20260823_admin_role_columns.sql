-- =============================================================
-- ADD ADMIN ROLE COLUMNS TO PROFILES
-- Adds is_admin and role columns needed by the admin dashboard.
-- =============================================================

-- Add is_admin column (boolean, defaults to false)
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false;

-- Add role column (text, defaults to 'user')
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user';

-- Index for fast admin lookups
CREATE INDEX IF NOT EXISTS idx_profiles_is_admin ON public.profiles (is_admin) WHERE is_admin = true;

-- =============================================================
-- SET ADMIN USER
-- Run this AFTER creating the user in Supabase Dashboard:
--   Authentication → Users → Add User
--   Email: admin@dreamhatchertech.com
--   Password: today1@
--   Auto Confirm: ✅ Yes
-- =============================================================

UPDATE profiles
SET is_admin = true, role = 'admin'
WHERE email = 'admin@dreamhatchertech.com';

-- Verify
SELECT id, email, full_name, is_admin, role
FROM profiles
WHERE email = 'admin@dreamhatchertech.com';
