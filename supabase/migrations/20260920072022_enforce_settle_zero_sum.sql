-- =============================================================================
-- A game cannot be settled if its nets do not sum to zero.
--
-- The settle-guard trigger already refused a settle if a player had no final
-- stack recorded - but it never checked that the numbers actually balance. A
-- game with a mistyped final stack could become 'settled' successfully, and a
-- settled game is permanent: it can never be edited again (see the immutability
-- policies on games/game_players/buy_ins), and it is picked up by
-- house_leaderboards forever, silently corrupting every player's total in that
-- house with no way to fix it short of deleting the whole house.
--
-- The app already refuses to show a settlement for a mismatched game
-- (computeGameSettlement, src/lib/games.ts) - but by the time a player sees that
-- screen, the damage is already done: the update already succeeded. This closes
-- the gap at the point that actually matters, before the status flips at all,
-- the same way every other settle requirement here is enforced by the database
-- rather than trusted to the client.
--
-- The net-per-player computation mirrors house_leaderboards exactly (same
-- lateral join over buy_ins), since it is the same question asked at a different
-- moment: what does this player's net for this game come out to.
-- =============================================================================

create or replace function public.enforce_settled_games_complete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  player_count int;
  missing_count int;
  net_total bigint;
begin
  select
    count(*),
    count(*) filter (where gp.final_stack_cents is null),
    sum(gp.final_stack_cents - coalesce(bi.buy_in_cents, 0))
  into player_count, missing_count, net_total
  from public.game_players gp
  left join lateral (
    select sum(b.amount_cents) as buy_in_cents
    from public.buy_ins b
    where b.game_player_id = gp.id
  ) bi on true
  where gp.game_id = new.id;

  if player_count = 0 then
    raise exception 'cannot settle game %: it has no players', new.id
      using errcode = '23514';
  end if;

  if missing_count > 0 then
    raise exception
      'cannot settle game %: % of % player(s) have no final stack recorded',
      new.id, missing_count, player_count
      using errcode = '23514';
  end if;

  -- Only trustworthy once every player has a final stack (the check above) - a
  -- NULL final_stack_cents would make sum() silently skip that player's row
  -- rather than count it as wrong, which would let a real mismatch through.
  if net_total <> 0 then
    raise exception
      'cannot settle game %: nets total % cents instead of 0 - check buy-ins and final stacks',
      new.id, net_total
      using errcode = '23514';
  end if;

  new.settled_at := now();
  return new;
end;
$$;
