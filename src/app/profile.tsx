import { Image } from 'expo-image';
import { Redirect, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';

import { Button } from '@/components/button';
import { Message } from '@/components/message';
import { ScreenLoader } from '@/components/screen-loader';
import { ThemedText } from '@/components/themed-text';
import { UserIcon } from '@/components/user-icon';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useAuth } from '@/lib/auth';
import {
  changePassword,
  getProfile,
  pickAndUploadAvatar,
  updateDisplayName,
  type Profile,
} from '@/lib/profile';
import { supabase } from '@/lib/supabase';

const AVATAR_SIZE = 96;

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; profile: Profile };

/**
 * The signed-in user's own account: name (editable), avatar (tap to change),
 * email (read-only - changing it needs its own confirmation-email flow, not
 * built here), change password, and sign out.
 *
 * Fetches its own copy of the profile rather than trusting AuthProvider's
 * `profile` directly, matching every other screen's own load/error state - that
 * context copy exists to feed the header button quickly everywhere, not to be
 * this screen's source of truth. `refreshProfile()` is still called after a
 * successful name or avatar change, so the header button (and every other
 * screen) picks it up immediately rather than after the next sign-in.
 */
export default function ProfileScreen() {
  const theme = useTheme();
  const { session, isRestoring, refreshProfile } = useAuth();

  const [state, setState] = useState<LoadState>({ status: 'loading' });

  const [nameInput, setNameInput] = useState('');
  const [savingName, setSavingName] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);

  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);

  const [newPassword, setNewPassword] = useState('');
  const [changingPassword, setChangingPassword] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordNotice, setPasswordNotice] = useState<string | null>(null);

  const [signingOut, setSigningOut] = useState(false);

  const load = useCallback(
    async (isCancelled: () => boolean) => {
      if (!session) return;
      try {
        const profile = await getProfile(session.user.id);
        if (isCancelled()) return;
        if (!profile) {
          setState({ status: 'error', message: 'Could not find your profile.' });
          return;
        }
        setState({ status: 'ready', profile });
        setNameInput(profile.display_name);
      } catch (cause) {
        if (isCancelled()) return;
        setState({
          status: 'error',
          message: cause instanceof Error ? cause.message : 'Could not load your profile.',
        });
      }
    },
    [session]
  );

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      void load(() => cancelled);
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

  if (state.status === 'error') {
    return (
      <View style={styles.content}>
        <Message tone="error">{state.message}</Message>
      </View>
    );
  }

  const { profile } = state;

  async function handleChangeAvatar() {
    setUploadingAvatar(true);
    setAvatarError(null);
    try {
      const avatarUrl = await pickAndUploadAvatar(session!.user.id);
      if (avatarUrl) {
        setState({ status: 'ready', profile: { ...profile, avatar_url: avatarUrl } });
        await refreshProfile();
      }
    } catch (cause) {
      setAvatarError(cause instanceof Error ? cause.message : 'Could not update your photo.');
    } finally {
      setUploadingAvatar(false);
    }
  }

  async function handleSaveName() {
    const trimmed = nameInput.trim();
    if (!trimmed) {
      setNameError('Enter your name.');
      return;
    }

    setSavingName(true);
    setNameError(null);
    try {
      await updateDisplayName(session!.user.id, trimmed);
      setState({ status: 'ready', profile: { ...profile, display_name: trimmed } });
      await refreshProfile();
    } catch (cause) {
      setNameError(cause instanceof Error ? cause.message : 'Could not update your name.');
    } finally {
      setSavingName(false);
    }
  }

  async function handleChangePassword() {
    if (newPassword.length < 6) {
      setPasswordError('Password must be at least 6 characters.');
      return;
    }

    setChangingPassword(true);
    setPasswordError(null);
    setPasswordNotice(null);
    try {
      await changePassword(newPassword);
      setNewPassword('');
      setPasswordNotice('Your password has been updated.');
    } catch (cause) {
      setPasswordError(cause instanceof Error ? cause.message : 'Could not update your password.');
    } finally {
      setChangingPassword(false);
    }
  }

  async function handleSignOut() {
    setSigningOut(true);
    // No navigation call - session becomes null, this screen's own guard above
    // redirects, the same way every other screen in this app signs out.
    await supabase.auth.signOut();
    setSigningOut(false);
  }

  return (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.avatarSection}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Change your profile picture"
            onPress={handleChangeAvatar}
            disabled={uploadingAvatar}
            style={[styles.avatarWrapper, { backgroundColor: theme.backgroundElement }]}>
            {profile.avatar_url ? (
              <Image source={{ uri: profile.avatar_url }} style={styles.avatarImage} contentFit="cover" />
            ) : (
              <UserIcon color={theme.textSecondary} size={AVATAR_SIZE * 0.5} />
            )}
          </Pressable>
          <ThemedText type="small" themeColor="textSecondary">
            {uploadingAvatar ? 'Uploading…' : 'Tap to change photo'}
          </ThemedText>
          {avatarError ? <Message tone="error">{avatarError}</Message> : null}
        </View>

        <View style={styles.section}>
          <ThemedText type="smallBold" themeColor="textSecondary" style={styles.sectionTitle}>
            Name
          </ThemedText>
          <TextInput
            value={nameInput}
            onChangeText={setNameInput}
            placeholder="Your name"
            placeholderTextColor={theme.textSecondary}
            autoCapitalize="words"
            autoCorrect={false}
            maxLength={60}
            editable={!savingName}
            style={[styles.input, { color: theme.text, backgroundColor: theme.backgroundElement }]}
          />
          {nameError ? <Message tone="error">{nameError}</Message> : null}
          <Button
            label="Save name"
            onPress={handleSaveName}
            busy={savingName}
            disabled={nameInput.trim() === profile.display_name}
          />
        </View>

        <View style={styles.section}>
          <ThemedText type="smallBold" themeColor="textSecondary" style={styles.sectionTitle}>
            Email
          </ThemedText>
          <ThemedText>{profile.email}</ThemedText>
        </View>

        <View style={styles.section}>
          <ThemedText type="smallBold" themeColor="textSecondary" style={styles.sectionTitle}>
            Change password
          </ThemedText>
          <TextInput
            value={newPassword}
            onChangeText={setNewPassword}
            placeholder="New password"
            placeholderTextColor={theme.textSecondary}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            textContentType="newPassword"
            autoComplete="new-password"
            editable={!changingPassword}
            onSubmitEditing={handleChangePassword}
            returnKeyType="go"
            style={[styles.input, { color: theme.text, backgroundColor: theme.backgroundElement }]}
          />
          {passwordError ? <Message tone="error">{passwordError}</Message> : null}
          {passwordNotice ? (
            <ThemedText type="small" themeColor="textSecondary">
              {passwordNotice}
            </ThemedText>
          ) : null}
          <Button label="Update password" onPress={handleChangePassword} busy={changingPassword} />
        </View>

        <View style={styles.section}>
          <Button label="Sign out" variant="secondary" onPress={handleSignOut} busy={signingOut} />
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: {
    width: '100%',
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
    padding: Spacing.four,
    gap: Spacing.five,
  },
  avatarSection: { alignItems: 'center', gap: Spacing.two },
  avatarWrapper: {
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    borderRadius: AVATAR_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  avatarImage: { width: AVATAR_SIZE, height: AVATAR_SIZE },
  section: { gap: Spacing.three },
  sectionTitle: { textTransform: 'uppercase', letterSpacing: 0.5 },
  input: {
    minHeight: 48,
    borderRadius: 12,
    paddingHorizontal: Spacing.three,
    fontSize: 16,
  },
});
