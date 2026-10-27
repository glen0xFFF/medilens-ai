import AsyncStorage from '@react-native-async-storage/async-storage';
import { renderRouter, screen, fireEvent } from 'expo-router/testing-library';
import * as Speech from 'expo-speech';
import { AccessibilityInfo } from 'react-native';
import { ApiError } from '../../src/api/client';
import { SETTINGS_KEY } from '../../src/state/settings';
import { ANSWERS, PRESETS, REFERENCES, RESULTS, SCENARIO_IDS } from '../helpers/fixtures';
import {
  appRoutes,
  expectPressablesLabelled,
  mockClient,
  type MockClient,
} from '../helpers/render';

const speak = Speech.speak as jest.Mock;
let announce: jest.SpyInstance;

beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear();
  // A returning user: the first-run disclaimer has been acknowledged.
  await AsyncStorage.setItem('medilens.disclaimer.v1', 'true');
  announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {});
});

afterEach(() => {
  announce.mockRestore();
  jest.useRealTimers();
});

function clientFor(result = RESULTS.s1, extra: Partial<MockClient> = {}): MockClient {
  return mockClient({ result: jest.fn(() => Promise.resolve(result)), ...extra });
}

async function openResult(client: MockClient, id: string, suffix = '') {
  return renderRouter(appRoutes(client), { initialUrl: `/result/${id}${suffix}` });
}

describe('result screen', () => {
  it('shows DEMO DATA, the status label and the summary verbatim for a demo result', async () => {
    const client = clientFor(RESULTS.s1);
    await openResult(client, RESULTS.s1.id);
    expect(await screen.findByText('Matches FDA registry')).toBeTruthy();
    expect(screen.getAllByText('DEMO DATA').length).toBeGreaterThan(0);
    expect(screen.getByText(RESULTS.s1.explanation.displayText)).toBeTruthy();
    expect(client.result).toHaveBeenCalledWith(RESULTS.s1.id);
  });

  it('announces the verification status to the screen reader', async () => {
    await openResult(clientFor(RESULTS.s1), RESULTS.s1.id);
    await screen.findByText('Matches FDA registry');
    expect(announce).toHaveBeenCalledWith('Verification: Matches FDA registry');
  });

  it('auto-plays the spoken summary when auto speak is on', async () => {
    await openResult(clientFor(RESULTS.s1), RESULTS.s1.id);
    await screen.findByText('Matches FDA registry');
    expect(speak).toHaveBeenCalled();
    expect(speak.mock.calls[0][0]).toBe(RESULTS.s1.explanation.spokenChunks[0]);
  });

  it('does not auto-play when auto speak is off, but still announces', async () => {
    await AsyncStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({ speechRate: 1, highContrast: false, textScale: 1, autoSpeak: false }),
    );
    await openResult(clientFor(RESULTS.s1), RESULTS.s1.id);
    await screen.findByText('Matches FDA registry');
    expect(speak).not.toHaveBeenCalled();
    expect(announce).toHaveBeenCalledWith('Verification: Matches FDA registry');
  });

  it('lists the s4 strength conflict as "<label> on label, <registry> in registry"', async () => {
    await openResult(clientFor(RESULTS.s4), RESULTS.s4.id);
    expect(await screen.findByText('Does not match registry')).toBeTruthy();
    const c = RESULTS.s4.match.conflicting[0]!;
    // The server's demo record gives the registry side as "250 mg Tablet".
    expect(
      screen.getByText(`${c.labelValue} on label, ${c.referenceValue} in registry`),
    ).toBeTruthy();
    expect(screen.getByText('500 mg on label, 250 mg Tablet in registry')).toBeTruthy();
  });

  it('shows "Label unreadable" for a photo that failed the quality check', async () => {
    await openResult(clientFor(RESULTS.s2), RESULTS.s2.id);
    expect(await screen.findByText('Label unreadable')).toBeTruthy();
    expect(announce).toHaveBeenCalledWith('Verification: Label unreadable');
  });

  it.each([
    ['s3', 'Several possible matches'],
    ['s5', 'No registry match'],
    ['s6', 'Not checked'],
    ['s8', 'Registry check unavailable'],
  ] as const)('shows the %s status label', async (key, label) => {
    await openResult(clientFor(RESULTS[key]), RESULTS[key].id);
    expect(await screen.findByText(label)).toBeTruthy();
    expect(screen.getByText(RESULTS[key].explanation.displayText)).toBeTruthy();
  });

  it('shows the server safety notices verbatim', async () => {
    await openResult(clientFor(RESULTS.s6), RESULTS.s6.id);
    await screen.findByText('Not checked');
    for (const notice of RESULTS.s6.explanation.safetyNotices) {
      expect(screen.getByText(notice)).toBeTruthy();
    }
  });

  it('labels every pressable as a button', async () => {
    const view = await openResult(clientFor(RESULTS.s4), RESULTS.s4.id);
    await screen.findByText('Does not match registry');
    expectPressablesLabelled(view);
  });

  it('shows the server message when the result cannot be loaded', async () => {
    const client = mockClient({
      result: jest.fn(() => Promise.reject(new ApiError('NOT_FOUND', 'That result has expired.'))),
    });
    await openResult(client, 'gone');
    expect(await screen.findByText('That result has expired.')).toBeTruthy();
  });

  it('opens the label fields screen', async () => {
    await openResult(clientFor(RESULTS.s1), RESULTS.s1.id);
    await screen.findByText('Matches FDA registry');
    await fireEvent.press(screen.getByRole('button', { name: 'Label fields' }));
    expect(screen).toHavePathname(`/result/${RESULTS.s1.id}/fields`);
  });
});

describe('label fields screen', () => {
  it('shows each field with its legibility chip and evidence', async () => {
    const view = await openResult(clientFor(RESULTS.s3), RESULTS.s3.id, '/fields');
    expect(await screen.findByText('Unclear')).toBeTruthy();
    expect(screen.getByText('Printed text: Paracel')).toBeTruthy();
    expect(screen.getByText('Registration number')).toBeTruthy();
    expect(screen.getByText('Unreadable')).toBeTruthy();
    expect(screen.getAllByText('DEMO DATA').length).toBeGreaterThan(0);
    expectPressablesLabelled(view);
  });

  it('says no fields were read when the label is null', async () => {
    await openResult(clientFor(RESULTS.s2), RESULTS.s2.id, '/fields');
    expect(await screen.findByText('No label fields were read from this photo.')).toBeTruthy();
  });

  // Final review I2 (mobile): a loose pill, a non-label photo or an unreadable
  // label never shows field values, even if a result carries some (a model
  // that copied a tablet imprint, or an older server that kept them).
  const withValues = (
    pipelineState: 'loose_pill' | 'not_a_label' | 'label_unreadable',
    imageKind: 'loose_pill' | 'not_medicine' | 'unreadable',
  ) => ({
    ...RESULTS.s1,
    id: `live-${imageKind}`,
    isDemo: false,
    pipelineState,
    label: { ...RESULTS.s1.label!, imageKind },
  });

  it.each([
    [
      'loose_pill',
      withValues('loose_pill', 'loose_pill'),
      'This looks like a loose tablet, not a label, so no label fields are shown.',
    ],
    [
      'not_medicine',
      withValues('not_a_label', 'not_medicine'),
      'This photo does not look like a medicine label, so no label fields are shown.',
    ],
    [
      'unreadable',
      withValues('label_unreadable', 'unreadable'),
      'No label fields were read from this photo.',
    ],
  ] as const)('shows no field values for a %s result', async (_kind, result, message) => {
    await openResult(clientFor(result), result.id, '/fields');
    expect(await screen.findByText(message)).toBeTruthy();
    expect(screen.queryByText('Paracelin 500')).toBeNull();
    expect(screen.queryByText('Brand name')).toBeNull();
    expect(screen.queryByText('Clear')).toBeNull();
    expect(screen.queryByText(/Printed text/)).toBeNull();
  });

  it('s6 loose pill lists no parts as unclear and never calls the tablet a pack', async () => {
    const view = await openResult(clientFor(RESULTS.s6), RESULTS.s6.id, '/fields');
    expect(
      await screen.findByText(
        'This looks like a loose tablet, not a label, so no label fields are shown.',
      ),
    ).toBeTruthy();
    expect(screen.queryByText('Unreadable')).toBeNull();
    expect(screen.queryByText('Not read')).toBeNull();
    expect(screen.queryByText(/pack/i)).toBeNull();
    expect(screen.getAllByText('DEMO DATA').length).toBeGreaterThan(0);
    expectPressablesLabelled(view);
  });
});

describe('verification and sources screen', () => {
  it('labels registry expiry as the registration certificate, never product expiry', async () => {
    const client = clientFor(RESULTS.s1, {
      references: jest.fn(() => Promise.resolve(REFERENCES.s1)),
    });
    const view = await openResult(client, RESULTS.s1.id, '/sources');
    expect(
      await screen.findByText('Registration certificate valid until: 2030-12-31'),
    ).toBeTruthy();
    // The only other "expiry" text is the server's own limitation, shown verbatim.
    const expiryTexts = screen
      .queryAllByText(/expir/i)
      .map((node) => [node.props.children].flat().join(''));
    expect(expiryTexts.sort()).toEqual(
      ["Registration expiry is not the product's expiry date."].sort(),
    );
    expect(client.references).toHaveBeenCalledWith(RESULTS.s1.id);
    expect(screen.getByText('Registration number: DR-XY900001')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open source page for DR-XY900001' })).toBeTruthy();
    for (const l of REFERENCES.s1.limitations) expect(screen.getByText(l)).toBeTruthy();
    expect(screen.getByText(/^Checked: /)).toBeTruthy();
    expect(screen.getAllByText('DEMO DATA').length).toBeGreaterThan(0);
    expectPressablesLabelled(view);
  });

  it('lists matched and conflicting fields', async () => {
    const client = clientFor(RESULTS.s4, {
      references: jest.fn(() => Promise.resolve(REFERENCES.s4)),
    });
    await openResult(client, RESULTS.s4.id, '/sources');
    expect(await screen.findByText('500 mg on label, 250 mg Tablet in registry')).toBeTruthy();
    expect(
      screen.getByText('Matched: Registration number, Brand name, Generic name, Dosage form'),
    ).toBeTruthy();
  });

  it('falls back to the stored result when the references call fails', async () => {
    const client = clientFor(RESULTS.s1, {
      references: jest.fn(() => Promise.reject(new ApiError('NETWORK', 'No connection.'))),
    });
    await openResult(client, RESULTS.s1.id, '/sources');
    expect(await screen.findByText('No connection.')).toBeTruthy();
    expect(screen.getByText('Registration certificate valid until: 2030-12-31')).toBeTruthy();
  });
});

describe('ask screen', () => {
  it('offers every server preset as a button and answers it', async () => {
    const client = clientFor(RESULTS.s1, {
      explain: jest.fn(() => Promise.resolve(ANSWERS.s1Strength)),
    });
    const view = await openResult(client, RESULTS.s1.id, '/ask');
    expect(await screen.findByRole('button', { name: PRESETS[0]! })).toBeTruthy();
    for (const p of PRESETS) expect(screen.getByRole('button', { name: p })).toBeTruthy();
    expectPressablesLabelled(view);
    await fireEvent.press(screen.getByRole('button', { name: 'What strength is printed here?' }));
    expect(client.explain).toHaveBeenCalledWith(RESULTS.s1.id, 'What strength is printed here?');
    expect(await screen.findByText(ANSWERS.s1Strength.text)).toBeTruthy();
  });

  it('shows the refusal text for a refused typed question', async () => {
    const client = clientFor(RESULTS.s7, {
      explain: jest.fn(() => Promise.resolve(ANSWERS.s7Refused)),
    });
    await openResult(client, RESULTS.s7.id, '/ask');
    await screen.findByRole('button', { name: PRESETS[0]! });
    await fireEvent.changeText(
      screen.getByLabelText('Type a question about this label'),
      'How many should I take for my headache?',
    );
    await fireEvent.press(screen.getByRole('button', { name: 'Ask' }));
    expect(client.explain).toHaveBeenCalledWith(
      RESULTS.s7.id,
      'How many should I take for my headache?',
    );
    expect(await screen.findByText(ANSWERS.s7Refused.text)).toBeTruthy();
    expect(announce).toHaveBeenCalledWith(ANSWERS.s7Refused.text);
  });

  it('shows a distinct safety notice next to an unclear answer', async () => {
    const unclear = {
      status: 'unclear' as const,
      text: 'That part of the label is unclear.',
      spokenChunks: ['That part of the label is unclear.'],
      citedFields: [],
      safetyNotice: 'Confirm with your pharmacist or doctor.',
    };
    const client = clientFor(RESULTS.s3, { explain: jest.fn(() => Promise.resolve(unclear)) });
    await openResult(client, RESULTS.s3.id, '/ask');
    await fireEvent.press(await screen.findByRole('button', { name: 'Which parts were unclear?' }));
    expect(await screen.findByText(unclear.text)).toBeTruthy();
    expect(screen.getByText(unclear.safetyNotice)).toBeTruthy();
  });

  it('keeps the Ask button disabled until a question is typed', async () => {
    const client = clientFor(RESULTS.s1, { explain: jest.fn() });
    await openResult(client, RESULTS.s1.id, '/ask');
    await screen.findByRole('button', { name: PRESETS[0]! });
    await fireEvent.press(screen.getByRole('button', { name: 'Ask' }));
    expect(client.explain).not.toHaveBeenCalled();
  });

  it('shows the server message when asking fails', async () => {
    const client = clientFor(RESULTS.s1, {
      explain: jest.fn(() =>
        Promise.reject(new ApiError('RATE_LIMITED', 'Too many requests. Please wait a minute.')),
      ),
    });
    await openResult(client, RESULTS.s1.id, '/ask');
    await fireEvent.press(await screen.findByRole('button', { name: PRESETS[0]! }));
    expect(await screen.findByText('Too many requests. Please wait a minute.')).toBeTruthy();
  });
});

describe('demo flow', () => {
  it('opens a scenario result from the store without refetching it', async () => {
    const client = mockClient({ scenario: jest.fn(() => Promise.resolve(RESULTS.s4)) });
    await renderRouter(appRoutes(client), { initialUrl: '/demo' });
    const title = 'DEMO DATA: Label strength differs from the registry';
    await fireEvent.press(await screen.findByRole('button', { name: title }));
    expect(client.scenario).toHaveBeenCalledWith(SCENARIO_IDS.s4);
    expect(await screen.findByText('500 mg on label, 250 mg Tablet in registry')).toBeTruthy();
    expect(screen).toHavePathname(`/result/${RESULTS.s4.id}`);
    expect(client.result).not.toHaveBeenCalled();
  });
});
