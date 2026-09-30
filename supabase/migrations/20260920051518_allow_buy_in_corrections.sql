-- =============================================================================
-- Allow a buy-in correction: a negative buy_ins row.
--
-- Until now every buy_ins row was required to be a positive amount - literally
-- cash placed on the table. That makes it impossible to correct a mis-click (a
-- rebuy entered for the wrong amount, or added to the wrong player) without
-- editing history in place, which the app deliberately never does anywhere else
-- (see ARCHITECTURE.md's settled-games-are-immutable design and the leaderboard
-- being a computed view rather than a stored total).
--
-- The fix keeps the same principle - every buy-in event is its own permanent row,
-- nothing is ever rewritten - by allowing a correction to be its own row too: a
-- negative one that nets against the mistake. `buy_ins` becomes a signed ledger
-- ("what does this player's running total add up to") rather than strictly "cash
-- physically placed," but every consumer (the leaderboard view, computeGameSettlement,
-- listGamePlayers) already just sums whatever rows exist, sign-agnostic - nothing
-- downstream needs to change for this to work.
--
-- A zero-amount row is still rejected: it does not correct anything and would
-- just be noise in the ledger.
-- =============================================================================

alter table public.buy_ins
  drop constraint buy_ins_amount_positive;

alter table public.buy_ins
  add constraint buy_ins_amount_nonzero check (amount_cents <> 0);
