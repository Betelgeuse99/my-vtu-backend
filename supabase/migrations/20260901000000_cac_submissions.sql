-- CAC Submissions table
-- Run this in Supabase SQL Editor: https://supabase.com/dashboard/project/lraryzkamshicildghdv/sql

create table if not exists cac_submissions (
  id bigint generated always as identity primary key,
  user_id text,
  registration_type text not null,
  proposed_name text,
  alt_name text,
  email text,
  phone text,
  nature_of_business text,
  registered_address text,
  head_office_address text,
  business_type text,
  proprietor jsonb default '{}'::jsonb,
  directors jsonb default '[]'::jsonb,
  shareholders jsonb default '[]'::jsonb,
  shares jsonb default '{}'::jsonb,
  pscs jsonb default '[]'::jsonb,
  guarantee jsonb default '{}'::jsonb,
  trustees jsonb default '[]'::jsonb,
  secretary jsonb default '{}'::jsonb,
  compliance jsonb default '{}'::jsonb,
  additional jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);

-- Allow authenticated users to insert their own submissions
alter table cac_submissions enable row level security;

create policy "Users can insert own submissions" on cac_submissions
  for insert with check (auth.uid()::text = user_id or user_id = 'anonymous');

create policy "Users can read own submissions" on cac_submissions
  for select using (auth.uid()::text = user_id or user_id = 'anonymous');

-- Admin access (service role key bypasses RLS, so this is for the admin dashboard)
-- The admin dashboard uses the service role key via the backend API, so RLS is bypassed.
