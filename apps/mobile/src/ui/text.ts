/**
 * The app's own fixed English wording. Anything about a specific label or a
 * verification result comes from the server and is shown verbatim; the app
 * composes only field names, legibility chips, status labels (theme.ts) and
 * the conflict row format below.
 */
import type { AnalysisResult, FieldConflict, FieldKey, Legibility } from '@medilens/contracts';
import { ApiError } from '../api/client';
import type { StatusKey } from '../theme/theme';

export const FIELD_LABELS: Record<FieldKey, string> = {
  brandName: 'Brand name',
  genericNames: 'Generic name',
  strength: 'Strength',
  dosageForm: 'Dosage form',
  manufacturer: 'Manufacturer',
  registrationNumber: 'Registration number',
  directions: 'Directions',
  warnings: 'Warnings',
  storage: 'Storage',
  expiryDate: 'Expiry date on pack',
  batchNumber: 'Batch number',
  rxOrOtc: 'Prescription or over the counter',
};

export const LEGIBILITY_LABELS: Record<Legibility, string> = {
  clear: 'Clear',
  partial: 'Unclear',
  unreadable: 'Unreadable',
};

/** "500 mg on label, 250 mg in registry": both values verbatim from the server. */
export function conflictText(conflict: FieldConflict): string {
  return `${conflict.labelValue} on label, ${conflict.referenceValue} in registry`;
}

export function fieldList(keys: readonly FieldKey[]): string {
  return keys.map((k) => FIELD_LABELS[k]).join(', ');
}

/** The badge status for a result: a photo that failed the quality check is "unreadable". */
export function statusKeyFor(result: AnalysisResult): StatusKey {
  return result.pipelineState === 'label_unreadable' ? 'unreadable' : result.match.status;
}

/** First-run disclaimer, shown and spoken until the user acknowledges it. */
export const DISCLAIMER_SENTENCES = [
  'MediLens AI reads the printed text on a medicine label aloud and checks it against the Philippine FDA registry.',
  'It is not a diagnostic tool and does not give medical advice.',
  'It does not identify loose pills.',
  'Always confirm with a pharmacist or doctor.',
  'Photos are not stored.',
] as const;

export const GENERIC_ERROR = 'Something went wrong. Please try again.';

/** The message to show for a failed call: the server's (or client's) own text when there is one. */
export function messageFor(error: unknown): string {
  return error instanceof ApiError ? error.message : GENERIC_ERROR;
}

/** A registry check time for people, falling back to the raw timestamp. */
export function formatCheckedAt(iso: string): string {
  try {
    const formatted = new Date(iso).toLocaleString('en-US', {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
    return formatted === 'Invalid Date' ? iso : formatted;
  } catch {
    return iso;
  }
}
