import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';

import { UserIcon } from '@/components/user-icon';
import { useTheme } from '@/hooks/use-theme';
import { useAuth } from '@/lib/auth';

const SIZE = 26;

/**
 * `headerRight` is a different native slot than `headerLeft` (which
 * HomeBackButton uses) - `height: '100%'` there relied on the back-button
 * wrapper's own vertical centering, which this slot does not appear to provide
 * the same way, leaving the icon sitting low. A direct offset sidesteps needing
 * to know why: negative moves the icon up. Tune this number directly if it
 * needs further adjustment - same idea as HomeBackButton's RIGHT_EDGE_PADDING.
 */
const VERTICAL_OFFSET = -0.00;

/**
 * The header-right icon on every screen after sign-in - the default user icon
 * until someone sets an avatar, after which it shows their actual photo.
 *
 * Reads `profile` straight from AuthProvider rather than fetching its own copy,
 * so a change made on the profile screen (via `refreshProfile`) shows up here -
 * on every other screen - immediately, not just after the next sign-in.
 *
 * Set as the default `headerRight` at the Stack level in _layout.tsx, and
 * explicitly turned off on the profile screen itself.
 */
export function ProfileButton() {
  const router = useRouter();
  const theme = useTheme();
  const { profile } = useAuth();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Your profile"
      onPress={() => router.push('/profile')}
      hitSlop={8}
      style={styles.button}>
      <View style={styles.offset}>
        {profile?.avatar_url ? (
          <Image source={{ uri: profile.avatar_url }} style={styles.avatar} contentFit="cover" />
        ) : (
          <UserIcon color={theme.text} size={SIZE} />
        )}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // Symmetric, deliberately: a one-sided padding here previously pushed the
  // icon visibly to the right (paddingLeft only, no paddingRight).
  button: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  offset: {
    transform: [{ translateY: VERTICAL_OFFSET }],
  },
  avatar: {
    width: SIZE,
    height: SIZE,
    borderRadius: SIZE / 2,
  },
});
