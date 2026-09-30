-- =============================================================================
-- At most one active game per house.
--
-- Until now this was an app-level convention only (ARCHITECTURE.md: "the house
-- view checks for one before offering 'Start game'"): nothing stopped a second
-- concurrent active game from being created directly, or by two devices tapping
-- "Start game" at the same instant on the same house. This makes it a database
-- guarantee instead.
--
-- A plain UNIQUE index on (house_id) would also forbid a house from ever having
-- two SETTLED games, which is the normal case for a group that plays every week.
-- The `WHERE status = 'active'` clause makes it a *partial* index: uniqueness is
-- only enforced among active rows, so settled games are excluded from the
-- constraint entirely and a house can accumulate as many of those as it likes.
-- =============================================================================

CREATE UNIQUE INDEX games_one_active_per_house
  ON games (house_id)
  WHERE status = 'active';
