-- =============================================================================
-- An owner cannot leave their own house.
--
-- The original "members can leave and owners can remove members" policy let a
-- DELETE succeed if EITHER "it's your own membership row" OR "you own the
-- house" - and the owner's own row satisfies both, so nothing stopped them from
-- leaving their own house.
--
-- That would strand the house owned by someone no longer in it: `is_house_owner`
-- checks `houses.owner_id` directly, independent of membership, so they would
-- keep house-level control (rename it, delete it) while losing visibility into
-- its games and leaderboard, which check current membership specifically. There
-- is no ownership-transfer feature to hand the house off first, so until there
-- is, the owner's own membership row is carved out of both branches: a member
-- may delete their own row unless it is the owner's, and the owner may delete
-- anyone else's row but not their own. An owner who wants out still has the
-- existing "owners can delete their house" policy.
-- =============================================================================

drop policy "members can leave and owners can remove members" on public.memberships;

create policy "members can leave and owners can remove other members"
  on public.memberships for delete to authenticated
  using (
    (user_id = (select auth.uid()) and not public.is_house_owner(house_id))
    or (public.is_house_owner(house_id) and user_id <> (select auth.uid()))
  );
