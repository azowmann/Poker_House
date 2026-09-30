import { StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

type MessageProps = {
  tone?: 'error' | 'info';
  title?: string;
  children: string;
};

/** A short block of feedback under a form - an error, or something to note. */
export function Message({ tone = 'info', title, children }: MessageProps) {
  const theme = useTheme();
  const isError = tone === 'error';

  return (
    <View
      accessibilityRole="alert"
      accessibilityLiveRegion={isError ? 'assertive' : 'polite'}
      style={[styles.container, { backgroundColor: theme.backgroundElement }]}>
      {title ? <ThemedText type="smallBold">{title}</ThemedText> : null}
      <ThemedText
        type="small"
        themeColor={isError ? undefined : 'textSecondary'}
        style={isError ? styles.errorText : undefined}>
        {children}
      </ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: Spacing.two,
    padding: Spacing.three,
    borderRadius: 12,
  },
  errorText: {
    color: '#d92d20',
  },
});
