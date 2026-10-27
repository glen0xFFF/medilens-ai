import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../theme/theme';

const DETAIL = 'Made-up example. No real label or registry was checked.';

/** Shown on every screen that displays demo scenario data. */
export function DemoBanner() {
  const theme = useTheme();
  const fg = theme.colors.onDemoBanner;
  return (
    <View
      accessible
      accessibilityLabel={`DEMO DATA. ${DETAIL}`}
      style={[styles.banner, { backgroundColor: theme.colors.demoBanner, borderColor: fg }]}
    >
      <Text style={[styles.title, { color: fg, fontSize: theme.font(18) }]}>DEMO DATA</Text>
      <Text style={{ color: fg, fontSize: theme.font(15) }}>{DETAIL}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: { padding: 12, borderRadius: 8, borderWidth: 2, gap: 4 },
  title: { fontWeight: '800', letterSpacing: 1 },
});
