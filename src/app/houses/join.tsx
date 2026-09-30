import { Redirect, useRouter } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, TextInput, View } from 'react-native';

import { Button } from '@/components/button';
import { Message } from '@/components/message';
import { ScreenLoader } from '@/components/screen-loader';
import { ThemedText } from '@/components/themed-text';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useAuth } from '@/lib/auth';
import { joinHouse } from '@/lib/houses';

/** Join codes are six characters from an alphabet with no I, L, O, 0 or 1. */
const CODE_LENGTH = 6;

export default function JoinHouseScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { session, isRestoring } = useAuth();

  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (isRestoring) {
    return <ScreenLoader />;
  }

  if (!session) {
    return <Redirect href="/sign-in" />;
  }

  async function submit() {
    setBusy(true);
    setError(null);

    try {
      await joinHouse(code);
      // The list refetches on focus, so it will already include this house.
      router.replace('/houses');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not join that house.');
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <View style={styles.content}>
          <View style={styles.header}>
            <ThemedText type="subtitle">Join a house</ThemedText>
            <ThemedText type="small" themeColor="textSecondary">
              Ask whoever started the house for its six-character code.
            </ThemedText>
          </View>

          <View style={styles.form}>
            <View style={styles.field}>
              <ThemedText type="smallBold">Join code</ThemedText>
              <TextInput
                value={code}
                // Codes are stored uppercase; fold as they type so the field matches
                // what they were given, however they type it.
                onChangeText={(next) => setCode(next.toUpperCase().replace(/\s/g, ''))}
                placeholder="ABC234"
                placeholderTextColor={theme.textSecondary}
                autoCapitalize="characters"
                autoCorrect={false}
                autoComplete="off"
                maxLength={CODE_LENGTH}
                editable={!busy}
                returnKeyType="go"
                onSubmitEditing={submit}
                style={[
                  styles.input,
                  { color: theme.text, backgroundColor: theme.backgroundElement },
                ]}
              />
            </View>

            {error ? <Message tone="error">{error}</Message> : null}

            <Button
              label="Join house"
              onPress={submit}
              busy={busy}
              disabled={code.length < CODE_LENGTH}
            />
          </View>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  scroll: { flexGrow: 1, padding: Spacing.four },
  content: {
    width: '100%',
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
    gap: Spacing.five,
  },
  header: { gap: Spacing.two },
  form: { gap: Spacing.three },
  field: { gap: Spacing.two },
  input: {
    minHeight: 56,
    borderRadius: 12,
    paddingHorizontal: Spacing.three,
    fontSize: 24,
    fontWeight: '700',
    letterSpacing: 6,
    textAlign: 'center',
  },
});
