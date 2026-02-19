-- Run this in a NEW Supabase project SQL editor.

create extension if not exists pgcrypto;

create table if not exists public.game_rooms (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  host_user_id uuid not null references auth.users(id) on delete cascade,
  expected_players int not null check (expected_players between 2 and 5),
  status text not null default 'waiting' check (status in ('waiting', 'active', 'finished')),
  game_state jsonb,
  version int not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.room_players (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.game_rooms(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  display_name text not null,
  player_index int not null,
  joined_at timestamptz not null default now(),
  unique(room_id, user_id),
  unique(room_id, player_index)
);

create index if not exists idx_game_rooms_code on public.game_rooms(code);
create index if not exists idx_room_players_room_id on public.room_players(room_id);

alter table public.game_rooms enable row level security;
alter table public.room_players enable row level security;

-- Authenticated users can create/read rooms.
drop policy if exists "rooms_select_auth" on public.game_rooms;
create policy "rooms_select_auth"
  on public.game_rooms for select
  to authenticated
  using (true);

drop policy if exists "rooms_insert_auth" on public.game_rooms;
create policy "rooms_insert_auth"
  on public.game_rooms for insert
  to authenticated
  with check (auth.uid() = host_user_id);

drop policy if exists "rooms_update_host" on public.game_rooms;
create policy "rooms_update_host"
  on public.game_rooms for update
  to authenticated
  using (auth.uid() = host_user_id)
  with check (auth.uid() = host_user_id);

-- Authenticated users can read room players and add themselves.
drop policy if exists "room_players_select_auth" on public.room_players;
create policy "room_players_select_auth"
  on public.room_players for select
  to authenticated
  using (true);

drop policy if exists "room_players_insert_self" on public.room_players;
create policy "room_players_insert_self"
  on public.room_players for insert
  to authenticated
  with check (auth.uid() = user_id);

-- Realtime publication
alter publication supabase_realtime add table public.game_rooms;
alter publication supabase_realtime add table public.room_players;
