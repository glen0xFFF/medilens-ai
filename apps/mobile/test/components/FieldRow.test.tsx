import { FieldKeySchema, type LabelField } from '@medilens/contracts';
import { screen } from '@testing-library/react-native';
import { ConflictRow } from '../../src/components/ConflictRow';
import { FieldRow } from '../../src/components/FieldRow';
import { FIELD_LABELS, conflictText } from '../../src/ui/text';
import { renderWithProviders } from '../helpers/render';

function field(over: Partial<LabelField>): LabelField {
  return {
    key: 'brandName',
    value: 'Paracel',
    legibility: 'clear',
    evidenceText: 'Paracel',
    imageIndex: 0,
    notes: null,
    ...over,
  };
}

describe('FIELD_LABELS', () => {
  it('names every field key in English', () => {
    for (const key of FieldKeySchema.options) {
      expect(FIELD_LABELS[key]).toMatch(/^[A-Z][a-z ]+$/i);
    }
    expect(FIELD_LABELS.expiryDate).toBe('Expiry date on pack');
    expect(FIELD_LABELS.registrationNumber).toBe('Registration number');
  });
});

describe('FieldRow', () => {
  it('shows an "Unclear" chip and the evidence text for a partial field', async () => {
    await renderWithProviders(
      <FieldRow
        field={field({ legibility: 'partial', value: 'Paracel', evidenceText: 'Parace1' })}
      />,
    );
    expect(screen.getByText('Brand name')).toBeTruthy();
    expect(screen.getByText('Unclear')).toBeTruthy();
    expect(screen.getByText('Paracel')).toBeTruthy();
    expect(screen.getByText('Printed text: Parace1')).toBeTruthy();
  });

  it('shows "Clear" for a clear field', async () => {
    await renderWithProviders(
      <FieldRow field={field({ key: 'strength', value: '500 mg', evidenceText: '500 mg' })} />,
    );
    expect(screen.getByText('Strength')).toBeTruthy();
    expect(screen.getByText('Clear')).toBeTruthy();
  });

  it('shows "Unreadable" and "Not read" for an unreadable field with no value', async () => {
    await renderWithProviders(
      <FieldRow field={field({ legibility: 'unreadable', value: null, evidenceText: null })} />,
    );
    expect(screen.getByText('Unreadable')).toBeTruthy();
    expect(screen.getByText('Not read')).toBeTruthy();
    expect(screen.queryByText(/Printed text/)).toBeNull();
  });

  it('reads as one sentence to a screen reader', async () => {
    await renderWithProviders(
      <FieldRow
        field={field({ legibility: 'partial', value: 'Paracel', evidenceText: 'Parace1' })}
      />,
    );
    expect(
      screen.getByLabelText('Brand name: Paracel. Unclear. Printed text: Parace1'),
    ).toBeTruthy();
  });
});

describe('conflicts', () => {
  it('formats a conflict as "<label> on label, <registry> in registry"', () => {
    expect(conflictText({ key: 'strength', labelValue: '500 mg', referenceValue: '250 mg' })).toBe(
      '500 mg on label, 250 mg in registry',
    );
  });

  it('ConflictRow shows the field and the conflict text', async () => {
    await renderWithProviders(
      <ConflictRow
        conflict={{ key: 'strength', labelValue: '500 mg', referenceValue: '250 mg' }}
      />,
    );
    expect(screen.getByText('Strength')).toBeTruthy();
    expect(screen.getByText('500 mg on label, 250 mg in registry')).toBeTruthy();
  });
});
