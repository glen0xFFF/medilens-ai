import { screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { StatusBadge } from '../../src/components/StatusBadge';
import { STATUS_KEYS, getTheme, type StatusKey } from '../../src/theme/theme';
import { renderWithProviders } from '../helpers/render';

const EXPECTED: Record<StatusKey, string> = {
  verified: 'Matches FDA registry',
  partial: 'Partly matches',
  conflicting: 'Does not match registry',
  ambiguous: 'Several possible matches',
  no_match: 'No registry match',
  unavailable: 'Registry check unavailable',
  not_attempted: 'Not checked',
  unreadable: 'Label unreadable',
};

function badgeBackground(): unknown {
  return StyleSheet.flatten(screen.getByTestId('status-badge').props.style).backgroundColor;
}

describe('StatusBadge', () => {
  it('covers the 7 match statuses plus unreadable', () => {
    expect([...STATUS_KEYS].sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it.each(STATUS_KEYS)('shows a text label for %s and announces it as Verification', async (s) => {
    await renderWithProviders(<StatusBadge status={s} />);
    expect(screen.getByText(EXPECTED[s])).toBeTruthy();
    expect(screen.getByLabelText(`Verification: ${EXPECTED[s]}`)).toBeTruthy();
    expect(screen.queryByText('FDA advisory')).toBeNull();
  });

  it('uses a distinct label per status', () => {
    expect(new Set(Object.values(EXPECTED)).size).toBe(8);
  });

  it('marks an FDA advisory and drops the plain green style on verified', async () => {
    await renderWithProviders(<StatusBadge status="verified" hasAdvisory />);
    expect(screen.getByText('FDA advisory')).toBeTruthy();
    expect(screen.getByText('Matches FDA registry')).toBeTruthy();
    expect(screen.getByLabelText('Verification: Matches FDA registry, FDA advisory')).toBeTruthy();
    const theme = getTheme(false, 'light');
    expect(badgeBackground()).not.toBe(theme.statusColors.verified.bg);
    expect(badgeBackground()).toBe(theme.advisory.bg);
  });

  it.each(STATUS_KEYS)('shows the advisory marker with %s too', async (s) => {
    await renderWithProviders(<StatusBadge status={s} hasAdvisory />);
    expect(screen.getByText('FDA advisory')).toBeTruthy();
    expect(badgeBackground()).toBe(getTheme(false, 'light').advisory.bg);
  });

  it('uses the status colour when there is no advisory', async () => {
    await renderWithProviders(<StatusBadge status="verified" />);
    expect(badgeBackground()).toBe(getTheme(false, 'light').statusColors.verified.bg);
  });
});
