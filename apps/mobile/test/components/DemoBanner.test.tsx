import { screen } from '@testing-library/react-native';
import { DemoBanner } from '../../src/components/DemoBanner';
import { renderWithProviders } from '../helpers/render';

describe('DemoBanner', () => {
  it('says DEMO DATA in text and to a screen reader', async () => {
    await renderWithProviders(<DemoBanner />);
    expect(screen.getByText('DEMO DATA')).toBeTruthy();
    expect(screen.getByLabelText(/^DEMO DATA\. /)).toBeTruthy();
  });
});
