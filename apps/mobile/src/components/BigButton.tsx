import { Pressable, StyleSheet, Text } from 'react-native';
import { useTheme } from '../theme/theme';

/** Primary buttons are at least this tall (dp); above the 48dp platform minimum. */
export const BIG_BUTTON_MIN_HEIGHT = 56;

export interface BigButtonProps {
  label: string;
  onPress(): void;
  accessibilityHint?: string;
  /** What a screen reader says, when it should differ from the visible label. */
  accessibilityLabel?: string;
  disabled?: boolean;
  /** For toggles and choice groups: announced as selected and drawn filled. */
  selected?: boolean;
  /** "secondary" draws an outlined button for less important actions. */
  variant?: 'primary' | 'secondary';
}

export function BigButton({
  label,
  onPress,
  accessibilityHint,
  accessibilityLabel,
  disabled = false,
  selected,
  variant = 'primary',
}: BigButtonProps) {
  const theme = useTheme();
  const c = theme.colors;
  const filled = variant === 'primary' || selected === true;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled, ...(selected === undefined ? {} : { selected }) }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: filled ? c.primary : c.surface,
          borderColor: filled ? c.primary : c.border,
          opacity: disabled ? 0.5 : pressed ? 0.8 : 1,
        },
      ]}
    >
      <Text
        style={[styles.label, { color: filled ? c.onPrimary : c.text, fontSize: theme.font(18) }]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: BIG_BUTTON_MIN_HEIGHT,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 2,
    justifyContent: 'center',
    alignItems: 'center',
  },
  label: { fontWeight: '700', textAlign: 'center' },
});
