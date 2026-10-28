import type { FieldConflict } from '@medilens/contracts';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../theme/theme';
import { FIELD_LABELS, conflictText } from '../ui/text';

/** A field where the label and the registry disagree, both values verbatim. */
export function ConflictRow({ conflict }: { conflict: FieldConflict }) {
  const theme = useTheme();
  const { bg, fg, icon } = theme.statusColors.conflicting;
  const name = FIELD_LABELS[conflict.key];
  const text = conflictText(conflict);
  return (
    <View
      accessible
      accessibilityLabel={`${name}: ${text}`}
      style={[styles.row, { backgroundColor: bg, borderColor: fg }]}
    >
      <View style={styles.header}>
        <Text
          importantForAccessibility="no"
          style={[styles.name, { color: fg, fontSize: theme.font(16) }]}
        >
          {icon}
        </Text>
        <Text style={[styles.name, { color: fg, fontSize: theme.font(16) }]}>{name}</Text>
      </View>
      <Text style={{ color: fg, fontSize: theme.font(18) }}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { borderWidth: 2, borderRadius: 10, padding: 12, gap: 4 },
  header: { flexDirection: 'row', gap: 6 },
  name: { fontWeight: '700' },
});
