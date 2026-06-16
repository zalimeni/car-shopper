-- Migration: per-user Anthropic API key vault (server-only)
--
-- Apply with the Supabase CLI (`supabase db push`) or the Dashboard SQL editor.
-- Idempotent and safe to re-run.
--
-- Stores each user's Anthropic API key ENCRYPTED at rest (AES-256-GCM; see
-- api/_crypto.js). The key powers AI scoring (/api/score) under the user's own
-- Anthropic account/quota. RLS is enabled with NO client policies, so anon/
-- authenticated clients cannot read or write this table at all — only the
-- server, via the service-role key (api/_supabaseAdmin.js), touches it, and
-- always scoped to the authenticated caller's own user_id. The ciphertext is
-- never returned to the browser; the UI sees only `valid` + `last4`.

create table if not exists public.user_anthropic_keys (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  ciphertext text not null,
  last4      text not null default '',
  valid      boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- RLS on, no policies => locked to the service role only.
alter table public.user_anthropic_keys enable row level security;

-- Defensively drop any policies that might exist from a prior run, so the end
-- state is deterministically "no client access".
do $$
declare pol record;
begin
  for pol in
    select policyname from pg_policies
    where schemaname = 'public' and tablename = 'user_anthropic_keys'
  loop
    execute format('drop policy %I on public.user_anthropic_keys', pol.policyname);
  end loop;
end $$;
