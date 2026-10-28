import { fireEvent, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { BigButton } from '../../src/components/BigButton';
import { expectPressablesLabelled, renderWithProviders } from '../helpers/render';

describe('BigButton', () => {
  it('is a labelled button at least 56dp tall', async () => {
    const onPress = jest.fn();
    const view = await renderWithProviders(
      <BigButton
        label="Demo mode"
        onPress={onPress}
        accessibilityHint="Opens the demo scenarios"
      />,
    );
    const button = screen.getByRole('button', { name: 'Demo mode' });
    expect(button.props.accessibilityHint).toBe('Opens the demo scenarios');
    expect(StyleSheet.flatten(button.props.style).minHeight).toBeGreaterThanOrEqual(56);
    expect(screen.getByText('Demo mode')).toBeTruthy();
    await fireEvent.press(button);
    expect(onPress).toHaveBeenCalledTimes(1);
    expectPressablesLabelled(view);
  });

  it('does not fire while disabled and says so', async () => {
    const onPress = jest.fn();
    await renderWithProviders(<BigButton label="Ask" onPress={onPress} disabled />);
    const button = screen.getByRole('button', { name: 'Ask' });
    expect(button.props.accessibilityState).toMatchObject({ disabled: true });
    await fireEvent.press(button);
    expect(onPress).not.toHaveBeenCalled();
  });

  it('reports a selected state', async () => {
    await renderWithProviders(<BigButton label="Large" onPress={() => {}} selected />);
    expect(screen.getByRole('button', { name: 'Large' }).props.accessibilityState).toMatchObject({
      selected: true,
    });
  });
});
