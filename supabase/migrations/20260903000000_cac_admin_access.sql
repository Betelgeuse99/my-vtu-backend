-- =============================================================
-- CAC SUBMISSIONS — ADMIN ACCESS (fixes "admin cannot see/download forms")
--
-- Problem: cac_submissions RLS only lets a user read rows where
--   auth.uid()::text = user_id OR user_id = 'anonymous'.
-- The admin dashboard reads with the admin's OWN JWT (anon/authenticated),
-- so submissions made by other signed-in web users and by the Android app
-- (user_id NULL) were invisible — and DELETE silently did nothing.
--
-- Fix: security-definer RPCs (owned by postgres, bypass RLS) that first
-- verify the caller is an admin via public.profiles, then return/delete
-- across ALL rows.  The dashboard calls these through PostgREST with the
-- admin's access token — no service-role key leaves the server.
-- =============================================================

-- 1) List every CAC submission (admin only)
create or replace function public.admin_cac_submissions(limit_count integer default 200)
returns setof public.cac_submissions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null or not exists (
    select 1 from public.profiles p
    where p.id = v_uid and (p.is_admin = true or p.role = 'admin')
  ) then
    raise exception 'Admin access required'
      using errcode = '42501';
  end if;

  return query
    select c.*
    from public.cac_submissions c
    order by c.created_at desc nulls last, c.id desc
    limit least(coalesce(limit_count, 200), 1000);
end;
$$;

grant execute on function public.admin_cac_submissions(integer) to authenticated;

-- 2) Delete one CAC submission (admin only)
create or replace function public.admin_cac_delete(p_id bigint)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null or not exists (
    select 1 from public.profiles p
    where p.id = v_uid and (p.is_admin = true or p.role = 'admin')
  ) then
    raise exception 'Admin access required'
      using errcode = '42501';
  end if;

  delete from public.cac_submissions where id = p_id;
  return found;
end;
$$;

grant execute on function public.admin_cac_delete(bigint) to authenticated;

-- =============================================================
-- APPLY
--   Option A (SQL editor): copy this whole file into
--     https://supabase.com/dashboard/project/lraryzkamshicildghdv/sql
--   Option B (CLI):         supabase db push   (from my-vtu-backend/)
-- =============================================================
