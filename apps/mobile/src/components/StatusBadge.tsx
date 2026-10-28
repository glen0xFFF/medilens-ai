import { StyleSheet, Text, View } from 'react-native';
import { STATUS_LABELS, useTheme, type StatusKey } from '../theme/theme';

export interface StatusBadgeProps {
  status: StatusKey;
  /** FDA advisories exist: the badge takes the amber warning style whatever the status (spec §5.4 rule 11). */
  hasAdvisory?: boolean;
}

/** What a screen reader hears for the badge, and what the result screen announces. */
export function statusAnnouncement(status: StatusKey, hasAdvisory = false): string {
  return `Verification: ${STATUS_LABELS[status]}${hasAdvisory ? ', FDA advisory' : ''}`;
}

/**
 * Verification status as a glyph, a text label and a colour, so it never
 * depends on colour alone.
 */
export function StatusBadge({ status, hasAdvisory = false }: StatusBadgeProps) {
  const theme = useTheme();
  const style = theme.statusColors[status];
  const { bg, fg } = hasAdvisory ? theme.advisory : style;
  return (
    <View
      testID="status-badge"
      accessible
      accessibilityLabel={statusAnnouncement(status, hasAdvisory)}
      style={[styles.badge, { backgroundColor: bg, borderColor: fg }]}
    >
      <View style={styles.row}>
        <Text
          importantForAccessibility="no"
          style={[styles.glyph, { color: fg, fontSize: theme.font(22) }]}
        >
          {style.icon}
        </Text>
        <Text style={[styles.label, { color: fg, fontSize: theme.font(20) }]}>{style.label}</Text>
      </View>
      {hasAdvisory ? (
        <View style={[styles.marker, { borderColor: fg }]}>
          <Text importantForAccessibility="no" style={{ color: fg, fontSize: theme.font(18) }}>
            {theme.advisory.icon}
          </Text>
          <Text style={[styles.label, { color: fg, fontSize: theme.font(18) }]}>
            {theme.advisory.label}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  badge: { borderWidth: 2, borderRadius: 12, padding: 12, gap: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  glyph: { fontWeight: '700' },
  label: { fontWeight: '800', flexShrink: 1 },
  marker: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    borderWidth: 2,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
});
