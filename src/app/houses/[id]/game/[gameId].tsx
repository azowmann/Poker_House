import { Redirect, Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Alert, Platform, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';

import { Button } from '@/components/button';
import { Message } from '@/components/message';
import { ScreenLoader } from '@/components/screen-loader';
import { ThemedText } from '@/components/themed-text';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useAuth } from '@/lib/auth';
import {
  centsToEditableString,
  formatCents,
  formatSignedCents,
  parseDollarsToCents,
  parseSignedDollarsToCents,
} from '@/lib/format';
import {
  addPlayerToGame,
  addRebuy,
  computeGameSettlement,
  deleteGame,
  getGame,
  listGamePlayers,
  listHouseMembers,
  removePlayer,
  settleGame,
  setPlayerBuyIn,
  type Game,
  type GamePlayer,
  type GameSettlement,
  type HouseMember,
} from '@/lib/games';
import { getHouse, type House } from '@/lib/houses';

/** Which inline editor, if any, is open for a given player row. */
type PlayerEditorKind = 'rebuy' | 'setTotal';

/** What a new player is buying in for, until someone changes it. Not stored
 *  anywhere - just this screen's starting point for the shared "buy-in amount" field. */
const DEFAULT_BUY_IN = '20.00';

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; game: Game; house: House; players: GamePlayer[]; members: HouseMember[] };

type Mode = 'live' | 'settling';

/**
 * The live-game screen: add players, take buy-ins and rebuys, then settle.
 *
 * One route, two modes, rather than a second screen for settling - tapping
 * "Settle game" swaps the same screen's content into stack-entry mode instead of
 * navigating, so there's nowhere for a half-entered set of final stacks to get
 * lost by a back-button tap.
 */
export default function LiveGameScreen() {
  const { id: houseId, gameId } = useLocalSearchParams<{ id: string; gameId: string }>();
  const theme = useTheme();
  const router = useRouter();
  const { session, isRestoring } = useAuth();

  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [mode, setMode] = useState<Mode>('live');

  // "Add players" section
  const [buyInInput, setBuyInInput] = useState(DEFAULT_BUY_IN);
  const [addingUserId, setAddingUserId] = useState<string | null>(null);
  const [addError, setAddError] = useState<string | null>(null);

  // Per-player inline editor - a custom rebuy (may be negative, to correct a
  // mistake) or a full override of a player's total buy-in. Only one row's editor
  // is open at a time.
  const [editor, setEditor] = useState<{ gamePlayerId: string; kind: PlayerEditorKind } | null>(
    null
  );
  const [editorInput, setEditorInput] = useState('');
  const [busyPlayerId, setBusyPlayerId] = useState<string | null>(null);
  const [rebuyError, setRebuyError] = useState<string | null>(null);

  // Settle mode
  const [finalStackInputs, setFinalStackInputs] = useState<Record<string, string>>({});
  const [settling, setSettling] = useState(false);
  const [settleError, setSettleError] = useState<string | null>(null);

  // Deleting the game - owner only, gated by state.house.owner_id below.
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const refresh = useCallback(
    async (isCancelled: () => boolean) => {
      if (!houseId || !gameId) return;

      try {
        const game = await getGame(gameId);
        if (isCancelled()) return;

        if (!game) {
          setState({ status: 'error', message: 'That game does not exist.' });
          return;
        }
        if (game.house_id !== houseId) {
          setState({ status: 'error', message: 'That game does not belong to this house.' });
          return;
        }

        const [house, players, members] = await Promise.all([
          getHouse(houseId),
          listGamePlayers(game.id),
          listHouseMembers(houseId),
        ]);
        if (isCancelled()) return;

        if (!house) {
          setState({ status: 'error', message: 'That house does not exist, or you are not a member of it.' });
          return;
        }

        setState({ status: 'ready', game, house, players, members });
      } catch (cause) {
        if (isCancelled()) return;
        setState({
          status: 'error',
          message: cause instanceof Error ? cause.message : 'Could not load this game.',
        });
      }
    },
    [houseId, gameId]
  );

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      void refresh(() => cancelled);
      return () => {
        cancelled = true;
      };
    }, [refresh])
  );

  // Computed, not fetched: the results screen needs nothing beyond what `refresh`
  // already loaded (game_players joined to buy_ins - see listGamePlayers). Must sit
  // above every early return below, since hooks can't be called conditionally.
  const settlementResult = useMemo<
    { status: 'ok'; settlement: GameSettlement } | { status: 'error'; message: string } | null
  >(() => {
    if (state.status !== 'ready' || state.game.status !== 'settled') {
      return null;
    }
    try {
      return { status: 'ok', settlement: computeGameSettlement(state.players) };
    } catch (cause) {
      return {
        status: 'error',
        message:
          cause instanceof Error ? cause.message : 'Could not compute the settlement for this game.',
      };
    }
  }, [state]);

  if (isRestoring) {
    return <ScreenLoader />;
  }

  if (!session) {
    return <Redirect href="/sign-in" />;
  }

  if (state.status === 'loading') {
    return <ScreenLoader />;
  }

  if (state.status === 'error') {
    return (
      <View style={styles.content}>
        <Message tone="error">{state.message}</Message>
      </View>
    );
  }

  const { game, house, players, members } = state;
  const isOwner = house.owner_id === session.user.id;
  const availableMembers = members.filter(
    (member) => !players.some((player) => player.user_id === member.user_id)
  );

  function handleDeleteGame() {
    const isSettled = game.status === 'settled';

    Alert.alert(
      isSettled ? 'Delete this settled game?' : 'Delete this game?',
      isSettled
        ? "This changes everyone's all-time total on the leaderboard, immediately and " +
            'permanently. This cannot be undone.'
        : 'This removes the game and everyone added to it. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            setDeleting(true);
            setDeleteError(null);
            try {
              await deleteGame(game.id);
              router.replace(`/houses/${houseId}`);
            } catch (cause) {
              setDeleteError(cause instanceof Error ? cause.message : 'Could not delete the game.');
              setDeleting(false);
            }
          },
        },
      ]
    );
  }

  async function handleAddPlayer(member: HouseMember) {
    const cents = parseDollarsToCents(buyInInput);
    if (cents === null || cents <= 0) {
      setAddError('Enter a buy-in amount above $0 before adding players.');
      return;
    }

    setAddingUserId(member.user_id);
    setAddError(null);
    try {
      await addPlayerToGame(game.id, member.user_id, cents);
      await refresh(() => false);
    } catch (cause) {
      setAddError(cause instanceof Error ? cause.message : 'Could not add that player.');
    } finally {
      setAddingUserId(null);
    }
  }

  async function submitRebuy(player: GamePlayer, amountCents: number) {
    setBusyPlayerId(player.id);
    setRebuyError(null);
    try {
      await addRebuy(player.id, amountCents);
      setEditor(null);
      await refresh(() => false);
    } catch (cause) {
      setRebuyError(cause instanceof Error ? cause.message : 'Could not record the rebuy.');
    } finally {
      setBusyPlayerId(null);
    }
  }

  function openRebuyEditor(player: GamePlayer) {
    setEditor({ gamePlayerId: player.id, kind: 'rebuy' });
    setEditorInput('');
    setRebuyError(null);
  }

  /** Prefilled with the current total, since this corrects a number rather than
   *  adding to one - see the "does this make sense?" thread in project history. */
  function openSetTotalEditor(player: GamePlayer) {
    setEditor({ gamePlayerId: player.id, kind: 'setTotal' });
    setEditorInput(centsToEditableString(player.buy_in_cents));
    setRebuyError(null);
  }

  function closeEditor() {
    setEditor(null);
  }

  function handleConfirmRebuyEditor(player: GamePlayer) {
    const cents = parseSignedDollarsToCents(editorInput);
    if (cents === null || cents === 0) {
      setRebuyError('Enter a non-zero amount - negative to correct a mistake.');
      return;
    }
    if (player.buy_in_cents + cents < 0) {
      setRebuyError(`That would take ${player.display_name}'s total below $0.`);
      return;
    }
    void submitRebuy(player, cents);
  }

  async function handleConfirmSetTotalEditor(player: GamePlayer) {
    const cents = parseDollarsToCents(editorInput);
    if (cents === null) {
      setRebuyError('Enter a valid total.');
      return;
    }

    setBusyPlayerId(player.id);
    setRebuyError(null);
    try {
      // A no-op (the total is unchanged) resolves without inserting anything -
      // see setPlayerBuyIn.
      await setPlayerBuyIn(player.id, player.buy_in_cents, cents);
      setEditor(null);
      await refresh(() => false);
    } catch (cause) {
      setRebuyError(cause instanceof Error ? cause.message : 'Could not update their buy-in.');
    } finally {
      setBusyPlayerId(null);
    }
  }

  function handleRemovePlayer(player: GamePlayer) {
    const hasBuyIns = player.buy_in_cents > 0;

    Alert.alert(
      `Remove ${player.display_name}?`,
      hasBuyIns
        ? `This also deletes their ${formatCents(player.buy_in_cents)} in buy-ins for this game. They can be added again later.`
        : 'They can be added again later.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            setBusyPlayerId(player.id);
            setRebuyError(null);
            try {
              await removePlayer(player.id);
              await refresh(() => false);
            } catch (cause) {
              setRebuyError(cause instanceof Error ? cause.message : 'Could not remove that player.');
            } finally {
              setBusyPlayerId(null);
            }
          },
        },
      ]
    );
  }

  function enterSettleMode() {
    setFinalStackInputs(Object.fromEntries(players.map((player) => [player.id, ''])));
    setSettleError(null);
    setMode('settling');
  }

  async function handleConfirmSettle() {
    const entries: { gamePlayerId: string; cents: number }[] = [];

    for (const player of players) {
      const cents = parseDollarsToCents(finalStackInputs[player.id] ?? '');
      if (cents === null) {
        setSettleError(`Enter a final stack for ${player.display_name}.`);
        return;
      }
      entries.push({ gamePlayerId: player.id, cents });
    }

    setSettling(true);
    setSettleError(null);
    try {
      await settleGame(game.id, entries);
      // No navigation - refresh() picks up status: 'settled' on this same game
      // and the branch below takes over, showing the results immediately.
      await refresh(() => false);
    } catch (cause) {
      // The settle-guard trigger's rejection lands here too, already turned into a
      // sentence by settleGame - this is where it has to be surfaced clearly.
      setSettleError(cause instanceof Error ? cause.message : 'Could not settle the game.');
    } finally {
      setSettling(false);
    }
  }

  if (game.status === 'settled') {
    return (
      <>
        <Stack.Screen options={{ title: 'Results' }} />
        <ScrollView contentContainerStyle={styles.content}>
          {settlementResult?.status === 'error' ? (
            <Message tone="error">{settlementResult.message}</Message>
          ) : settlementResult?.status === 'ok' ? (
            <>
              <View style={styles.section}>
                <ThemedText type="smallBold" themeColor="textSecondary" style={styles.sectionTitle}>
                  Transfers
                </ThemedText>
                {settlementResult.settlement.transfers.length === 0 ? (
                  <ThemedText type="small" themeColor="textSecondary">
                    Everyone is square — no transfers needed
                  </ThemedText>
                ) : (
                  <View style={[styles.card, { backgroundColor: theme.backgroundElement }]}>
                    {settlementResult.settlement.transfers.map((transfer, index) => (
                      <View
                        key={`${transfer.from_display_name}-${transfer.to_display_name}-${index}`}
                        style={[
                          styles.transferRow,
                          index > 0 && styles.rowDivider,
                          { borderColor: theme.backgroundSelected },
                        ]}>
                        <ThemedText>
                          {transfer.from_display_name} pays {transfer.to_display_name}{' '}
                          {formatCents(transfer.amount_cents)}
                        </ThemedText>
                      </View>
                    ))}
                  </View>
                )}
              </View>

              <View style={styles.section}>
                <ThemedText type="smallBold" themeColor="textSecondary" style={styles.sectionTitle}>
                  Player nets
                </ThemedText>
                <View style={[styles.card, { backgroundColor: theme.backgroundElement }]}>
                  {settlementResult.settlement.players.map((player, index) => (
                    <View
                      key={player.user_id}
                      style={[
                        styles.netRow,
                        index > 0 && styles.rowDivider,
                        { borderColor: theme.backgroundSelected },
                      ]}>
                      <ThemedText numberOfLines={1} style={styles.netName}>
                        {player.display_name}
                      </ThemedText>
                      <ThemedText style={player.net_cents >= 0 ? styles.positive : styles.negative}>
                        {formatSignedCents(player.net_cents)}
                      </ThemedText>
                    </View>
                  ))}
                </View>
              </View>
            </>
          ) : null}

          <Button label="Done" onPress={() => router.replace(`/houses/${houseId}`)} />

          {isOwner ? (
            <View style={styles.section}>
              {deleteError ? <Message tone="error">{deleteError}</Message> : null}
              <Button
                label="Delete game"
                variant="secondary"
                onPress={handleDeleteGame}
                busy={deleting}
              />
            </View>
          ) : null}
        </ScrollView>
      </>
    );
  }

  return (
    <>
      <Stack.Screen options={{ title: mode === 'live' ? 'Live game' : 'Settle game' }} />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {mode === 'live' ? (
          <>
            <View style={styles.section}>
              <ThemedText type="smallBold" themeColor="textSecondary" style={styles.sectionTitle}>
                Buy-in amount
              </ThemedText>
              <View style={[styles.amountRow, { backgroundColor: theme.backgroundElement }]}>
                <ThemedText type="default">$</ThemedText>
                <TextInput
                  value={buyInInput}
                  onChangeText={setBuyInInput}
                  keyboardType="decimal-pad"
                  placeholder="20.00"
                  placeholderTextColor={theme.textSecondary}
                  style={[styles.amountInput, { color: theme.text }]}
                />
              </View>
              <ThemedText type="small" themeColor="textSecondary">
                Used as the buy-in when you add a new player below.
              </ThemedText>
            </View>

            <View style={styles.section}>
              <ThemedText type="smallBold" themeColor="textSecondary" style={styles.sectionTitle}>
                Players in this game
              </ThemedText>
              {rebuyError ? <Message tone="error">{rebuyError}</Message> : null}
              {players.length === 0 ? (
                <ThemedText type="small" themeColor="textSecondary">
                  No players yet. Add someone below.
                </ThemedText>
              ) : (
                <View style={styles.playerList}>
                  {players.map((player) => {
                    const activeEditor: PlayerEditorKind | null =
                      editor !== null && editor.gamePlayerId === player.id ? editor.kind : null;

                    return (
                      <PlayerRow
                        key={player.id}
                        player={player}
                        busy={busyPlayerId === player.id}
                        editorKind={activeEditor}
                        otherEditorOpen={editor !== null && editor.gamePlayerId !== player.id}
                        editorValue={editorInput}
                        onQuickRebuy={() => void submitRebuy(player, player.first_buy_in_cents)}
                        onOpenRebuyEditor={() => openRebuyEditor(player)}
                        onOpenSetTotalEditor={() => openSetTotalEditor(player)}
                        onRemove={() => handleRemovePlayer(player)}
                        onCancelEditor={closeEditor}
                        onChangeEditor={setEditorInput}
                        onConfirmEditor={() =>
                          activeEditor === 'rebuy'
                            ? handleConfirmRebuyEditor(player)
                            : void handleConfirmSetTotalEditor(player)
                        }
                      />
                    );
                  })}
                </View>
              )}
            </View>

            <View style={styles.section}>
              <ThemedText type="smallBold" themeColor="textSecondary" style={styles.sectionTitle}>
                Add players
              </ThemedText>
              {addError ? <Message tone="error">{addError}</Message> : null}
              {availableMembers.length === 0 ? (
                <ThemedText type="small" themeColor="textSecondary">
                  Everyone in the house has been added.
                </ThemedText>
              ) : (
                <View style={styles.playerList}>
                  {availableMembers.map((member) => (
                    <Pressable
                      key={member.user_id}
                      accessibilityRole="button"
                      disabled={addingUserId !== null}
                      onPress={() => handleAddPlayer(member)}
                      style={({ pressed }) => [
                        styles.addRow,
                        {
                          backgroundColor: pressed
                            ? theme.backgroundSelected
                            : theme.backgroundElement,
                        },
                        addingUserId !== null && addingUserId !== member.user_id && styles.dimmed,
                      ]}>
                      <ThemedText>+ {member.display_name}</ThemedText>
                      {addingUserId === member.user_id ? (
                        <ThemedText type="small" themeColor="textSecondary">
                          Adding…
                        </ThemedText>
                      ) : null}
                    </Pressable>
                  ))}
                </View>
              )}
            </View>

            <Button
              label="Settle game"
              onPress={enterSettleMode}
              disabled={players.length < 2}
            />
            {players.length < 2 ? (
              <ThemedText type="small" themeColor="textSecondary" style={styles.centered}>
                Add at least 2 players to settle.
              </ThemedText>
            ) : null}

            {isOwner ? (
              <View style={styles.section}>
                {deleteError ? <Message tone="error">{deleteError}</Message> : null}
                <Button
                  label="Delete game"
                  variant="secondary"
                  onPress={handleDeleteGame}
                  busy={deleting}
                />
              </View>
            ) : null}
          </>
        ) : (
          <>
            <View style={styles.section}>
              <ThemedText type="smallBold" themeColor="textSecondary" style={styles.sectionTitle}>
                Enter final stacks
              </ThemedText>
              {settleError ? <Message tone="error">{settleError}</Message> : null}
              <View style={styles.playerList}>
                {players.map((player) => (
                  <View
                    key={player.id}
                    style={[styles.settleRow, { backgroundColor: theme.backgroundElement }]}>
                    <View style={styles.settleName}>
                      <ThemedText numberOfLines={1}>{player.display_name}</ThemedText>
                      <ThemedText type="small" themeColor="textSecondary">
                        Bought in {formatCents(player.buy_in_cents)}
                      </ThemedText>
                    </View>
                    <View
                      style={[
                        styles.amountRow,
                        styles.amountRowFixed,
                        { backgroundColor: theme.background },
                      ]}>
                      <ThemedText type="default">$</ThemedText>
                      <TextInput
                        value={finalStackInputs[player.id] ?? ''}
                        onChangeText={(next) =>
                          setFinalStackInputs((prev) => ({ ...prev, [player.id]: next }))
                        }
                        keyboardType="decimal-pad"
                        placeholder="0.00"
                        placeholderTextColor={theme.textSecondary}
                        editable={!settling}
                        style={[styles.amountInput, { color: theme.text }]}
                      />
                    </View>
                  </View>
                ))}
              </View>
            </View>

            <Button label="Confirm" onPress={handleConfirmSettle} busy={settling} />
            <Pressable
              accessibilityRole="button"
              disabled={settling}
              onPress={() => setMode('live')}
              style={styles.cancelLink}>
              <ThemedText type="small" themeColor="textSecondary">
                Back to live game
              </ThemedText>
            </Pressable>
          </>
        )}
      </ScrollView>
    </>
  );
}

function PlayerRow({
  player,
  busy,
  editorKind,
  otherEditorOpen,
  editorValue,
  onQuickRebuy,
  onOpenRebuyEditor,
  onOpenSetTotalEditor,
  onRemove,
  onCancelEditor,
  onChangeEditor,
  onConfirmEditor,
}: {
  player: GamePlayer;
  busy: boolean;
  /** Which editor is open for THIS row, or null if neither is. */
  editorKind: PlayerEditorKind | null;
  /** True when a DIFFERENT row's editor is open - disables this row's controls
   *  rather than allowing two rows to be mutated at once. */
  otherEditorOpen: boolean;
  editorValue: string;
  onQuickRebuy: () => void;
  onOpenRebuyEditor: () => void;
  onOpenSetTotalEditor: () => void;
  onRemove: () => void;
  onCancelEditor: () => void;
  onChangeEditor: (value: string) => void;
  onConfirmEditor: () => void;
}) {
  const theme = useTheme();
  const controlsDisabled = busy || otherEditorOpen;

  return (
    <View style={[styles.playerRow, { backgroundColor: theme.backgroundElement }]}>
      <View style={styles.playerHeader}>
        <View style={styles.settleName}>
          <ThemedText numberOfLines={1}>{player.display_name}</ThemedText>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Set ${player.display_name}'s total buy-in`}
            disabled={controlsDisabled}
            hitSlop={8}
            onPress={onOpenSetTotalEditor}>
            <ThemedText type="small" themeColor="textSecondary">
              Bought in {formatCents(player.buy_in_cents)}
            </ThemedText>
          </Pressable>
        </View>

        {editorKind === null ? (
          <View style={styles.rebuyButtons}>
            <Pressable
              accessibilityRole="button"
              disabled={controlsDisabled}
              onPress={onQuickRebuy}
              style={({ pressed }) => [
                styles.rebuyButton,
                { backgroundColor: pressed ? theme.backgroundSelected : theme.background },
              ]}>
              <ThemedText type="smallBold">
                {busy ? '…' : `+ Rebuy ${formatCents(player.first_buy_in_cents)}`}
              </ThemedText>
            </Pressable>
            <Pressable accessibilityRole="button" disabled={controlsDisabled} onPress={onOpenRebuyEditor}>
              <ThemedText type="small" themeColor="textSecondary">
                Custom
              </ThemedText>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Remove ${player.display_name}`}
              disabled={controlsDisabled}
              onPress={onRemove}>
              <ThemedText type="small" style={styles.negative}>
                − Remove
              </ThemedText>
            </Pressable>
          </View>
        ) : null}
      </View>

      {editorKind !== null ? (
        <>
          <View style={styles.customRebuyRow}>
            <View
              style={[
                styles.amountRow,
                styles.amountRowFixed,
                { backgroundColor: theme.background },
              ]}>
              <ThemedText type="default">$</ThemedText>
              <TextInput
                value={editorValue}
                onChangeText={onChangeEditor}
                // decimal-pad has no minus key on iOS - the rebuy editor needs one
                // to enter a correction, but "set total" is always a plain amount.
                keyboardType={
                  editorKind === 'rebuy'
                    ? Platform.select({ ios: 'numbers-and-punctuation', default: 'numeric' })
                    : 'decimal-pad'
                }
                placeholder={editorKind === 'rebuy' ? '0.00 or -0.00' : '0.00'}
                placeholderTextColor={theme.textSecondary}
                autoFocus
                editable={!busy}
                style={[styles.amountInput, { color: theme.text }]}
              />
            </View>
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              onPress={onConfirmEditor}
              style={styles.customConfirm}>
              <ThemedText type="smallBold">
                {busy ? '…' : editorKind === 'rebuy' ? 'Add' : 'Save'}
              </ThemedText>
            </Pressable>
            <Pressable accessibilityRole="button" disabled={busy} onPress={onCancelEditor}>
              <ThemedText type="small" themeColor="textSecondary">
                Cancel
              </ThemedText>
            </Pressable>
          </View>
          {editorKind === 'rebuy' ? (
            <ThemedText type="small" themeColor="textSecondary">
              Use a negative amount to correct a mistake.
            </ThemedText>
          ) : null}
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  content: {
    width: '100%',
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
    padding: Spacing.four,
    gap: Spacing.five,
  },
  section: { gap: Spacing.three },
  sectionTitle: { textTransform: 'uppercase', letterSpacing: 0.5 },
  playerList: { gap: Spacing.two },
  amountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    borderRadius: 12,
    paddingHorizontal: Spacing.three,
  },
  amountInput: {
    flex: 1,
    minHeight: 44,
    fontSize: 16,
  },
  // Bounds an amountRow that sits beside another flexible sibling (a player's
  // name, or the Add/Cancel buttons). Without an explicit width here, the
  // TextInput's flex: 1 two levels up wins the whole row against that sibling's
  // own flex: 1 - Yoga gives the deeply-nested flex all the free space rather
  // than splitting it, which is what was hiding the name on the settle screen.
  amountRowFixed: {
    width: 140,
  },
  addRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: Spacing.three,
    borderRadius: 12,
  },
  dimmed: { opacity: 0.5 },
  playerRow: {
    gap: Spacing.two,
    padding: Spacing.three,
    borderRadius: 12,
  },
  playerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.three,
  },
  settleName: { flex: 1, gap: Spacing.half },
  rebuyButtons: { alignItems: 'flex-end', gap: Spacing.one },
  rebuyButton: {
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.one,
    borderRadius: 8,
  },
  customRebuyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  customConfirm: {
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.one,
  },
  settleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    padding: Spacing.three,
    borderRadius: 12,
  },
  centered: { textAlign: 'center' },
  cancelLink: { alignItems: 'center', paddingVertical: Spacing.two },
  card: { borderRadius: 12, overflow: 'hidden' },
  rowDivider: { borderTopWidth: StyleSheet.hairlineWidth },
  transferRow: { padding: Spacing.three },
  netRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.three,
    padding: Spacing.three,
  },
  netName: { flex: 1 },
  positive: { color: '#12805c', fontWeight: '600' },
  negative: { color: '#d92d20', fontWeight: '600' },
});
