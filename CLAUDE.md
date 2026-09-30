# CLAUDE.md

Operating manual for Claude Code on this project. Keep it short; put the "why" in ARCHITECTURE.md.

## What this is

A poker home-game tracker for groups of friends. Players form a "house," record
in-person cash games, and see per-game and all-time leaderboards. It also computes
the optimal (fewest-transaction) way to settle up at the end of a game.
This is NOT an online poker game — no gameplay, no real-money gambling backend.

## Stack

- Frontend: React Native + Expo (TypeScript)
- Backend / auth / database: Supabase (Postgres)
- Auth methods: Google and email only (no phone auth)
- Local storage: session token only, for "remember me" / skip-login

## Commands

- `npx expo start` — run the app (Expo Dev Client / simulator)
- `npm run lint` — lint
- `npm run test` — run both test projects (settlement logic must stay covered)
- `npm run test:unit` — pure logic only (`src/**`)
- `npm run test:schema` — applies `supabase/migrations/` to an in-process Postgres
  (PGlite, no Docker) and exercises the RLS policies and triggers
- `supabase start` — run the local Supabase stack
- `supabase db diff` / `supabase db push` — create and apply schema migrations

(If a command differs from the real setup, update this file rather than guessing.)

## Architecture map

- `ARCHITECTURE.md` — data model, key decisions, and the reasoning. Read it first.
- `src/app/` — screens and navigation (Expo Router)
  - `houses/[id]/` is a directory, not a file: it also holds `game/[gameId].tsx`.
    The house view itself is `houses/[id]/index.tsx`.
  - `profile.tsx` — the signed-in user's own account (name, avatar, change
    password, sign out); reachable via the header button on every other screen
- `src/components/` — reusable UI
- `src/lib/supabase.ts` — Supabase client
- `src/lib/auth.tsx` — `AuthProvider` / `useAuth()`; the one source of session
  state, and (since the profile feature) of the current user's profile too
- `src/lib/profile.ts` — a user's own name, avatar upload, and password change
- `src/lib/houses.ts` — house queries (list / create / join); screens never query directly
- `src/lib/games.ts` — games, players, buy-ins, the leaderboard, and
  `computeGameSettlement` (bridges a game's players into `settle()`)
- `src/lib/format.ts` — dollars-string ⇄ integer-cents, and date display (pure, tested)
- `src/lib/postgrest.ts` — shared Postgres-error-code helpers for the `lib/*` data modules
- `src/lib/settlement.ts` — pure settlement algorithm (no UI, no DB); the exported
  function is `settle`, not `computeSettlement`
- `supabase/migrations/` — SQL schema
- `tests/` — schema tests (Postgres in WASM); `tests/support/pglite.ts` stubs the
  bits of Supabase the migrations assume: `auth.uid()` and the `anon` /
  `authenticated` roles
- `jest.setup.js` — mocks `@react-native-async-storage/async-storage` for the `unit`
  project. Any `src/lib/*.test.ts` that imports something touching
  `@/lib/supabase` (most of `src/lib/` does, transitively) needs this or it crashes
  with "NativeModule: AsyncStorage is null" - there is no native runtime under Jest.

Source lives under `src/` (the Expo SDK 57 layout). Import across it with the `@/*`
alias, e.g. `import { settle } from "@/lib/settlement"`.

## Conventions

- All money is stored as integer cents (`*_cents`). Divide by 100 only at display time.
- A player's net is ALWAYS computed (`final_stack_cents − sum(buy_ins)`), never stored.
- The leaderboard is that same net summed across the house's games, grouped by user.
- TypeScript everywhere; prefer explicit types on data crossing the DB boundary.
- Table/column names: snake_case. React components: PascalCase.

## Hard rules

- Only `status = 'settled'` games count toward any leaderboard or stat. Never let an
  `active` game move the standings.
- Never store a derived net or leaderboard total — always recompute from buy_ins and
  final stacks, so the numbers can't drift.
- Never commit secrets. Supabase keys and OAuth secrets live in env vars / Expo config.
- Rely on Supabase Row-Level Security so a user can only read/write houses they belong
  to. Don't bypass RLS with the service-role key in the app.
- Ask before changing the database schema — write a migration, don't edit tables ad hoc.

## Workflow preferences

- Build depth-first: one thin vertical slice working end-to-end before widening.
- Write a test for the settlement logic before wiring it into the UI.
- When a decision is made, record it in ARCHITECTURE.md so future sessions inherit it.
