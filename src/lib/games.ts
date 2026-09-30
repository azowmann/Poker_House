/**
 * Everything the app does with games, players, buy-ins, and the leaderboard.
 * Screens call these; they never build queries themselves - see
 * `src/lib/houses.ts` for the same convention.
 */
import type { PostgrestError } from '@supabase/supabase-js';

import { formatSignedCents } from '@/lib/format';
import { CHECK_VIOLATION, isPostgrestError, RLS_VIOLATION, UNIQUE_VIOLATION } from '@/lib/postgrest';
import { settle } from '@/lib/settlement';
import { supabase } from '@/lib/supabase';

export type Game = {
  id: string;
  house_id: string;
  status: 'active' | 'settled';
  created_at: string;
};

export type PastGame = {
  id: string;
  created_at: string;
  /** When the game was settled - null for a game settled before this column
   *  existed. The UI falls back to created_at for those. */
  settled_at: string | null;
};

export type HouseMember = {
  user_id: string;
  display_name: string;
};

export type GamePlayer = {
  /** game_players.id - not the same as user_id, since a user has one row per game. */
  id: string;
  user_id: string;
  display_name: string;
  final_stack_cents: number | null;
  /** Sum of every buy_ins row for this player, across the whole game. */
  buy_in_cents: number;
  /** The amount of their first buy-in - the rebuy button's default amount. */
  first_buy_in_cents: number;
};

export type LeaderboardRow = {
  user_id: string;
  display_name: string;
  games_played: number;
  net_cents: number;
};

/**
 * All-time leaderboard for a house, best net first.
 *
 * `house_leaderboards` has no display_name - it is a plain aggregate over
 * game_players (see the migration), so names are looked up separately and joined
 * in memory. Both queries run as the caller: the view is `security_invoker = true`
 * and `users` is readable for anyone you share a house with, so a member sees
 * exactly the rows they are entitled to either way.
 */
export async function getLeaderboard(houseId: string): Promise<LeaderboardRow[]> {
  const { data: rows, error } = await supabase
    .from('house_leaderboards')
    .select('user_id, games_played, net_cents')
    .eq('house_id', houseId)
    .order('net_cents', { ascending: false });

  if (error) {
    throw new Error(`Could not load the leaderboard. ${error.message}`);
  }
  if (!rows || rows.length === 0) {
    return [];
  }

  const { data: users, error: usersError } = await supabase
    .from('users')
    .select('id, display_name')
    .in(
      'id',
      rows.map((row) => row.user_id)
    );

  if (usersError) {
    throw new Error(`Could not load player names. ${usersError.message}`);
  }

  const displayNameById = new Map((users ?? []).map((u) => [u.id, u.display_name]));

  return rows.map((row) => ({
    user_id: row.user_id,
    display_name: displayNameById.get(row.user_id) ?? 'Unknown player',
    games_played: row.games_played,
    // The view casts to bigint specifically so PostgREST sends a number, not a
    // numeric string - Number() here is a defensive no-op, not a real conversion.
    net_cents: Number(row.net_cents),
  }));
}

export type RankedLeaderboardRow = LeaderboardRow & { rank: number };

/**
 * Standard competition ranking ("1224"): tied players share a rank, and the
 * next distinct rank skips ahead by however many were tied - 1, 2, 3, 3, 5, not
 * 1, 2, 3, 3, 4. Requires rows already sorted by net_cents descending, exactly
 * what getLeaderboard returns.
 */
export function withRanks(rows: readonly LeaderboardRow[]): RankedLeaderboardRow[] {
  let lastNetCents: number | null = null;
  let lastRank = 0;

  return rows.map((row, index) => {
    const rank = row.net_cents === lastNetCents ? lastRank : index + 1;
    lastNetCents = row.net_cents;
    lastRank = rank;
    return { ...row, rank };
  });
}

/** Settled games for a house, most recent first. Never includes an active game. */
export async function listPastGames(houseId: string): Promise<PastGame[]> {
  const { data, error } = await supabase
    .from('games')
    .select('id, created_at, settled_at')
    .eq('house_id', houseId)
    .eq('status', 'settled')
    .order('created_at', { ascending: false });

  if (error) {
    throw new Error(`Could not load past games. ${error.message}`);
  }

  return data ?? [];
}

/**
 * The house's in-progress game, if any. The house view uses this to offer
 * "Resume game" instead of "Start game" - nothing in the schema stops a house
 * from having two games active at once, but the app never offers to create a
 * second one, so a player can't lose track of a game they already started.
 */
export async function getActiveGame(houseId: string): Promise<{ id: string } | null> {
  const { data, error } = await supabase
    .from('games')
    .select('id')
    .eq('house_id', houseId)
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`Could not check for a game already in progress. ${error.message}`);
  }

  return data;
}

/** One game by id, for the live-game screen to confirm it still exists and is open. */
export async function getGame(gameId: string): Promise<Game | null> {
  const { data, error } = await supabase
    .from('games')
    .select('id, house_id, status, created_at')
    .eq('id', gameId)
    .maybeSingle<Game>();

  if (error) {
    throw new Error(`Could not load that game. ${error.message}`);
  }

  return data;
}

/**
 * Start a new game for a house. Status is explicit even though the column defaults
 * to 'active', matching the INSERT policy's WITH CHECK, which requires it.
 *
 * `games_one_active_per_house` (a partial unique index on `games(house_id) WHERE
 * status = 'active'`) is the real guarantee that a house never has two active
 * games at once - the house view's own "is there already one?" check happens
 * first, but two people tapping "Start game" on two phones at the same instant
 * can both pass that check before either has inserted. If this insert loses that
 * race, hand back the game that won instead of surfacing a constraint-violation
 * message: the caller asked to be somewhere playable, and the other game is
 * exactly that.
 */
export async function startGame(houseId: string): Promise<{ id: string }> {
  const { data, error } = await supabase
    .from('games')
    .insert({ house_id: houseId, status: 'active' })
    .select('id')
    .single();

  if (!error && data) {
    return data;
  }

  if (isPostgrestError(error) && error.code === UNIQUE_VIOLATION) {
    const active = await getActiveGame(houseId);
    if (active) {
      return active;
    }
  }

  throw new Error(`Could not start a game. ${error?.message ?? 'Please try again.'}`);
}

/** Every member of a house, for the live-game screen's "add a player" list. */
export async function listHouseMembers(houseId: string): Promise<HouseMember[]> {
  const { data, error } = await supabase
    .from('memberships')
    .select('user_id, member:users!inner(display_name)')
    .eq('house_id', houseId)
    .returns<{ user_id: string; member: { display_name: string } }[]>();

  if (error) {
    throw new Error(`Could not load house members. ${error.message}`);
  }

  return (data ?? [])
    .map((row) => ({ user_id: row.user_id, display_name: row.member.display_name }))
    .sort((a, b) => a.display_name.localeCompare(b.display_name));
}

type GamePlayerRow = {
  id: string;
  user_id: string;
  final_stack_cents: number | null;
  user: { display_name: string } | null;
  buy_ins: { amount_cents: number; created_at: string }[] | null;
};

/** Every player currently in a game, with their buy-in total and first buy-in. */
export async function listGamePlayers(gameId: string): Promise<GamePlayer[]> {
  const { data, error } = await supabase
    .from('game_players')
    .select(
      'id, user_id, final_stack_cents, user:users!inner(display_name), buy_ins(amount_cents, created_at)'
    )
    .eq('game_id', gameId)
    .order('created_at', { ascending: true })
    .returns<GamePlayerRow[]>();

  if (error) {
    throw new Error(`Could not load this game's players. ${error.message}`);
  }

  return (data ?? []).map((row) => {
    // Sort in memory rather than trust API order - buy_ins is a nested embed and
    // PostgREST does not order it for us.
    const buyIns = [...(row.buy_ins ?? [])].sort((a, b) => a.created_at.localeCompare(b.created_at));

    return {
      id: row.id,
      user_id: row.user_id,
      display_name: row.user?.display_name ?? 'Unknown player',
      final_stack_cents: row.final_stack_cents,
      buy_in_cents: buyIns.reduce((sum, buyIn) => sum + buyIn.amount_cents, 0),
      first_buy_in_cents: buyIns[0]?.amount_cents ?? 0,
    };
  });
}

/**
 * Add a house member to a game with their first buy-in.
 *
 * Two statements: the schema has no `add_player` RPC, and adding one is a schema
 * change. If the buy-in insert fails the game_players row is deleted again,
 * otherwise the player would sit in the game with no money in - and the settle
 * guard would still eventually reject the game over it, just much later.
 */
export async function addPlayerToGame(
  gameId: string,
  userId: string,
  buyInCents: number
): Promise<void> {
  const { data: gamePlayer, error } = await supabase
    .from('game_players')
    .insert({ game_id: gameId, user_id: userId })
    .select('id')
    .single();

  if (error || !gamePlayer) {
    throw describeGamePlayerError(error);
  }

  const { error: buyInError } = await supabase
    .from('buy_ins')
    .insert({ game_player_id: gamePlayer.id, amount_cents: buyInCents });

  if (buyInError) {
    await supabase.from('game_players').delete().eq('id', gamePlayer.id);
    throw new Error('Could not record their buy-in, so they were not added. Please try again.');
  }
}

function describeGamePlayerError(error: PostgrestError | null): Error {
  if (!isPostgrestError(error)) {
    return new Error('Could not add that player. Please try again.');
  }
  if (error.code === UNIQUE_VIOLATION) {
    return new Error('That player is already in this game.');
  }
  if (error.code === RLS_VIOLATION) {
    return new Error('This game has already been settled, so players can no longer be added.');
  }
  return new Error(`Could not add that player. ${error.message}`);
}

/**
 * Record a rebuy - another buy_ins row for a player already in the game.
 *
 * `amountCents` may be negative: a correction that nets out a mis-click (an
 * over-generous rebuy, a rebuy added to the wrong player) rather than a real
 * rebuy. It may not be zero - the database's `buy_ins_amount_nonzero` check
 * would reject that anyway, but failing here gives a sentence instead of a raw
 * constraint-violation message.
 */
export async function addRebuy(gamePlayerId: string, amountCents: number): Promise<void> {
  if (amountCents === 0) {
    throw new Error('Enter a non-zero amount.');
  }

  const { error } = await supabase
    .from('buy_ins')
    .insert({ game_player_id: gamePlayerId, amount_cents: amountCents });

  if (error) {
    if (isPostgrestError(error) && error.code === RLS_VIOLATION) {
      throw new Error('This game has already been settled, so buy-ins can no longer be added.');
    }
    throw new Error(`Could not record the rebuy. ${error.message}`);
  }
}

/**
 * Remove a player from an active game - a misclick undo, not a settle-time
 * decision. Any house member can (the game_players DELETE policy is
 * `is_game_editable(game_id)`: any member, while the game is active - not
 * owner-restricted the way deleting the game itself is). Their buy-ins for this
 * game cascade away automatically (ON DELETE CASCADE), so nothing else needs
 * cleaning up here.
 *
 * A 0-row result means the game is no longer active (RLS refused it) rather
 * than a real error.
 */
export async function removePlayer(gamePlayerId: string): Promise<void> {
  const { data, error } = await supabase.from('game_players').delete().eq('id', gamePlayerId).select();

  if (error) {
    throw new Error(`Could not remove that player. ${error.message}`);
  }
  if (!data || data.length === 0) {
    throw new Error('This game has already been settled, so players can no longer be removed.');
  }
}

/**
 * Override a player's total buy-in to an exact amount, by inserting one
 * reconciling buy_ins row for the difference - which may be negative.
 *
 * Every individual buy-in and rebuy stays its own permanent row (see
 * ARCHITECTURE.md); this never edits or deletes one, so "why is the total what
 * it is" stays answerable by listing the rows, the same way a settled game's
 * history does. A request that already matches the current total is a no-op.
 */
export async function setPlayerBuyIn(
  gamePlayerId: string,
  currentTotalCents: number,
  newTotalCents: number
): Promise<void> {
  const delta = newTotalCents - currentTotalCents;
  if (delta === 0) return;

  await addRebuy(gamePlayerId, delta);
}

/**
 * Write every player's final stack, then flip the game to settled.
 *
 * The stack writes run in parallel and are checked for errors before the status
 * flip is attempted, so a failed write can't leave the game settled with a stale
 * stack silently left over from before.
 *
 * The `active -> settled` trigger (`enforce_settled_games_complete`) rejects the
 * status update outright if any player still has a NULL final_stack_cents, or if
 * the game has no players - `describeSettleError` turns that into a sentence
 * instead of the raw "cannot settle game <uuid>: ..." message.
 */
export async function settleGame(
  gameId: string,
  finalStacks: { gamePlayerId: string; cents: number }[]
): Promise<void> {
  const results = await Promise.all(
    finalStacks.map(({ gamePlayerId, cents }) =>
      supabase.from('game_players').update({ final_stack_cents: cents }).eq('id', gamePlayerId)
    )
  );

  const failed = results.find((result) => result.error);
  if (failed?.error) {
    throw new Error(`Could not save final stacks. ${failed.error.message}`);
  }

  const { error } = await supabase.from('games').update({ status: 'settled' }).eq('id', gameId);
  if (error) {
    throw describeSettleError(error);
  }
}

function describeSettleError(error: PostgrestError): Error {
  if (error.code === CHECK_VIOLATION) {
    if (error.message.includes('it has no players')) {
      return new Error('Add at least one player before settling.');
    }

    const missingStacks = /(\d+) of (\d+) player\(s\) have no final stack recorded/.exec(
      error.message
    );
    if (missingStacks) {
      const [, missing, total] = missingStacks;
      const players = missing === '1' ? 'player still needs' : 'players still need';
      return new Error(`${missing} of ${total} ${players} a final stack entered.`);
    }

    // The trigger's own zero-sum check (enforce_settled_games_complete) - the
    // same requirement computeGameSettlement checks client-side, reported in the
    // exact same words either way. This is the one that actually stops a
    // mismatched game from becoming settled; that one is defence in depth for a
    // game that was already settled before this trigger existed.
    const mismatch = /nets total (-?\d+) cents instead of 0/.exec(error.message);
    if (mismatch) {
      return new Error(describeNetMismatch(Number(mismatch[1])));
    }
  }

  return new Error(`Could not settle the game. ${error.message}`);
}

/** Shared wording for "the nets do not sum to zero" - see describeSettleError. */
function describeNetMismatch(totalCents: number): string {
  return (
    `These numbers don't add up: nets total ${formatSignedCents(totalCents)} instead of $0.00. ` +
    `Check everyone's buy-ins and final stack for this game.`
  );
}

export type GameSettlementPlayer = {
  user_id: string;
  display_name: string;
  net_cents: number;
};

export type GameSettlementTransfer = {
  from_display_name: string;
  to_display_name: string;
  amount_cents: number;
};

export type GameSettlement = {
  players: GameSettlementPlayer[];
  transfers: GameSettlementTransfer[];
};

/**
 * Turn a settled game's players (as returned by `listGamePlayers`) into what the
 * results screen shows: each player's net for the game, and the transfers that
 * square everyone up.
 *
 * Every player here must already have a final stack - guaranteed for any game the
 * settle-guard trigger actually allowed to become 'settled'. A NULL stack means
 * something bypassed that guarantee, so this throws naming the player rather than
 * treating it as zero and quietly understating what they owe or are owed.
 *
 * The nets must sum to exactly zero or `settle()` itself refuses them - see
 * `src/lib/settlement.ts` - rather than silently tolerating a small mismatch and
 * moving real money on a mistyped final stack. That check is repeated here,
 * ahead of calling `settle()`, purely so the mismatch can be reported in dollars:
 * `settle()` is a pure module with no notion of display formatting (see its own
 * header comment), so it reports the raw cents figure, which isn't fit for a
 * screen. Failing here first means settle()'s own check never has anything to
 * catch from this call site - it stays as defence in depth for any other caller.
 */
export function computeGameSettlement(players: readonly GamePlayer[]): GameSettlement {
  const nets = players.map((player) => {
    if (player.final_stack_cents === null) {
      throw new Error(
        `${player.display_name} has no final stack recorded, so this game cannot be settled yet.`
      );
    }
    return {
      user_id: player.user_id,
      display_name: player.display_name,
      net_cents: player.final_stack_cents - player.buy_in_cents,
    };
  });

  const total = nets.reduce((sum, n) => sum + n.net_cents, 0);
  if (total !== 0) {
    throw new Error(describeNetMismatch(total));
  }

  const transfers = settle(nets.map((n) => ({ user: n.user_id, net_cents: n.net_cents })));
  const displayNameByUserId = new Map(nets.map((n) => [n.user_id, n.display_name]));

  return {
    players: nets,
    transfers: transfers.map((t) => ({
      from_display_name: displayNameByUserId.get(t.from) ?? 'Unknown player',
      to_display_name: displayNameByUserId.get(t.to) ?? 'Unknown player',
      amount_cents: t.amount_cents,
    })),
  };
}

/**
 * Delete a single game - active or settled - only the house owner can (the
 * `games` DELETE policy is `is_house_owner(house_id)`, nothing else).
 *
 * game_players and buy_ins cascade automatically (ON DELETE CASCADE on both), so
 * this one statement is everything. Deleting a settled game changes
 * house_leaderboards for every player who was in it, immediately and
 * permanently - the caller is expected to confirm that clearly before calling
 * this, the same way deleteHouse's caller does.
 *
 * A 0-row result means RLS refused it - not the owner - rather than a real
 * error, the same distinction leaveHouse/deleteHouse make for the same reason.
 */
export async function deleteGame(gameId: string): Promise<void> {
  const { data, error } = await supabase.from('games').delete().eq('id', gameId).select();

  if (error) {
    throw new Error(`Could not delete the game. ${error.message}`);
  }
  if (!data || data.length === 0) {
    throw new Error('Could not delete this game. Only the house owner can delete a game.');
  }
}
