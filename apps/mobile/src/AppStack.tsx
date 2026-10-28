import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useTheme } from './theme/theme';

/** The root navigation stack, themed from settings. Each screen sets its own title. */
export function AppStack() {
  const theme = useTheme();
  return (
    <>
      <StatusBar style={theme.scheme === 'dark' ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: theme.colors.surface },
          headerTintColor: theme.colors.text,
          headerTitleStyle: { fontSize: theme.font(20) },
          contentStyle: { backgroundColor: theme.colors.background },
        }}
      />
    </>
  );
}
