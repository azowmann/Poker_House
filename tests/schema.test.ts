/**
 * Schema tests: the migrations applied to a real Postgres, then poked at as three
 * different signed-in users.
 *
 * These cover the parts of the data model that live in SQL rather than TypeScript -
 * the RLS policies, the settle guard, the house-membership guard, and the
 * leaderboard's arithmetic. `src/lib/settlement.test.ts` covers the pure logic.
 *
 * One database is shared by the whole file and the blocks below run in order: alice
 * makes a house, bob joins it, they play a game and settle it. Each `describe`
 * builds on the state the previous one left behind.
 */
import { createSchemaTestDb, type TestDb } from './support/pglite';

// Booting Postgres in WASM and applying the migrations takes a few seconds.
jest.setTimeout(120_000);

describe('database schema', () => {
  let t: TestDb;

  // Users
  let alice: string;
  let bob: string;
  let carol: string; // belongs to no house - the outsider every RLS test needs

  // Built up as the file runs
  let houseId: string;
  let joinCode: string;
  let gameId: string;
  let alicePlayerId: string;
  let bobPlayerId: string;

  beforeAll(async () => {
    t = await createSchemaTestDb();
    alice = await t.signUp('alice@example.com', { full_name: 'Alice Ng' });
    bob = await t.signUp('bob@example.com');
    carol = await t.signUp('carol@example.com', { name: 'Carol' });
  });

  afterAll(async () => {
    await t?.close();
  });

  describe('profile creation on signup', () => {
    it('creates a public.users row for every auth user', async () => {
      const rows = await t.query(`select id from public.users`);
      expect(rows).toHaveLength(3);
    });

    it('takes display_name from full_name, then name, then the email local part', async () => {
      const rows = await t.query<{ id: string; display_name: string }>(
        `select id, display_name from public.users`
      );
      const nameOf = (id: string) => rows.find((r) => r.id === id)?.display_name;

      expect(nameOf(alice)).toBe('Alice Ng');
      expect(nameOf(carol)).toBe('Carol');
      expect(nameOf(bob)).toBe('bob');
    });
  });

  describe('creating a house', () => {
    it('lets the owner insert and read back the row in one statement', async () => {
      await t.asUser(alice);
      // INSERT ... RETURNING only works if the SELECT policy matches the new row,
      // before the owner's membership row exists.
      const rows = await t.query<{ id: string; join_code: string }>(
        `insert into public.houses (name, owner_id)
         values ('Tuesday Night', $1)
         returning id, join_code`,
        [alice]
      );

      expect(rows).toHaveLength(1);
      houseId = rows[0].id;
      joinCode = rows[0].join_code;
    });

    it('generates a join code with no ambiguous characters', () => {
      // No I, L, O, 0 or 1 - these get read aloud and typed by hand.
      expect(joinCode).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
    });

    it('lets the owner enrol themselves', async () => {
      await t.asUser(alice);
      const n = await t.affected(
        `insert into public.memberships (house_id, user_id) values ($1, $2)`,
        [houseId, alice]
      );
      expect(n).toBe(1);
    });
  });

  describe('joining by code', () => {
    it('enrols the caller', async () => {
      await t.asUser(bob);
      const rows = await t.query(`select public.join_house($1) as house`, [joinCode]);
      expect(rows[0].house).toBeTruthy();

      const members = await t.query<{ n: number }>(
        `select count(*)::int as n from public.memberships where house_id = $1`,
        [houseId]
      );
      expect(members[0].n).toBe(2);
    });

    it('is idempotent', async () => {
      await t.asUser(bob);
      await t.query(`select public.join_house($1)`, [joinCode]);

      const members = await t.query<{ n: number }>(
        `select count(*)::int as n from public.memberships where house_id = $1`,
        [houseId]
      );
      expect(members[0].n).toBe(2);
    });

    it('rejects an unknown code', async () => {
      await t.asUser(carol);
      await expect(t.query(`select public.join_house('ZZZZZZ')`)).rejects.toThrow(
        /no house with that join code/
      );
    });
  });

  describe('leaving a house', () => {
    // A dedicated, throwaway house - never touches houseId/bob's membership in it,
    // which every test after this one still depends on.
    let leaveHouseId: string;
    let leaveJoinCode: string;

    beforeAll(async () => {
      await t.asUser(alice);
      const house = await t.query<{ id: string; join_code: string }>(
        `insert into public.houses (name, owner_id) values ('Leave Test House', $1) returning id, join_code`,
        [alice]
      );
      leaveHouseId = house[0].id;
      leaveJoinCode = house[0].join_code;
      await t.query(`insert into public.memberships (house_id, user_id) values ($1, $2)`, [
        leaveHouseId,
        alice,
      ]);

      await t.asUser(bob);
      await t.query(`select public.join_house($1)`, [leaveJoinCode]);
    });

    afterAll(async () => {
      await t.asUser(alice);
      await t.query(`delete from public.houses where id = $1`, [leaveHouseId]);
    });

    it("blocks the owner from deleting their own membership", async () => {
      await t.asUser(alice);
      const n = await t.affected(
        `delete from public.memberships where house_id = $1 and user_id = $2`,
        [leaveHouseId, alice]
      );
      expect(n).toBe(0);
    });

    it('lets a regular member leave', async () => {
      await t.asUser(bob);
      const n = await t.affected(
        `delete from public.memberships where house_id = $1 and user_id = $2`,
        [leaveHouseId, bob]
      );
      expect(n).toBe(1);
    });

    it("still lets the owner remove someone else's membership", async () => {
      await t.asUser(bob);
      await t.query(`select public.join_house($1)`, [leaveJoinCode]); // bob rejoins after leaving above

      await t.asUser(alice);
      const n = await t.affected(
        `delete from public.memberships where house_id = $1 and user_id = $2`,
        [leaveHouseId, bob]
      );
      expect(n).toBe(1);
    });
  });

  describe('deleting a house', () => {
    it('is refused for a non-owner, and cascades everything for the owner - even a settled game', async () => {
      await t.asUser(alice);
      const house = await t.query<{ id: string; join_code: string }>(
        `insert into public.houses (name, owner_id) values ('Delete Test House', $1) returning id, join_code`,
        [alice]
      );
      const deleteHouseId = house[0].id;
      await t.query(`insert into public.memberships (house_id, user_id) values ($1, $2)`, [
        deleteHouseId,
        alice,
      ]);

      await t.asUser(bob);
      await t.query(`select public.join_house($1)`, [house[0].join_code]);

      await t.asUser(alice);
      const game = await t.query<{ id: string }>(
        `insert into public.games (house_id) values ($1) returning id`,
        [deleteHouseId]
      );
      const player = await t.query<{ id: string }>(
        `insert into public.game_players (game_id, user_id) values ($1, $2) returning id`,
        [game[0].id, alice]
      );
      await t.query(`insert into public.buy_ins (game_player_id, amount_cents) values ($1, 2000)`, [
        player[0].id,
      ]);
      await t.query(`update public.game_players set final_stack_cents = 2000 where id = $1`, [
        player[0].id,
      ]);
      await t.query(`update public.games set status = 'settled' where id = $1`, [game[0].id]);

      await t.asUser(bob);
      const blocked = await t.affected(`delete from public.houses where id = $1`, [deleteHouseId]);
      expect(blocked).toBe(0);

      await t.asUser(alice);
      const n = await t.affected(`delete from public.houses where id = $1`, [deleteHouseId]);
      expect(n).toBe(1);

      const remainingMemberships = await t.query<{ n: number }>(
        `select count(*)::int as n from public.memberships where house_id = $1`,
        [deleteHouseId]
      );
      const remainingGames = await t.query<{ n: number }>(
        `select count(*)::int as n from public.games where house_id = $1`,
        [deleteHouseId]
      );
      const remainingPlayers = await t.query<{ n: number }>(
        `select count(*)::int as n from public.game_players where game_id = $1`,
        [game[0].id]
      );
      const remainingBuyIns = await t.query<{ n: number }>(
        `select count(*)::int as n from public.buy_ins where game_player_id = $1`,
        [player[0].id]
      );

      expect(remainingMemberships[0].n).toBe(0);
      expect(remainingGames[0].n).toBe(0);
      expect(remainingPlayers[0].n).toBe(0);
      expect(remainingBuyIns[0].n).toBe(0);
    });
  });

  describe('row level security', () => {
    it('hides houses, memberships and housemates from an outsider', async () => {
      await t.asUser(carol);

      const houses = await t.query<{ n: number }>(`select count(*)::int as n from public.houses`);
      const memberships = await t.query<{ n: number }>(
        `select count(*)::int as n from public.memberships`
      );
      const users = await t.query<{ n: number }>(`select count(*)::int as n from public.users`);

      expect(houses[0].n).toBe(0);
      expect(memberships[0].n).toBe(0);
      expect(users[0].n).toBe(1); // carol can still see herself
    });

    it('shows a member their house and their housemates', async () => {
      await t.asUser(bob);

      const houses = await t.query<{ n: number }>(`select count(*)::int as n from public.houses`);
      const users = await t.query<{ n: number }>(`select count(*)::int as n from public.users`);

      expect(houses[0].n).toBe(1);
      expect(users[0].n).toBe(2); // bob + alice, not carol
    });
  });

  describe('a game belongs to a house', () => {
    it('starts active', async () => {
      await t.asUser(alice);
      const rows = await t.query<{ id: string; status: string }>(
        `insert into public.games (house_id) values ($1) returning id, status`,
        [houseId]
      );

      gameId = rows[0].id;
      expect(rows[0].status).toBe('active');
    });

    it('refuses a player who is not a member of the house', async () => {
      await t.asUser(alice);
      // RLS stops an outsider writing to the game; this guard stops a member
      // adding an outsider as a player.
      await expect(
        t.query(`insert into public.game_players (game_id, user_id) values ($1, $2)`, [
          gameId,
          carol,
        ])
      ).rejects.toThrow(/not a member of the house/);
    });

    it('accepts members', async () => {
      await t.asUser(alice);
      const a = await t.query<{ id: string }>(
        `insert into public.game_players (game_id, user_id) values ($1, $2) returning id`,
        [gameId, alice]
      );
      const b = await t.query<{ id: string }>(
        `insert into public.game_players (game_id, user_id) values ($1, $2) returning id`,
        [gameId, bob]
      );

      alicePlayerId = a[0].id;
      bobPlayerId = b[0].id;
      expect(alicePlayerId).toBeTruthy();
      expect(bobPlayerId).toBeTruthy();
    });

    it('records a buy-in and a rebuy as separate rows', async () => {
      await t.asUser(alice);
      await t.query(`insert into public.buy_ins (game_player_id, amount_cents) values ($1, 10000)`, [
        alicePlayerId,
      ]);
      await t.query(`insert into public.buy_ins (game_player_id, amount_cents) values ($1, 5000)`, [
        alicePlayerId,
      ]);
      await t.query(`insert into public.buy_ins (game_player_id, amount_cents) values ($1, 10000)`, [
        bobPlayerId,
      ]);

      const rows = await t.query<{ n: number }>(
        `select count(*)::int as n from public.buy_ins where game_player_id = $1`,
        [alicePlayerId]
      );
      expect(rows[0].n).toBe(2);
    });
  });

  describe('settling a game', () => {
    it('refuses while every final stack is missing', async () => {
      await t.asUser(alice);
      await expect(
        t.query(`update public.games set status = 'settled' where id = $1`, [gameId])
      ).rejects.toThrow(/2 of 2 player\(s\) have no final stack/);
    });

    it('still refuses with one stack outstanding', async () => {
      await t.asUser(alice);
      await t.query(`update public.game_players set final_stack_cents = 20000 where id = $1`, [
        alicePlayerId,
      ]);

      await expect(
        t.query(`update public.games set status = 'settled' where id = $1`, [gameId])
      ).rejects.toThrow(/1 of 2 player\(s\) have no final stack/);
    });

    it('succeeds once everyone has cashed out, and stamps settled_at', async () => {
      await t.asUser(alice);

      const beforeRows = await t.query<{ settled_at: string | null }>(
        `select settled_at from public.games where id = $1`,
        [gameId]
      );
      expect(beforeRows[0].settled_at).toBeNull();

      await t.query(`update public.game_players set final_stack_cents = 5000 where id = $1`, [
        bobPlayerId,
      ]);

      const n = await t.affected(`update public.games set status = 'settled' where id = $1`, [
        gameId,
      ]);
      expect(n).toBe(1);

      const afterRows = await t.query<{ settled_at: string | null; created_at: string }>(
        `select settled_at, created_at from public.games where id = $1`,
        [gameId]
      );
      // Stamped by the trigger, not the client - and distinct from created_at,
      // which is when the game was started, not when it was settled.
      expect(afterRows[0].settled_at).not.toBeNull();
      expect(new Date(afterRows[0].settled_at!).getTime()).toBeGreaterThanOrEqual(
        new Date(afterRows[0].created_at).getTime()
      );
    });

    it('refuses to settle a game with no players', async () => {
      await t.asUser(alice);
      const empty = await t.query<{ id: string }>(
        `insert into public.games (house_id) values ($1) returning id`,
        [houseId]
      );

      await expect(
        t.query(`update public.games set status = 'settled' where id = $1`, [empty[0].id])
      ).rejects.toThrow(/has no players/);

      // The rejected settle leaves this game active - clean it up, or it is the
      // house's one allowed active game for every test that runs after this one
      // (see "at most one active game per house" below).
      await t.query(`delete from public.games where id = $1`, [empty[0].id]);
    });
  });

  describe('settled games are frozen against edits', () => {
    // RLS filters these rows out rather than raising, so the tell is 0 rows
    // affected, not an error. Deleting the game itself is a different question -
    // see "deleting a game" below, since the owner actually can.
    it('rejects edits to a player or a buy-in', async () => {
      await t.asUser(alice);

      const player = await t.affected(
        `update public.game_players set final_stack_cents = 999999 where id = $1`,
        [alicePlayerId]
      );
      const buyIn = await t.affected(
        `update public.buy_ins set amount_cents = 1 where game_player_id = $1`,
        [alicePlayerId]
      );

      expect({ player, buyIn }).toEqual({ player: 0, buyIn: 0 });
    });
  });

  describe('deleting a game', () => {
    // A dedicated, throwaway house - never touches houseId/gameId, which the
    // leaderboard tests below still depend on.
    let deleteGameHouseId: string;
    let deleteGameJoinCode: string;

    beforeAll(async () => {
      await t.asUser(alice);
      const house = await t.query<{ id: string; join_code: string }>(
        `insert into public.houses (name, owner_id) values ('Delete Game Test House', $1) returning id, join_code`,
        [alice]
      );
      deleteGameHouseId = house[0].id;
      deleteGameJoinCode = house[0].join_code;
      await t.query(`insert into public.memberships (house_id, user_id) values ($1, $2)`, [
        deleteGameHouseId,
        alice,
      ]);

      await t.asUser(bob);
      await t.query(`select public.join_house($1)`, [deleteGameJoinCode]);
    });

    afterAll(async () => {
      await t.asUser(alice);
      await t.query(`delete from public.houses where id = $1`, [deleteGameHouseId]);
    });

    it('refuses a non-owner member, whether the game is active or settled', async () => {
      await t.asUser(alice);
      const game = await t.query<{ id: string }>(
        `insert into public.games (house_id) values ($1) returning id`,
        [deleteGameHouseId]
      );

      await t.asUser(bob);
      const blockedActive = await t.affected(`delete from public.games where id = $1`, [
        game[0].id,
      ]);
      expect(blockedActive).toBe(0);

      await t.asUser(alice);
      const player = await t.query<{ id: string }>(
        `insert into public.game_players (game_id, user_id) values ($1, $2) returning id`,
        [game[0].id, alice]
      );
      await t.query(`update public.game_players set final_stack_cents = 0 where id = $1`, [
        player[0].id,
      ]);
      await t.query(`update public.games set status = 'settled' where id = $1`, [game[0].id]);

      await t.asUser(bob);
      const blockedSettled = await t.affected(`delete from public.games where id = $1`, [
        game[0].id,
      ]);
      expect(blockedSettled).toBe(0);

      await t.asUser(alice);
      await t.query(`delete from public.games where id = $1`, [game[0].id]);
    });

    it('lets the owner delete an active game', async () => {
      await t.asUser(alice);
      const game = await t.query<{ id: string }>(
        `insert into public.games (house_id) values ($1) returning id`,
        [deleteGameHouseId]
      );

      const n = await t.affected(`delete from public.games where id = $1`, [game[0].id]);
      expect(n).toBe(1);
    });

    it('lets the owner delete a settled game, cascading its players and buy-ins', async () => {
      await t.asUser(alice);
      const game = await t.query<{ id: string }>(
        `insert into public.games (house_id) values ($1) returning id`,
        [deleteGameHouseId]
      );
      const player = await t.query<{ id: string }>(
        `insert into public.game_players (game_id, user_id) values ($1, $2) returning id`,
        [game[0].id, alice]
      );
      await t.query(`insert into public.buy_ins (game_player_id, amount_cents) values ($1, 2000)`, [
        player[0].id,
      ]);
      await t.query(`update public.game_players set final_stack_cents = 2000 where id = $1`, [
        player[0].id,
      ]);
      await t.query(`update public.games set status = 'settled' where id = $1`, [game[0].id]);

      const n = await t.affected(`delete from public.games where id = $1`, [game[0].id]);
      expect(n).toBe(1);

      const remainingPlayers = await t.query<{ n: number }>(
        `select count(*)::int as n from public.game_players where game_id = $1`,
        [game[0].id]
      );
      const remainingBuyIns = await t.query<{ n: number }>(
        `select count(*)::int as n from public.buy_ins where game_player_id = $1`,
        [player[0].id]
      );
      expect(remainingPlayers[0].n).toBe(0);
      expect(remainingBuyIns[0].n).toBe(0);
    });
  });

  describe('at most one active game per house', () => {
    // gameId was settled by the previous block, so houseId currently has zero
    // active games - a clean slate for these two tests.

    it('rejects a second active game while one is already active', async () => {
      await t.asUser(alice);

      const first = await t.query<{ id: string }>(
        `insert into public.games (house_id) values ($1) returning id`,
        [houseId]
      );
      const firstActiveGameId = first[0].id;

      await expect(
        t.query(`insert into public.games (house_id) values ($1)`, [houseId])
      ).rejects.toThrow(/duplicate key value violates unique constraint "games_one_active_per_house"/);

      // Free the slot so it doesn't leak into the next test.
      await t.query(`delete from public.games where id = $1`, [firstActiveGameId]);
    });

    it('allows a new active game once the earlier one is no longer active', async () => {
      await t.asUser(alice);

      // The games INSERT policy requires status = 'active', so a game can never be
      // created already settled - meaning the only way to reach "no longer
      // active" is a delete or the real settle flow (covered elsewhere in this
      // file). A delete is enough to isolate just the partial index's behavior:
      // uniqueness is scoped to status = 'active', not to house_id alone.
      const first = await t.query<{ id: string }>(
        `insert into public.games (house_id) values ($1) returning id`,
        [houseId]
      );
      await t.query(`delete from public.games where id = $1`, [first[0].id]);

      const second = await t.query<{ id: string }>(
        `insert into public.games (house_id) values ($1) returning id`,
        [houseId]
      );
      expect(second).toHaveLength(1);

      await t.query(`delete from public.games where id = $1`, [second[0].id]);
    });
  });

  describe('buy-in corrections', () => {
    // A self-contained game+player, created and torn down within this block, so
    // these rows never touch alice's totals in the leaderboard tests below.
    let correctionGameId: string;
    let correctionPlayerId: string;

    beforeAll(async () => {
      await t.asUser(alice);
      const game = await t.query<{ id: string }>(
        `insert into public.games (house_id) values ($1) returning id`,
        [houseId]
      );
      correctionGameId = game[0].id;

      const player = await t.query<{ id: string }>(
        `insert into public.game_players (game_id, user_id) values ($1, $2) returning id`,
        [correctionGameId, alice]
      );
      correctionPlayerId = player[0].id;

      await t.query(`insert into public.buy_ins (game_player_id, amount_cents) values ($1, 5000)`, [
        correctionPlayerId,
      ]);
    });

    afterAll(async () => {
      await t.asUser(alice);
      await t.query(`delete from public.games where id = $1`, [correctionGameId]);
    });

    it('rejects a zero-amount row - it would correct nothing', async () => {
      await t.asUser(alice);
      await expect(
        t.query(`insert into public.buy_ins (game_player_id, amount_cents) values ($1, 0)`, [
          correctionPlayerId,
        ])
      ).rejects.toThrow(/violates check constraint "buy_ins_amount_nonzero"/);
    });

    it('accepts a negative row that corrects a mistaken buy-in', async () => {
      await t.asUser(alice);
      // The $50 buy-in from beforeAll was a mis-click; -$30 corrects it to $20.
      await t.query(`insert into public.buy_ins (game_player_id, amount_cents) values ($1, -3000)`, [
        correctionPlayerId,
      ]);

      const rows = await t.query<{ total: string }>(
        `select sum(amount_cents)::int as total from public.buy_ins where game_player_id = $1`,
        [correctionPlayerId]
      );
      expect(Number(rows[0].total)).toBe(2000);
    });
  });

  describe('settle requires nets to sum to zero', () => {
    it('refuses a settle where every stack is present but the numbers do not balance', async () => {
      await t.asUser(alice);

      const game = await t.query<{ id: string }>(
        `insert into public.games (house_id) values ($1) returning id`,
        [houseId]
      );
      const mismatchGameId = game[0].id;

      const a = await t.query<{ id: string }>(
        `insert into public.game_players (game_id, user_id) values ($1, $2) returning id`,
        [mismatchGameId, alice]
      );
      const b = await t.query<{ id: string }>(
        `insert into public.game_players (game_id, user_id) values ($1, $2) returning id`,
        [mismatchGameId, bob]
      );

      await t.query(`insert into public.buy_ins (game_player_id, amount_cents) values ($1, 2000)`, [
        a[0].id,
      ]);
      await t.query(`insert into public.buy_ins (game_player_id, amount_cents) values ($1, 2000)`, [
        b[0].id,
      ]);

      // Both stacks are present (passes the earlier checks), but a's stack was
      // mistyped: 2500 instead of 2000, so the table gained $5 that never
      // existed. Net total: +500 - 2000 = -1500 cents, not zero.
      await t.query(`update public.game_players set final_stack_cents = 2500 where id = $1`, [
        a[0].id,
      ]);
      await t.query(`update public.game_players set final_stack_cents = 0 where id = $1`, [b[0].id]);

      await expect(
        t.query(`update public.games set status = 'settled' where id = $1`, [mismatchGameId])
      ).rejects.toThrow(/nets total -1500 cents instead of 0/);

      // The rejected settle must not have left the game settled anyway.
      const rows = await t.query<{ status: string; settled_at: string | null }>(
        `select status, settled_at from public.games where id = $1`,
        [mismatchGameId]
      );
      expect(rows[0]).toEqual({ status: 'active', settled_at: null });

      await t.query(`delete from public.games where id = $1`, [mismatchGameId]);
    });
  });

  describe('leaderboard', () => {
    it('nets each player over settled games', async () => {
      await t.asUser(alice);
      const rows = await t.query<{ user_id: string; games_played: number; net_cents: number }>(
        `select user_id, games_played, net_cents from public.house_leaderboards`
      );

      const netOf = (id: string) => Number(rows.find((r) => r.user_id === id)?.net_cents);

      expect(rows).toHaveLength(2);
      expect(netOf(alice)).toBe(5000); // 20000 - (10000 + 5000), rebuy counted once
      expect(netOf(bob)).toBe(-5000); //  5000 - 10000
      expect(rows.every((r) => r.games_played === 1)).toBe(true);
    });

    it('always nets to zero across the table', async () => {
      await t.asUser(alice);
      const rows = await t.query<{ net_cents: number }>(
        `select net_cents from public.house_leaderboards`
      );

      expect(rows.reduce((sum, r) => sum + Number(r.net_cents), 0)).toBe(0);
    });

    it('returns net_cents as a number, not a numeric string', async () => {
      await t.asUser(alice);
      const rows = await t.query<{ net_cents: number }>(
        `select net_cents from public.house_leaderboards limit 1`
      );

      // sum() over bigint yields numeric, which PostgREST serialises as a string.
      // The view casts back to bigint to keep this a plain number on the client.
      expect(typeof rows[0].net_cents).not.toBe('string');
    });

    it('ignores games that are still active', async () => {
      await t.asUser(alice);
      const game = await t.query<{ id: string }>(
        `insert into public.games (house_id) values ($1) returning id`,
        [houseId]
      );
      const player = await t.query<{ id: string }>(
        `insert into public.game_players (game_id, user_id) values ($1, $2) returning id`,
        [game[0].id, alice]
      );
      await t.query(`insert into public.buy_ins (game_player_id, amount_cents) values ($1, 50000)`, [
        player[0].id,
      ]);
      await t.query(`update public.game_players set final_stack_cents = 0 where id = $1`, [
        player[0].id,
      ]);

      const rows = await t.query<{ net_cents: number }>(
        `select net_cents from public.house_leaderboards where user_id = $1`,
        [alice]
      );
      expect(Number(rows[0].net_cents)).toBe(5000); // a 500.00 loss that has not settled
    });

    it('is invisible to someone outside the house', async () => {
      // The view is security_invoker; without it a plain view would run with its
      // owner's rights and leak every house's standings.
      await t.asUser(carol);
      const rows = await t.query<{ n: number }>(
        `select count(*)::int as n from public.house_leaderboards`
      );
      expect(rows[0].n).toBe(0);
    });
  });

  describe('avatar uploads', () => {
    it("lets a user upload into their own folder, not someone else's", async () => {
      await t.asUser(alice);
      const own = await t.affected(
        `insert into storage.objects (bucket_id, name, owner) values ('avatars', $1, $2)`,
        [`${alice}/avatar.jpg`, alice]
      );
      expect(own).toBe(1);

      await expect(
        t.query(`insert into storage.objects (bucket_id, name, owner) values ('avatars', $1, $2)`, [
          `${bob}/avatar.jpg`,
          alice,
        ])
      ).rejects.toThrow(/row-level security/);
    });

    it('is publicly readable, including by a signed-out caller', async () => {
      await t.asAnon();
      const rows = await t.query<{ name: string }>(
        `select name from storage.objects where bucket_id = 'avatars' and name = $1`,
        [`${alice}/avatar.jpg`]
      );
      expect(rows).toHaveLength(1);
    });

    it("lets a user replace their own avatar, not someone else's", async () => {
      await t.asUser(bob);
      const stranger = await t.affected(
        `update storage.objects set name = name where bucket_id = 'avatars' and name = $1`,
        [`${alice}/avatar.jpg`]
      );
      expect(stranger).toBe(0);

      await t.asUser(alice);
      const owner = await t.affected(
        `update storage.objects set name = name where bucket_id = 'avatars' and name = $1`,
        [`${alice}/avatar.jpg`]
      );
      expect(owner).toBe(1);
    });

    it("lets a user delete their own avatar, not someone else's", async () => {
      await t.asUser(bob);
      const stranger = await t.affected(
        `delete from storage.objects where bucket_id = 'avatars' and name = $1`,
        [`${alice}/avatar.jpg`]
      );
      expect(stranger).toBe(0);

      await t.asUser(alice);
      const owner = await t.affected(
        `delete from storage.objects where bucket_id = 'avatars' and name = $1`,
        [`${alice}/avatar.jpg`]
      );
      expect(owner).toBe(1);
    });
  });

  describe('anonymous access', () => {
    const relations = [
      'users',
      'houses',
      'memberships',
      'games',
      'game_players',
      'buy_ins',
      'house_leaderboards',
    ];

    it.each(relations)('is denied on %s', async (relation) => {
      await t.asAnon();
      await expect(t.query(`select * from public.${relation}`)).rejects.toThrow(/permission denied/);
    });
  });
});
