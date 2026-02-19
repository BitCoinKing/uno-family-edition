# UNO - Family Edition

Production-ready UNO foundation with:
- Local and realtime online multiplayer
- Google OAuth login (Supabase Auth)
- Host-authoritative turn validation
- Persistent local stats leaderboard
- Particle/confetti effects and mobile-first UI

## Project structure

```text
/src
  /core
  /engines
  /services
  /styles
  /ui
  main.js
/api
  config.js
/supabase
  schema.sql
index.html
vercel.json
```

## IMPORTANT: use a NEW Supabase project

Create a fresh Supabase project for this game so existing projects are untouched.

## 1) Supabase setup (new project)

1. Create a **new** Supabase project.
2. In SQL Editor, run `/Users/haskellmacaraig/Desktop/uno/supabase/schema.sql`.
3. Enable Google auth:
   - Supabase Dashboard -> Authentication -> Providers -> Google -> Enable
   - Add your Google OAuth Client ID + Secret
   - Redirect URL in Google Console must include:
     - `https://<your-vercel-domain>/`
     - `http://localhost:3000/` (for `vercel dev`)
4. Copy project URL + anon key from Settings -> API.

## 2) Vercel env vars

In Vercel project settings, add:
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`

`/api/config` exposes these values to the browser runtime.

## 3) Deploy / run

### Vercel deploy
Push to GitHub, import into Vercel, deploy.

### Local dev (recommended for auth callback)
```bash
cd /Users/haskellmacaraig/Desktop/uno
vercel dev
```
Open [http://localhost:3000](http://localhost:3000).

## Online flow

1. Open Setup -> switch to **Online Multiplayer**.
2. Sign in with Google.
3. Host clicks **Create Room** and shares code.
4. Other players sign in and **Join Room** with code.
5. Host clicks **Start Online Match** when lobby is full.

## Notes

- Online mode is host-authoritative: host validates intents and syncs room state.
- State sync is Supabase Realtime + Postgres (`game_rooms`, `room_players`).
- Local mode and AI continue to work offline.
