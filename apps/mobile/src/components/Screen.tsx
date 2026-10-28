import { Stack } from 'expo-router';
import type { ReactNode } from 'react';
import { ScrollView, StyleSheet, Text, type TextProps } from 'react-native';
import { useTheme } from '../theme/theme';

/** A scrolling, themed screen body with its header title. */
export function Screen({ title, children }: { title: string; children: ReactNode }) {
  const theme = useTheme();
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.background }}
      contentContainerStyle={styles.content}
    >
      <Stack.Screen options={{ title }} />
      {children}
    </ScrollView>
  );
}

export function Heading({ children, ...rest }: TextProps & { children: ReactNode }) {
  const theme = useTheme();
  return (
    <Text
      accessibilityRole="header"
      {...rest}
      style={[styles.heading, { color: theme.colors.text, fontSize: theme.font(22) }]}
    >
      {children}
    </Text>
  );
}

export function Body({
  children,
  muted = false,
  ...rest
}: TextProps & { children: ReactNode; muted?: boolean }) {
  const theme = useTheme();
  return (
    <Text
      {...rest}
      style={{
        color: muted ? theme.colors.textMuted : theme.colors.text,
        fontSize: theme.font(17),
        lineHeight: theme.font(25),
      }}
    >
      {children}
    </Text>
  );
}

/** An error or status message from the server or the client, read out when it appears. */
export function Notice({ children }: { children: ReactNode }) {
  const theme = useTheme();
  return (
    <Text
      accessibilityLiveRegion="assertive"
      style={[
        styles.notice,
        { color: theme.colors.danger, borderColor: theme.colors.danger, fontSize: theme.font(17) },
      ]}
    >
      {children}
    </Text>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 16, paddingBottom: 48 },
  heading: { fontWeight: '800' },
  notice: { borderWidth: 2, borderRadius: 8, padding: 12, fontWeight: '600' },
});
