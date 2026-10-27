import { act, fireEvent, screen } from '@testing-library/react-native';
import * as Speech from 'expo-speech';
import { SpeechControls } from '../../src/components/SpeechControls';
import {
  Providers,
  expectPressablesLabelled,
  mockClient,
  renderWithProviders,
} from '../helpers/render';

const speak = Speech.speak as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('SpeechControls', () => {
  it('offers labelled play, pause, repeat and stop buttons', async () => {
    const view = await renderWithProviders(<SpeechControls chunks={['One.', 'Two.']} />);
    for (const name of ['Play', 'Pause', 'Repeat', 'Stop']) {
      expect(screen.getByRole('button', { name })).toBeTruthy();
    }
    expectPressablesLabelled(view);
  });

  it('does not speak until asked', async () => {
    await renderWithProviders(<SpeechControls chunks={['One.', 'Two.']} />);
    expect(speak).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByRole('button', { name: 'Play' }));
    expect(speak).toHaveBeenCalledTimes(1);
    expect(speak.mock.calls[0][0]).toBe('One.');
  });

  it('starts speaking by itself when autoPlay is on', async () => {
    await renderWithProviders(<SpeechControls chunks={['One.', 'Two.']} autoPlay />);
    expect(speak).toHaveBeenCalledTimes(1);
    expect(speak.mock.calls[0][0]).toBe('One.');
  });

  it('pause turns the play button into resume', async () => {
    await renderWithProviders(<SpeechControls chunks={['One.', 'Two.']} autoPlay />);
    await fireEvent.press(screen.getByRole('button', { name: 'Pause' }));
    expect(screen.getByRole('button', { name: 'Resume' })).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Resume' }));
    expect(speak).toHaveBeenCalledTimes(2);
    expect(speak.mock.calls[1][0]).toBe('One.');
  });

  it('stops speaking when its screen is no longer active', async () => {
    const view = await renderWithProviders(<SpeechControls chunks={['One.', 'Two.']} autoPlay />);
    expect(speak).toHaveBeenCalledTimes(1);
    (Speech.stop as jest.Mock).mockClear();
    await view.rerender(
      <Providers client={mockClient()}>
        <SpeechControls chunks={['One.', 'Two.']} autoPlay active={false} />
      </Providers>,
    );
    expect(Speech.stop).toHaveBeenCalled();
    expect(screen.getByText('Not reading')).toBeTruthy();
  });

  it('stops speaking when unmounted', async () => {
    const view = await renderWithProviders(<SpeechControls chunks={['One.']} autoPlay />);
    await act(async () => view.unmount());
    expect(Speech.stop).toHaveBeenCalled();
  });
});
