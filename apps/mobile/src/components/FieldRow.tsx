import type { LabelField } from '@medilens/contracts';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../theme/theme';
import { FIELD_LABELS, LEGIBILITY_LABELS, NOT_PRINTED, NOT_READ } from '../ui/text';

/**
 * One label field: name, value as read, a legibility chip and the printed evidence.
 * A clear field with no value is one the reader found nothing printed for: it says
 * so and has no chip, since there is no value whose clarity a chip could describe.
 */
export function FieldRow({ field }: { field: LabelField }) {
  const theme = useTheme();
  const c = theme.colors;
  const name = FIELD_LABELS[field.key];
  const notPrinted = field.value === null && field.legibility === 'clear';
  const value = field.value ?? (notPrinted ? NOT_PRINTED : NOT_READ);
  const chip = notPrinted ? null : LEGIBILITY_LABELS[field.legibility];
  const evidence = field.evidenceText === null ? null : `Printed text: ${field.evidenceText}`;
  const chipStyle =
    field.legibility === 'clear'
      ? { bg: c.surface, fg: c.text }
      : theme.statusColors[field.legibility === 'partial' ? 'partial' : 'unreadable'];

  return (
    <View
      accessible
      accessibilityLabel={`${name}: ${value}.${chip === null ? '' : ` ${chip}.`}${evidence === null ? '' : ` ${evidence}`}`}
      style={[styles.row, { borderColor: c.border, backgroundColor: c.surface }]}
    >
      <View style={styles.header}>
        <Text style={[styles.name, { color: c.text, fontSize: theme.font(16) }]}>{name}</Text>
        {chip === null ? null : (
          <Text
            style={[
              styles.chip,
              {
                color: chipStyle.fg,
                backgroundColor: chipStyle.bg,
                borderColor: chipStyle.fg,
                fontSize: theme.font(14),
              },
            ]}
          >
            {chip}
          </Text>
        )}
      </View>
      <Text style={{ color: c.text, fontSize: theme.font(18) }}>{value}</Text>
      {evidence === null ? null : (
        <Text style={{ color: c.textMuted, fontSize: theme.font(15) }}>{evidence}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { borderWidth: 1, borderRadius: 10, padding: 12, gap: 6 },
  header: { flexDirection: 'row', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' },
  name: { fontWeight: '700', flexShrink: 1 },
  chip: {
    fontWeight: '700',
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 2,
    overflow: 'hidden',
  },
});
