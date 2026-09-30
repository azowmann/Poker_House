import { computeGameSettlement, withRanks, type GamePlayer, type LeaderboardRow } from './games';

/** A GamePlayer row with sensible defaults - override just what a test cares about. */
function player(overrides: Partial<GamePlayer> & Pick<GamePlayer, 'user_id' | 'display_name'>): GamePlayer {
  return {
    id: `gp-${overrides.user_id}`,
    final_stack_cents: 0,
    buy_in_cents: 0,
    first_buy_in_cents: 0,
    ...overrides,
  };
}

describe('computeGameSettlement', () => {
  it('computes both players nets and the single transfer between them', () => {
    const settlement = computeGameSettlement([
      player({ user_id: 'alice', display_name: 'Alice', final_stack_cents: 5000, buy_in_cents: 2000 }),
      player({ user_id: 'bob', display_name: 'Bob', final_stack_cents: 0, buy_in_cents: 3000 }),
    ]);

    expect(settlement.players).toEqual([
      { user_id: 'alice', display_name: 'Alice', net_cents: 3000 },
      { user_id: 'bob', display_name: 'Bob', net_cents: -3000 },
    ]);
    expect(settlement.transfers).toEqual([
      { from_display_name: 'Bob', to_display_name: 'Alice', amount_cents: 3000 },
    ]);
  });

  it('reports no transfers when everyone breaks exactly even', () => {
    const settlement = computeGameSettlement([
      player({ user_id: 'alice', display_name: 'Alice', final_stack_cents: 2000, buy_in_cents: 2000 }),
      player({ user_id: 'bob', display_name: 'Bob', final_stack_cents: 3000, buy_in_cents: 3000 }),
    ]);

    expect(settlement.transfers).toEqual([]);
  });

  it('attaches display names to transfers, not raw user ids', () => {
    const settlement = computeGameSettlement([
      player({ user_id: 'u1', display_name: 'Carol', final_stack_cents: 6000, buy_in_cents: 2000 }),
      player({ user_id: 'u2', display_name: 'Dave', final_stack_cents: 0, buy_in_cents: 4000 }),
    ]);

    expect(settlement.transfers).toEqual([
      { from_display_name: 'Dave', to_display_name: 'Carol', amount_cents: 4000 },
    ]);
  });

  it('settles a multi-player game with the minimum number of transfers', () => {
    const settlement = computeGameSettlement([
      player({ user_id: 'alice', display_name: 'Alice', final_stack_cents: 8000, buy_in_cents: 3000 }),
      player({ user_id: 'bob', display_name: 'Bob', final_stack_cents: 0, buy_in_cents: 2000 }),
      player({ user_id: 'carol', display_name: 'Carol', final_stack_cents: 2000, buy_in_cents: 5000 }),
    ]);

    // alice +5000, bob -2000, carol -3000
    expect(settlement.players.map((p) => p.net_cents)).toEqual([5000, -2000, -3000]);
    expect(settlement.transfers.reduce((sum, t) => sum + t.amount_cents, 0)).toBe(5000);
    expect(settlement.transfers.length).toBeLessThanOrEqual(2);
  });

  it('throws naming the player if a final stack is missing', () => {
    const players = [
      player({ user_id: 'alice', display_name: 'Alice', final_stack_cents: null, buy_in_cents: 2000 }),
      player({ user_id: 'bob', display_name: 'Bob', final_stack_cents: 2000, buy_in_cents: 0 }),
    ];

    expect(() => computeGameSettlement(players)).toThrow(/Alice has no final stack recorded/);
  });

  it('throws rather than settling nets that do not sum to zero', () => {
    // A data-entry mistake (a mistyped final stack), not a rounding artifact - every
    // amount here is an exact integer, so there is nothing to round. This must
    // surface as a clear error, never as a silently "close enough" settlement.
    const players = [
      player({ user_id: 'alice', display_name: 'Alice', final_stack_cents: 5000, buy_in_cents: 2000 }),
      player({ user_id: 'bob', display_name: 'Bob', final_stack_cents: 0, buy_in_cents: 2000 }),
    ];

    // Nets: alice +3000, bob -2000 -> total +1000 cents.
    expect(() => computeGameSettlement(players)).toThrow("nets total +$10.00 instead of $0.00");
  });

  it('reports a mismatch in dollars, never in raw cents', () => {
    // Off by exactly one dollar - alice nets -100, bob is exactly even, so the
    // total is -100 cents. Before this fix the error read "...got -100 cents...",
    // a figure no player should have to convert in their head.
    const players = [
      player({ user_id: 'alice', display_name: 'Alice', final_stack_cents: 1900, buy_in_cents: 2000 }),
      player({ user_id: 'bob', display_name: 'Bob', final_stack_cents: 2000, buy_in_cents: 2000 }),
    ];

    expect(() => computeGameSettlement(players)).toThrow('nets total -$1.00 instead of $0.00');
    expect(() => computeGameSettlement(players)).not.toThrow(/cents/);
  });
});

/** A LeaderboardRow with sensible defaults - only net_cents matters for ranking. */
function row(net_cents: number, user_id = `u-${net_cents}-${Math.random()}`): LeaderboardRow {
  return { user_id, display_name: user_id, games_played: 1, net_cents };
}

describe('withRanks', () => {
  it('ranks distinct nets sequentially', () => {
    const ranks = withRanks([row(3000), row(2000), row(1000)]).map((r) => r.rank);
    expect(ranks).toEqual([1, 2, 3]);
  });

  it("gives tied players the same rank, and skips ahead by how many tied - the reported example", () => {
    // 100, 80, 50, 50, 10 -> 1, 2, 3, 3, 5 (not 1, 2, 3, 3, 4).
    const ranks = withRanks([row(100), row(80), row(50), row(50), row(10)]).map((r) => r.rank);
    expect(ranks).toEqual([1, 2, 3, 3, 5]);
  });

  it('handles a tie at the very top', () => {
    const ranks = withRanks([row(2000), row(2000), row(1000)]).map((r) => r.rank);
    expect(ranks).toEqual([1, 1, 3]);
  });

  it('handles everyone tied', () => {
    const ranks = withRanks([row(1000), row(1000), row(1000)]).map((r) => r.rank);
    expect(ranks).toEqual([1, 1, 1]);
  });

  it('handles a three-way tie in the middle', () => {
    const ranks = withRanks([row(500), row(200), row(200), row(200), row(0)]).map((r) => r.rank);
    expect(ranks).toEqual([1, 2, 2, 2, 5]);
  });

  it('handles a single row', () => {
    expect(withRanks([row(1000)]).map((r) => r.rank)).toEqual([1]);
  });

  it('handles an empty leaderboard', () => {
    expect(withRanks([])).toEqual([]);
  });

  it('does not mutate the input rows, and preserves every original field', () => {
    const original = row(1000, 'alice');
    const [ranked] = withRanks([original]);
    expect(original).not.toHaveProperty('rank');
    expect(ranked).toEqual({ ...original, rank: 1 });
  });
});
