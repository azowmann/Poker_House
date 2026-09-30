-- =============================================================================
-- Only the house owner may delete a game - active or settled.
--
-- Replaces "members can delete an active game" (any member, active only) with an
-- owner-only policy that also covers settled games. Two changes bundled together
-- because they answer the same question the same way "Delete house" already
-- does: deleting is an owner-only action, and it works regardless of status.
--
-- Deleting a settled game is a real, deliberate capability, not an oversight -
-- it answers "Editing or voiding a game after it's settled" (see the open
-- questions this file used to list). It changes house_leaderboards for every
-- player who was in that game, immediately and permanently: there is no undo,
-- and no audit trail of what was removed or by whom. The app-side confirmation
-- dialog is expected to make that unmistakable before calling this.
--
-- game_players and buy_ins cascade automatically (ON DELETE CASCADE on both),
-- so deleting a game is already a single statement - nothing else to clean up.
-- =============================================================================

drop policy "members can delete an active game" on public.games;

create policy "owners can delete any game in their house"
  on public.games for delete to authenticated
  using (public.is_house_owner(house_id));
