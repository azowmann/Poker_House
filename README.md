# Poker Social

A mobile app for tracking in-person poker home games with friends. Players form a
"house," record cash games (buy-ins, rebuys, cash-outs), and see per-game and
all-time leaderboards. At the end of a game the app computes the fewest money
transfers needed to settle everyone up.

This is **not** an online poker game — there's no gameplay and no real-money
gambling backend. It's a ledger for games you're already playing in person.

> **Status:** work in progress. Core flows (auth, houses, games, settlement) run
> end-to-end against a live Supabase project, but this isn't a finished product yet.

## Features

- **Houses** — create a house and get a join code, or join one a friend started
- **Live games** — add players, track buy-ins and rebuys as the game is played
- **Settling up** — enter final stacks and get the minimum set of transfers needed
  to zero everyone out (e.g. "Alice pays Bob $20, Alice pays Carol $10")
- **Leaderboards** — all-time net winnings per house, computed from game history
  (never stored, so it can't drift out of sync)
- **Auth** — Google and email sign-in via Supabase
- **Profiles** — display name, avatar upload, password change

## Tech stack

| Layer | Choice |
|---|---|
| App | [React Native](https://reactnative.dev/) + [Expo](https://expo.dev) (SDK 57), TypeScript |
| Routing | [Expo Router](https://docs.expo.dev/router/introduction/) (file-based) |
| Backend | [Supabase](https://supabase.com) — Postgres, Auth, Storage, auto-generated API |
| Access control | Postgres Row Level Security (default-deny; no service-role key in the app) |
| Testing | [Jest](https://jestjs.io/) — unit tests for pure logic, plus schema tests that run real migrations against an in-memory Postgres ([PGlite](https://github.com/electric-sql/pglite)) |

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full data model and the reasoning
behind these choices.

## Project structure

```
src/
  app/            screens and navigation (Expo Router, file-based)
  components/     reusable UI components
  lib/            data access, auth, and business logic
    settlement.ts   pure debt-simplification algorithm (no UI, no DB)
    houses.ts       house queries (create / join / list)
    games.ts        games, players, buy-ins, leaderboard, settlement bridge
    auth.tsx        AuthProvider / useAuth() — the one source of session state
    format.ts       dollars-string <-> integer-cents, date display
  constants/      theme constants
  hooks/          shared React hooks
supabase/
  migrations/     SQL schema (source of truth for the database)
tests/            schema tests (run against an in-memory Postgres)
```

## Documentation

- [ARCHITECTURE.md](./ARCHITECTURE.md) — data model, RLS/schema decisions, and the
  reasoning behind them
- [CLAUDE.md](./CLAUDE.md) — quick operating reference (commands, file map, conventions)
- [AGENTS.md](./AGENTS.md) — a heads-up that Expo has changed significantly across
  versions; check the versioned docs before relying on older guidance

## License

MIT — see [LICENSE](./LICENSE).
