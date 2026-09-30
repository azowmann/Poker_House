import { Redirect, useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button } from '@/components/button';
import { Message } from '@/components/message';
import { ScreenLoader } from '@/components/screen-loader';
import { ThemedText } from '@/components/themed-text';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useAuth } from '@/lib/auth';
import { listHouses, type House } from '@/lib/houses';

/**
 * Step 3 of the screen flow: the houses a player belongs to.
 *
 * Refetches on focus rather than keeping a cache, so coming back from "start" or
 * "join" always shows the new house without either of those screens having to
 * reach in and update this one.
 */
export default function HousesScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { session, isRestoring } = useAuth();
  const userId = session?.user.id;

  const [houses, setHouses] = useState<House[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(
    async (mode: 'initial' | 'refresh', isCancelled: () => boolean) => {
      if (!userId) return;
      if (mode === 'refresh') setRefreshing(true);

      try {
        const next = await listHouses(userId);
        if (isCancelled()) return;
        setHouses(next);
        setError(null);
      } catch (cause) {
        if (isCancelled()) return;
        setError(cause instanceof Error ? cause.message : 'Could not load your houses.');
      } finally {
        if (mode === 'refresh') setRefreshing(false);
      }
    },
    [userId]
  );

  useFocusEffect(
    useCallback(() => {
      // Navigating away mid-request must not let a stale response overwrite what
      // the next screen's fetch already put there.
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

  const isLoading = houses === null && !error;

  return (
    <SafeAreaView
      edges={['bottom']}
      style={[styles.safeArea, { backgroundColor: theme.background }]}>
      <View style={styles.content}>
        <FlatList
          data={houses ?? []}
          keyExtractor={(house) => house.id}
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={() => void load('refresh', () => false)} />
          }
          ListHeaderComponent={
            error ? (
              <View style={styles.headerSlot}>
                <Message tone="error">{error}</Message>
              </View>
            ) : null
          }
          ListEmptyComponent={
            isLoading ? (
              <View style={styles.placeholder}>
                <ActivityIndicator />
              </View>
            ) : error ? null : (
              <View style={styles.placeholder}>
                <ThemedText style={styles.emptyTitle}>No houses yet</ThemedText>
                <ThemedText type="small" themeColor="textSecondary">
                  Start or join one.
                </ThemedText>
              </View>
            )
          }
          renderItem={({ item }) => (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Open ${item.name}`}
              onPress={() => router.push(`/houses/${item.id}`)}
              style={({ pressed }) => [
                styles.row,
                { backgroundColor: pressed ? theme.backgroundSelected : theme.backgroundElement },
              ]}>
              <ThemedText style={styles.rowTitle}>{item.name}</ThemedText>
              {item.owner_id === userId ? (
                <ThemedText type="small" themeColor="textSecondary">
                  Join code {item.join_code}
                </ThemedText>
              ) : null}
            </Pressable>
          )}
        />

        <View style={styles.footer}>
          <Button label="Start a house" onPress={() => router.push('/houses/new')} />
          <Button
            label="Join a house"
            variant="secondary"
            onPress={() => router.push('/houses/join')}
          />
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1 },
  content: {
    flex: 1,
    width: '100%',
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
    paddingHorizontal: Spacing.four,
    paddingBottom: Spacing.four,
  },
  list: { flexGrow: 1, gap: Spacing.two, paddingVertical: Spacing.three },
  headerSlot: { paddingBottom: Spacing.three },
  placeholder: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.two,
    paddingVertical: Spacing.six,
  },
  emptyTitle: { fontWeight: '600' },
  row: {
    gap: Spacing.one,
    padding: Spacing.three,
    borderRadius: 12,
  },
  rowTitle: { fontWeight: '600' },
  footer: { gap: Spacing.three, paddingTop: Spacing.three },
});
