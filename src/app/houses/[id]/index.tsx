import { Redirect, Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';

import { Button } from '@/components/button';
import { Message } from '@/components/message';
import { ScreenLoader } from '@/components/screen-loader';
import { ThemedText } from '@/components/themed-text';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useAuth } from '@/lib/auth';
import { formatGameDate, formatGameTime, formatSignedCents } from '@/lib/format';
import {
  getActiveGame,
  getLeaderboard,
  listPastGames,
  startGame,
  withRanks,
  type LeaderboardRow,
  type PastGame,
} from '@/lib/games';
import { deleteHouse, getHouse, leaveHouse, type House } from '@/lib/houses';

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | {
      status: 'ready';
      house: House;
      leaderboard: LeaderboardRow[];
      pastGames: PastGame[];
      activeGame: { id: string } | null;
    };

/**
 * House view - step 5 of the screen flow: all-time leaderboard on top, past games
 * below, most recent first.
 *
 * Refetches on focus, same as the houses list, so settling a game and coming back
 * here shows the updated leaderboard and the new game in history without either
 * screen reaching into the other.
 */
export default function HouseScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const theme = useTheme();
  const router = useRouter();
  const { session, isRestoring } = useAuth();

  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [refreshing, setRefreshing] = useState(false);
  const [startingGame, setStartingGame] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [leaveError, setLeaveError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const load = useCallback(
    async (mode: 'initial' | 'refresh', isCancelled: () => boolean) => {
      if (!id) return;
      if (mode === 'refresh') setRefreshing(true);

      try {
        const house = await getHouse(id);
        if (isCancelled()) return;

        if (!house) {
          // RLS returns no row for a house you are not a member of, which is
          // indistinguishable from one that does not exist - and should be.
          setState({
            status: 'error',
            message: 'That house does not exist, or you are not a member of it.',
          });
          return;
        }

        const [leaderboard, pastGames, activeGame] = await Promise.all([
          getLeaderboard(house.id),
          listPastGames(house.id),
          getActiveGame(house.id),
        ]);
        if (isCancelled()) return;

        setState({ status: 'ready', house, leaderboard, pastGames, activeGame });
      } catch (cause) {
        if (isCancelled()) return;
        setState({
          status: 'error',
          message: cause instanceof Error ? cause.message : 'Could not load this house.',
        });
      } finally {
        if (mode === 'refresh') setRefreshing(false);
      }
    },
    [id]
  );

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      void load('initial', () => cancelled);
      return () => {
        cancelled = true;
      };
    }, [load])
  );

  if (isRestoring) {
    return <ScreenLoader />;
  }

  if (!session) {
    return <Redirect href="/sign-in" />;
  }

  if (state.status === 'loading') {
    return <ScreenLoader />;
  }

  async function handleStartOrResume() {
    if (state.status !== 'ready') return;

    if (state.activeGame) {
      router.push(`/houses/${state.house.id}/game/${state.activeGame.id}`);
      return;
    }

    setStartingGame(true);
    setStartError(null);
    try {
      const game = await startGame(state.house.id);
      router.push(`/houses/${state.house.id}/game/${game.id}`);
    } catch (cause) {
      setStartError(cause instanceof Error ? cause.message : 'Could not start a game.');
    } finally {
      setStartingGame(false);
    }
  }

  function handleLeaveHouse() {
    if (state.status !== 'ready') return;
    const house = state.house;

    Alert.alert(
      `Leave ${house.name}?`,
      "You'll need the join code to come back, and your past games stay in the house's history.",
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Leave',
          style: 'destructive',
          onPress: async () => {
            setLeaving(true);
            setLeaveError(null);
            try {
              await leaveHouse(house.id, session!.user.id);
              router.replace('/houses');
            } catch (cause) {
              setLeaveError(cause instanceof Error ? cause.message : 'Could not leave the house.');
              setLeaving(false);
            }
          },
        },
      ]
    );
  }

  function handleDeleteHouse() {
    if (state.status !== 'ready') return;
    const house = state.house;

    Alert.alert(
      `Delete ${house.name}?`,
      'This permanently deletes every game and buy-in for everyone in this house, and every ' +
        'member loses access immediately. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            setDeleting(true);
            setDeleteError(null);
            try {
              await deleteHouse(house.id);
              router.replace('/houses');
            } catch (cause) {
              setDeleteError(cause instanceof Error ? cause.message : 'Could not delete the house.');
              setDeleting(false);
            }
          },
        },
      ]
    );
  }

  return (
    <>
      <Stack.Screen options={{ title: state.status === 'ready' ? state.house.name : 'House' }} />
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => void load('refresh', () => false)} />
        }>
        {state.status === 'error' ? (
          <Message tone="error">{state.message}</Message>
        ) : (
          <>
            <View style={styles.section}>
              <ThemedText type="smallBold" themeColor="textSecondary" style={styles.sectionTitle}>
                All-time leaderboard
              </ThemedText>
              {state.leaderboard.length === 0 ? (
                <ThemedText type="small" themeColor="textSecondary">
                  No settled games yet.
                </ThemedText>
              ) : (
                <View style={[styles.card, { backgroundColor: theme.backgroundElement }]}>
                  {withRanks(state.leaderboard).map((row, index) => (
                    <View
                      key={row.user_id}
                      style={[styles.leaderboardRow, index > 0 && styles.rowDivider, { borderColor: theme.backgroundSelected }]}>
                      <ThemedText type="smallBold" themeColor="textSecondary" style={styles.leaderboardRank}>
                        {row.rank})
                      </ThemedText>
                      <View style={styles.leaderboardName}>
                        <ThemedText numberOfLines={1}>{row.display_name}</ThemedText>
                        <ThemedText type="small" themeColor="textSecondary">
                          {row.games_played} {row.games_played === 1 ? 'game' : 'games'}
                        </ThemedText>
                      </View>
                      <ThemedText
                        style={row.net_cents >= 0 ? styles.positive : styles.negative}>
                        {formatSignedCents(row.net_cents)}
                      </ThemedText>
                    </View>
                  ))}
                </View>
              )}
            </View>

            <View style={styles.section}>
              {startError ? <Message tone="error">{startError}</Message> : null}
              <Button
                label={state.activeGame ? 'Resume game' : 'Start game'}
                onPress={handleStartOrResume}
                busy={startingGame}
              />
            </View>

            <View style={styles.section}>
              <ThemedText type="smallBold" themeColor="textSecondary" style={styles.sectionTitle}>
                Past games
              </ThemedText>
              {state.pastGames.length === 0 ? (
                <ThemedText type="small" themeColor="textSecondary">
                  No games yet.
                </ThemedText>
              ) : (
                <View style={[styles.card, { backgroundColor: theme.backgroundElement }]}>
                  {state.pastGames.map((game, index) => {
                    // Null only for a game settled before settled_at existed -
                    // fall back to when it started rather than show nothing.
                    const when = game.settled_at ?? game.created_at;
                    return (
                      <Pressable
                        key={game.id}
                        accessibilityRole="button"
                        accessibilityLabel={`View results for the game on ${formatGameDate(when)} at ${formatGameTime(when)}`}
                        onPress={() => router.push(`/houses/${state.house.id}/game/${game.id}`)}
                        style={({ pressed }) => [
                          styles.pastGameRow,
                          index > 0 && styles.rowDivider,
                          { borderColor: theme.backgroundSelected },
                          pressed && { backgroundColor: theme.backgroundSelected },
                        ]}>
                        <ThemedText type="small">{formatGameDate(when)}</ThemedText>
                        <ThemedText type="small" themeColor="textSecondary">
                          {formatGameTime(when)}
                        </ThemedText>
                      </Pressable>
                    );
                  })}
                </View>
              )}
            </View>

            {state.house.owner_id === session.user.id ? (
              <View style={styles.section}>
                {deleteError ? <Message tone="error">{deleteError}</Message> : null}
                <Button
                  label="Delete house"
                  variant="secondary"
                  onPress={handleDeleteHouse}
                  busy={deleting}
                />
              </View>
            ) : (
              <View style={styles.section}>
                {leaveError ? <Message tone="error">{leaveError}</Message> : null}
                <Button
                  label="Leave house"
                  variant="secondary"
                  onPress={handleLeaveHouse}
                  busy={leaving}
                />
              </View>
            )}
          </>
        )}
      </ScrollView>
    </>
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
  card: { borderRadius: 12, overflow: 'hidden' },
  leaderboardRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.three,
    padding: Spacing.three,
  },
  // Fixed width so two-digit ranks (10) onward) don't shift where names start.
  leaderboardRank: { width: 28 },
  leaderboardName: { flex: 1, gap: Spacing.half },
  rowDivider: { borderTopWidth: StyleSheet.hairlineWidth },
  positive: { color: '#12805c', fontWeight: '600' },
  negative: { color: '#d92d20', fontWeight: '600' },
  pastGameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.three,
    padding: Spacing.three,
  },
});
