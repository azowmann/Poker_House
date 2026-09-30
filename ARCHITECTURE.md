# ARCHITECTURE.md

The reasoning behind the poker home-game tracker. CLAUDE.md has the rules;
this file explains *why* they exist so future decisions stay consistent.

## The app in one line

Friends form a "house," record their in-person cash games, and see per-game and
all-time winnings. At the end of a game the app computes the fewest money transfers
needed to settle everyone up.

## Stack and why

- **React Native + Expo** — one codebase for iOS (and Android for free), fast
  iteration, and a large ecosystem. Chosen over native SwiftUI to keep a first
  full-stack project approachable.
- **Supabase (Postgres)** — gives auth (Google + email), a relational database, and
  an auto-generated API in one service, so there's no hand-rolled backend. Postgres
  is relational, which fits the houses → members → games → buy-ins structure and makes
  leaderboard aggregation a clean SQL `GROUP BY`.
- **Auth: Google + email only.** Phone auth was considered and dropped for now to
  reduce setup complexity and cost.

## Data model

Six tables. IDs are UUIDs. Money is integer cents everywhere.

- **users** — one per person. `id`, `email`, `display_name`.
- **houses** — a group. `id`, `name` (unique, shown on the home screen),
  `join_code` (generated after the name is set), `owner_id` → users.
- **memberships** — join table linking a user to a house (many-to-many: one user is in
  many houses, one house has many users).
- **games** — a single session belonging to a house. `id`, `house_id`, `status`
  (`active` | `settled`), `created_at`.
- **game_players** — one row per player per game. `id`, `game_id`, `user_id`,
  `final_stack_cents` (the chips they cashed out with, entered once at game end).
- **buy_ins** — one row per buy-in, pointing to a `game_player`. `id`,
  `game_player_id`, `amount_cents`. First buy-in and every rebuy are identical rows.

### Key modeling decisions

- **Rebuys get their own table.** A player can add money multiple times during a game,
  so buy-ins can't be a single column — each is a `buy_ins` row. The live-game screen's
  `+` button on a player simply inserts one more row. No cap.
- **Cash-out is one value.** A player cashes out once, so `final_stack_cents` lives on
  the `game_players` row rather than in its own table.
- **Net is always computed, never stored.**
  `net = final_stack_cents − sum(that player's buy_ins)`.
  The leaderboard is that net summed across the house's settled games, grouped by user.
  Storing a total would risk it drifting out of sync with the underlying rows.
- **Money as integer cents.** Avoids floating-point rounding bugs. Full dollars-and-cents
  precision is preserved; divide by 100 only when displaying.
- **Only `settled` games count.** An `active` (in-progress) game must never move the
  all-time standings. Stats query `where status = 'settled'`. A game becomes `settled`
  once every player's final stack is recorded.
- **Permissions are minimal.** Any member can record games and results, so there are no
  per-action permission flags. The only owner-specific fact in the model is
  `houses.owner_id`.
- **Join code + unique name.** Members join by short code. The owner sets a unique house
  name (the display name); the code is generated afterward.

## Settlement algorithm

The "optimal exchange of money" feature is debt simplification: given each player's net
(which sums to zero across the table), produce the fewest transfers that settle everyone.

It lives in `src/lib/settlement.ts` as a **pure function** — no UI, no database. Input
is a list of `{ user, net_cents }`; output is a list of `{ from, to, amount_cents }`.
Because it is pure, it can be unit-tested in isolation, and it is a good first thing to
build and test before any screens exist.

`settle()` runs two passes: it pairs off any debt that exactly equals a credit (always
safe — it clears two players in one payment), then greedily pays the largest remaining
creditor from the largest remaining debtor. That bounds the result at `n - 1` transfers
and is genuinely minimal unless some subgroup happens to settle among itself. Finding
the true minimum in every case means hunting for zero-sum subsets, which is NP-hard and
not worth it for a table of friends. `settle()` throws if the nets do not sum to zero,
rather than quietly moving real money on a mistyped stack.

## Schema and access control

The schema lives in `supabase/migrations/`. Decisions made while writing it:

- **RLS is the only gate, and it is default-deny.** Every table has RLS enabled and
  every policy names the `authenticated` role, so an anonymous caller matches nothing.
  `anon` is explicitly revoked from all six tables. The app never uses the
  service-role key.
- **Policies delegate to SECURITY DEFINER helpers** (`is_house_member`,
  `is_game_editable`, and friends). A policy on `memberships` that queried
  `memberships` directly would re-enter its own policy and fail with infinite
  recursion. The helpers answer one yes/no question about the caller, so they leak
  nothing a member could not already read. Each pins `search_path = ''` and fully
  qualifies its tables so the definer rights cannot be redirected.
- **Settled games are immutable.** Writes to a game, its players, and its buy-ins all
  require `status = 'active'`. Since "editing or voiding a settled game" is still an
  open question below, the safe default is that results stop moving once the money has
  changed hands. Consequence for the client: write every final stack *first*, then
  flip the game to `settled` — the reverse order locks you out.
- **Joining goes through `join_house(code)`, a SECURITY DEFINER RPC.** RLS cannot
  express "you may read this house only if you can name its code": a SELECT policy
  permissive enough to find a house by code is also permissive enough to list every
  house. The RPC takes the code, does the lookup itself, and enrols the caller.
- **Join codes are generated by the database** (`generate_join_code()`), from a
  6-character alphabet with no I, L, O, 0 or 1, since codes get read aloud.
- **Profiles are created by trigger.** `handle_new_user` fires on `auth.users` insert
  and fills `public.users`, so a Google or email sign-up lands with a display name.
- **Deletes that would corrupt history are blocked.** `houses.owner_id` and
  `game_players.user_id` are `ON DELETE RESTRICT`: removing a player would break the
  zero-sum property of every game they played. Everything downstream of a house or a
  game cascades.
- **The leaderboard is a view, not a table.** `public.house_leaderboards` aggregates
  net per player per house over settled games only, recomputed on every read, so it
  cannot drift from the rows beneath it. It is declared `security_invoker = true`: a
  normal view runs with its owner's rights and would read straight through RLS,
  handing every caller the standings of every house.
- **A game cannot be settled until every player has cashed out.** A trigger on the
  `active -> settled` edge rejects the update if any `final_stack_cents` is still
  NULL, or if the game has no players. Settling is the moment a game starts counting
  toward the leaderboard, and one missing stack would make that player's net NULL and
  poison the sum.
- **A game's players must belong to the game's house.** A trigger, checked when a
  player is added and never re-checked afterwards. Deliberately not a composite
  foreign key to `memberships (house_id, user_id)`: an FK would follow the membership
  row, so someone leaving the house would either drag their past results out with them
  or be unable to leave. RLS stops a non-member writing to a game, but nothing else
  stopped a member adding an outsider as a player.

## Screen flow

1. **Launch** — check for a saved session; if present, skip login.
2. **Sign in / sign up** — Google or email.
3. **Your houses** — list of houses the user belongs to, with "start" and "join" options.
4. **Start a house** (owner sets unique name → app generates join code) **or Join a house**
   (enter code).
5. **House view** — all-time leaderboard on top, list of past games below (most recent first).
6. **Live game** — add players (vertical list, `+` to add), set each player's buy-in, add
   rebuys during play, then enter final stacks to settle.

## Auth and navigation

- **One source of session state.** `src/lib/auth.tsx` seeds from
  `supabase.auth.getSession()` (which reads the session back out of AsyncStorage) and
  then follows `onAuthStateChange`. Screens call `useAuth()`; nothing else asks
  Supabase who is signed in.
- **Guards are `<Redirect>`, not imperative navigation.** Signing in updates the
  session, which re-renders the screen, which redirects. There is no
  "await sign-in, then router.replace" step that could race the auth listener, and
  signing out reverses it for free. Expo Router's `<Stack.Protected guard>` would
  also work and is worth revisiting once there are more protected routes.
- **`isRestoring` gates every guard.** Without it a returning player is bounced to
  the sign-in screen for a frame before landing on their houses.
- **The Supabase client never throws at import.** `web.output: "static"` prerenders
  the app in Node at build time, so a module-scope throw on missing env vars fails
  the *build*; on a device it would be a red-box crash. Instead
  `isSupabaseConfigured` is exported and the sign-in screen explains what to set.
  For the same reason session persistence is disabled when there is no `window` -
  AsyncStorage's web path reads `window.localStorage`, which prerender lacks.
- **The "< Your Houses" back button is a custom `headerLeft`, per screen.**
  Expo Router's native stack shows the previous screen's title as the default
  back label - there is no single global switch for it, so `HomeBackButton`
  (`src/components/`) is set as `headerLeft` individually on the three screens
  one level under the houses list (`houses/new`, `houses/join`,
  `houses/[id]/index`). `headerLeft` fully replaces the native back button, so
  there is no leftover chevron or title text to separately hide. The live-game
  screen a level further in keeps its ordinary back button, since its label was
  already the house's name, not "Your Houses".
- **SVG icons are hand-written `react-native-svg` components, not `.svg`
  imports.** This project has no Metro transformer configured to treat a
  `require('*.svg')` as a component (`react-native-svg-transformer` or similar),
  and adding one is more build-tooling than a couple of fixed icons need.
  `HomeIcon` instead copies the source file's `<path>` data directly into
  `<Svg>`/`<Path>` elements, with the color parameterised so it can follow the
  theme - the source files are typically plain black, which would vanish in a
  dark header.
- **The profile button is a `headerRight` default at the Stack level, not a
  per-screen option.** Unlike `HomeBackButton` (three specific screens), this
  needed to appear almost everywhere, so `screenOptions.headerRight` sets it
  once and the profile screen is the one place it is explicitly turned back off
  (`headerRight: () => null`). Screens with `headerShown: false` (`index`,
  `sign-in`) never render a header at all, so the default never reaches them -
  that is what keeps it off the sign-in/sign-up screen without a special case.
- **`AuthProvider` carries `profile`, not just `session`.** The header button
  needs to show a user's actual avatar on every screen, not only the one where
  it can be changed, so `src/lib/auth.tsx` fetches `public.users` alongside the
  session and re-fetches on every auth change. `refreshProfile()` lets the
  profile screen push a name or avatar change out to that shared copy
  immediately, rather than waiting for the next sign-in. The profile *screen*
  still does its own separate fetch with its own error handling, matching every
  other screen's load-state convention - the context copy exists to feed the
  button quickly and everywhere, not to be any one screen's source of truth.
- **Avatars are public; profiles are not.** `avatars` is a public Storage
  bucket - anyone with the exact URL can view the image bytes, verified live
  with a genuinely unauthenticated HTTP fetch - deliberately simpler than
  restricting it to housemates (see the migration for why). This does not loosen
  `public.users`' own RLS: `avatar_url` is just another column on that row, and
  the pre-existing "housemates only" rule for reading a profile still applies to
  it exactly as it always did to `display_name` - confirmed live, not assumed,
  by having a user with no shared house try to read it and getting nothing back.
  Each avatar lives at a fixed path (`<user_id>/avatar.jpg`), so re-uploading
  overwrites the same object; the stored URL carries a cache-busting query
  param, since the object path never changes on a re-upload and a client that
  had already cached the old image at that exact URL would otherwise keep
  showing it.
- **"View your password" isn't a real feature - passwords cannot be retrieved,
  by anyone, including Supabase itself.** The profile screen offers a "change
  password" field instead: `supabase.auth.updateUser({ password })`, which
  needs no "current password" since the request is already authenticated as
  that user.
- **Email is read-only on the profile screen, for now.** Changing it through
  Supabase requires sending a confirmation link to the *new* address and
  waiting for it to be clicked before the change takes effect - a meaningfully
  bigger flow than editing a name, and not built here.

## Data access from the app

- **Screens never build queries.** `src/lib/houses.ts` owns them and translates
  Postgres errors into sentences a player can read (a unique violation on
  `houses.name` becomes "A house called X already exists"). Keeps the RLS-shaped
  traps below in one place.
- **Listing houses must filter on `user_id`.** The `memberships` SELECT policy is
  `is_house_member(house_id)`, so it returns every membership row of every house you
  belong to - including your housemates'. Without the filter a three-player house
  appears three times.
- **Creating a house is two statements, with a compensating delete.** Insert the
  house, then the owner's membership. There is no `create_house` RPC because adding
  one is a schema change; if the membership insert fails the house is deleted again,
  otherwise it would sit there holding its unique name while never appearing in
  anyone's list.
- **`join_house` is idempotent.** `on conflict do nothing` means re-joining a house
  you are already in succeeds and returns that house, rather than erroring. Friendlier
  than a failure, but worth knowing: the UI cannot tell "joined" from "already in".
- **The houses list refetches on focus** rather than holding a cache, so returning
  from "start" or "join" shows the new house without either screen reaching into it.
  Requests carry a cancellation flag so a slow response cannot overwrite a newer one.
- **An owner cannot leave their own house.** The `memberships` DELETE policy
  deliberately excludes the owner's own row: `houses.owner_id` and membership are
  checked independently everywhere else in RLS, so an owner who left would keep
  house-level control (rename it, delete it) while losing visibility into its
  games and leaderboard. There is no ownership-transfer feature to hand it off
  first. `leaveHouse` (`src/lib/houses.ts`) tells the two cases apart by row
  count: DELETE has no WITH CHECK to violate, so RLS silently excludes the row
  rather than raising an error - a 0-row result is the owner being refused, not a
  failure. An owner who wants out already has "delete the house" available at the
  RLS layer, just no UI for it yet.
- **Leaving does not touch history, by design.** `game_players.user_id` was
  already `ON DELETE RESTRICT` and deliberately not an FK to `memberships` (see
  Schema and access control above) specifically so this would work: past games
  and the leaderboard total for someone who has left stay exactly as they were.
  One visible consequence, verified live: once a departed player shares no house
  with a viewer at all, `shares_house_with` no longer permits reading their
  `display_name` (correctly - the RLS rule for reading a profile is "share a
  house *now*", not "ever did"), so `getLeaderboard`'s existing `?? 'Unknown
  player'` fallback is what a remaining member sees next to that player's
  historical net. Their number stays right; only the name degrades.
- **Deleting a house needed no schema work at all.** The owner-only DELETE
  policy on `houses` and the `ON DELETE CASCADE` chain (`memberships`, `games`,
  `game_players`, `buy_ins` all ultimately hang off `houses.id`) already existed
  and were already verified live, back when they were built for a different
  reason: cleaning up throwaway houses created while testing other features. This
  turn just gave that existing capability a UI - a "Delete house" button beside
  "Leave house", shown to whichever the signed-in user actually is, with a
  stronger confirmation given the stakes (irreversible, affects every member, not
  just the one tapping the button). Verified live again anyway, this time
  checking the app's own exact query shapes: a member's house list and a direct
  fetch both correctly show nothing immediately after the owner deletes it.
- **A house owner can delete an individual game - active or settled - and no
  one else can.** Replaces "members can delete an active game" (any member,
  active only) rather than adding alongside it, the same owner-exclusive shape as
  every other destructive action added this session. This is the answer to
  "editing or voiding a game after it's settled" that used to sit in this file's
  open questions: there is no edit and no audit trail, only delete, and deleting
  a settled game changes `house_leaderboards` for every player who was in it,
  immediately and permanently. The app's confirmation dialog says so explicitly
  when the game being deleted is settled, distinct (and stronger) wording than
  for an active one. Verified live: deleting a settled 2-player game took the
  leaderboard from `{alice: +1000, bob: -1000}` to empty in the same request.

## Games, buy-ins, and settling

- **The leaderboard view has no names.** `house_leaderboards` is a plain aggregate
  over `game_players` (see the migration) - it carries `user_id`, not
  `display_name`. `getLeaderboard` looks names up from `public.users` separately
  and joins them in memory, rather than teaching the view about `users` and
  reopening the security-invoker question for a second table.
- **At most one active game per house - enforced by the database, not just
  convention.** `games_one_active_per_house` is a partial unique index on
  `games(house_id) WHERE status = 'active'`: uniqueness only among active rows, so
  a house can still accumulate any number of settled games. The house view's own
  check-before-insert (offering "Resume game" instead of creating a duplicate)
  handles the common case, but two people tapping "Start game" on two phones at
  the same instant can both pass that check before either has inserted - the
  index is what actually prevents two active games, and `startGame` recovers from
  losing that race by handing back the game that won rather than surfacing a
  constraint-violation error. Verified under real concurrency against the live
  project: five simultaneous inserts, one winner, four recoveries, all agreeing on
  the same game id.
- **One button, not two.** The house view was already rendering a single `Button`
  whose label switches between "Start game" and "Resume game" based on whether an
  active game exists - there was never a second button to unify.
- **The live-game screen has one route, not two.** Tapping "Settle game" swaps the
  same screen into stack-entry mode with local state, instead of navigating to a
  second screen. A second route would let a back-button tap or a stray navigation
  drop a half-entered set of final stacks; toggling in place cannot lose them.
- **A shared "buy-in amount" field, not a per-tap prompt.** The schema has no
  concept of a house's standard buy-in, so the live-game screen keeps one text
  field (defaulting to $20) that every newly-added player's first buy-in uses,
  editable if a particular game's stakes differ. The rebuy button on each player
  instead defaults to *that player's own* first buy-in - the two defaults answer
  different questions and deliberately don't share a value.
- **Money strings are parsed digit-by-digit, never through `Number(x) * 100`.**
  `"19.99" * 100` is `1998.9999999999998` in JS float arithmetic - close enough to
  round to the wrong cent. `src/lib/format.ts` splits on the decimal point and
  works in integers throughout, and negative amounts are rejected outright since
  every money input in this app (a buy-in, a cash-out) is non-negative.
- **Deleting a house cascades through a settled game.** Verified against the live
  project, not assumed: `games`, `game_players`, and `buy_ins` each have an UPDATE
  and DELETE policy that requires `status = 'active'`, which blocks editing or
  removing a settled game's rows directly - but deleting the *house* is governed
  only by the `houses` DELETE policy (owner-only), and the FK cascade it triggers
  is not re-checked against the child tables' policies. A settled game is
  immutable to a direct edit, not to its house being deleted.
- **A buy-in can be corrected without ever editing history in place.**
  `buy_ins_amount_nonzero` (replacing the original `buy_ins_amount_positive`)
  allows a *negative* row - a signed correction that nets against a mis-click
  (a rebuy entered for the wrong amount, or on the wrong player), rather than
  rewriting or deleting the mistaken row. Every buy-in and rebuy stays its own
  permanent row either way, so "why is this total what it is" is still answerable
  by listing them - the table becomes a signed ledger rather than strictly "cash
  physically placed," but nothing downstream (the leaderboard view,
  `computeGameSettlement`, `listGamePlayers`) needed to change, since all three
  already just sum whatever rows exist, sign-agnostic. A zero-amount row is still
  rejected - it would correct nothing.
- **Setting a player's total buy-in is the same mechanism as a correction.**
  `setPlayerBuyIn` (`src/lib/games.ts`) takes the total a player *should* show and
  inserts one reconciling row for the difference, which may be negative. The UI
  entry point is deliberately just the existing "Bought in $X" text made tappable
  - it already showed the number that needed to become editable, so a second
  "view details" step first would have added a tap with no payoff.
- **Only the rebuy-correction field accepts a negative amount.** Every other
  money input in the app (a buy-in, a cash-out, a total to set) stays
  non-negative, parsed by `parseDollarsToCents`; the correction field alone uses
  `parseSignedDollarsToCents`. A client-side check also blocks a correction that
  would take a player's running total below $0, since that has no real-world
  meaning - the "set total" input can't produce a negative total in the first
  place, since it is itself parsed as non-negative.
- **`decimal-pad` has no minus key on iOS.** Apple's decimal pad is digits and a
  decimal point only, by design, matching the "amounts are non-negative"
  assumption everywhere else. The rebuy-correction field is the one input that
  needs a minus sign, so it uses `numbers-and-punctuation` on iOS (a broader
  keyboard, since iOS has no numeric-only keyboard that includes a sign key) and
  `numeric` on Android, which typically does include one.
- **`games.settled_at` is separate from `created_at`, and stamped by the
  database.** `created_at` is when "Start game" was tapped; a session can run for
  hours, so it is not "when this game happened" for the past-games list. The
  existing settle-guard trigger already fires exactly once, exactly on the
  `active -> settled` transition, so it was extended to also set
  `new.settled_at := now()` rather than trusting a client-supplied timestamp
  (skew, or simply forgetting to send it). A game settled before this column
  existed has no way to recover the real value and stays NULL forever; the app
  falls back to `created_at` for those specific rows rather than showing nothing.
- **A mismatched game cannot become settled at all - enforced by the database.**
  The settle-guard trigger originally only checked that every player had a final
  stack; it never checked that the numbers balanced. A game with a mistyped final
  stack could settle successfully, and a settled game is permanent - it can never
  be edited again, and `house_leaderboards` picks it up forever, silently
  corrupting every player's total in that house with no way to fix it short of
  deleting the whole house. The trigger now sums each player's net (the same
  computation `house_leaderboards` does) and refuses the transition outright if it
  is not exactly zero, closing the gap at the point that actually matters -
  before the status flips - rather than leaving the client to notice afterward.
  Verified live: a mistyped stack is rejected and the game stays `active`;
  correcting it and retrying settles normally.
- **A zero-sum mismatch is still checked client-side too, for existing bad data.**
  `computeGameSettlement` repeats the same check before ever calling `settle()` -
  not to catch a *new* mismatched settle (the trigger already stops those), but
  to explain a game that was settled with bad data *before* the trigger above
  existed, which the trigger cannot retroactively fix. `settle()` refuses a
  non-zero sum itself too (see Settlement algorithm above), but reports it in raw
  cents - a pure module with no notion of display formatting, by design - so both
  call sites (`computeGameSettlement`, and `describeSettleError` translating the
  trigger's own rejection) go through the same `describeNetMismatch` helper,
  which reports it in dollars via `formatSignedCents`. The wording is identical
  regardless of which of the three checks actually catches a given mismatch.
- **A player can be removed from an active game - no new migration needed.**
  The original schema's `game_players` DELETE policy ("members can remove a
  player from an active game", `using (public.is_game_editable(game_id))`) was
  already broad enough: any house member, not just the game's owner, can delete
  any player row while the game is active, and `buy_ins` cascades away with it
  (`ON DELETE CASCADE`), so nothing else needs cleaning up. This is deliberately
  looser than deleting the *game itself* (owner-only, any status) - removing one
  misclicked player from a still-active game is a low-stakes undo, not a
  destructive action gated the same way. `removePlayer` (`src/lib/games.ts`)
  treats a 0-row delete result as "this game is no longer active" rather than a
  real error, since RLS silently returns zero rows instead of raising once the
  game is settled.

## Build order (depth-first)

Build one thin slice end-to-end before widening:

1. Lock data model + stack (done). Warm-up: build & unit-test `src/lib/settlement.ts` (done).
2. Project skeleton — Expo app (done) + Supabase connected (done).
3. Slice 1: sign in → empty "your houses" screen (built; email auth needs a real
   `.env` to confirm end-to-end, and the Google button is still a stub).
4. Slice 2: create / join a house, see it listed (built; needs a run against the
   live project to confirm).
5. Slice 3: record a game with buy-ins and final stacks; show the leaderboard
   (built and run end-to-end against the live project).
6. Slice 4: wire in the settlement algorithm at game end (built and run end-to-end
   against the live project).

## Settlement results

- **No new route.** `houses/[id]/game/[gameId].tsx` already branched on
  `game.status === 'settled'` (a placeholder message, pre-slice-4); the results
  screen is that branch filled in, reachable both by tapping a past game in the
  house view and by confirming a settle on the same screen without navigating away.
  A status check inside one route rather than two keeps "how did I get here"
  irrelevant to what's shown - the branch does not know or care which.
- **The nets shown are never fudged, not even by a cent.** `computeGameSettlement`
  (`src/lib/games.ts`) requires every player's nets to sum to exactly zero and lets
  `settle()`'s own validation throw otherwise, rather than tolerating a small
  mismatch and silently absorbing it into one player's transfer. Every dollar figure
  in this app is an exact integer with no rounding step anywhere between storage and
  display (see "Money strings are parsed digit-by-digit" above), so a non-zero sum
  is never rounding noise - it is always a mistyped final stack, and `settle()` was
  already written to refuse exactly that (see Settlement algorithm) rather than
  move real money on bad data. Tolerating it "within a cent" would reintroduce the
  quiet drift the rest of the app goes out of its way to avoid.
- **Confirming a settle stays on the same screen.** `handleConfirmSettle` calls
  `refresh()` instead of navigating on success; the reloaded `game.status` flips the
  same status check above into the results branch, so the results appear
  immediately with no navigation and nothing to lose on a stray back-button tap.
- **Verified against the live project with the real `settle()`, not a copy.** The
  end-to-end check transpiles `src/lib/settlement.ts` on the fly (via the
  TypeScript compiler already in `node_modules`) rather than hand-mirroring the
  algorithm, so a passing check can't drift from what the app actually runs. A
  3-player game with a rebuy settled correctly (nets summed to zero, transfers
  totalled exactly what the winner was owed, transfers carried display names, not
  raw user ids), and a break-even game produced zero transfers.

## Open questions / future

- Voiding a settled game is answered (the owner can delete it - see "Games,
  buy-ins, and settling" above); editing one in place, and an audit trail of
  what a deleted game contained, are still open.
- Handling a player who is in a game but not yet a registered user (guest players?).
- Statistics beyond net: games played, biggest win, etc.
