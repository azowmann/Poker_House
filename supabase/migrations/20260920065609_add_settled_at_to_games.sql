-- =============================================================================
-- Record when a game was settled, not just when it was started.
--
-- `games.created_at` is stamped at insert time - the moment "Start game" was
-- tapped. A session can run for hours, so that is not "when this game happened"
-- for the purposes of the past-games list; it is when it began. Nothing
-- previously recorded the other end of that.
--
-- `settled_at` is stamped by the database, not the app: the existing settle-guard
-- trigger already fires exactly on the active -> settled transition (and only
-- there - it can't fire twice, since a settled game can never move back to
-- active), so it is extended to also set the column, rather than trusting a
-- client-supplied timestamp that could be skewed or simply forgotten. A game
-- settled before this migration existed has no way to recover this - it stays
-- NULL, and the app falls back to created_at for those specific rows.
-- =============================================================================

alter table public.games
  add column settled_at timestamptz;

create or replace function public.enforce_settled_games_complete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  player_count int;
  missing_count int;
begin
  select
    count(*),
    count(*) filter (where gp.final_stack_cents is null)
  into player_count, missing_count
  from public.game_players gp
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

  new.settled_at := now();
  return new;
end;
$$;
