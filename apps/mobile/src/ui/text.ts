/**
 * The app's own fixed English wording. Anything about a specific label or a
 * verification result comes from the server and is shown verbatim; the app
 * composes only field names, legibility chips, status labels (theme.ts) and
 * the conflict row format below.
 */
import type { AnalysisResult, FieldConflict, FieldKey, Legibility } from '@medilens/contracts';
import { ApiError, type ApiErrorCode } from '../api/client';
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

/** A field with no value that the reader could not make out. */
export const NOT_READ = 'Not read';
/** A field with no value that the reader marked clear: nothing was printed for it. */
export const NOT_PRINTED = 'Not printed on the pack';

/**
 * Final review I2: a loose pill, a photo that is not a medicine label, or a
 * label with no readable text shows no field values at all, whatever the
 * result carries. The pipeline states that mean "no label was read", with the
 * app's own fixed wording. A loose tablet is never called a pack.
 */
export const NO_FIELDS_MESSAGES = {
  loose_pill: 'This looks like a loose tablet, not a label, so no label fields are shown.',
  not_a_label: 'This photo does not look like a medicine label, so no label fields are shown.',
  label_unreadable: 'No label fields were read from this photo.',
} as const satisfies Partial<Record<AnalysisResult['pipelineState'], string>>;

/** Why a result shows no label fields, or null when its fields can be listed. */
export function noFieldsMessage(result: AnalysisResult): string | null {
  const { pipelineState, label } = result;
  if (pipelineState === 'loose_pill' || label?.imageKind === 'loose_pill') {
    return NO_FIELDS_MESSAGES.loose_pill;
  }
  if (pipelineState === 'not_a_label' || label?.imageKind === 'not_medicine') {
    return NO_FIELDS_MESSAGES.not_a_label;
  }
  if (
    pipelineState === 'label_unreadable' ||
    label === null ||
    label.imageKind === 'unreadable' ||
    label.fields.length === 0
  ) {
    return NO_FIELDS_MESSAGES.label_unreadable;
  }
  return null;
}

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

/**
 * Plain messages for a failed upload. These codes get the app's own wording
 * (the server's text is written for logs or is too technical); any other
 * error shows the server's message verbatim.
 */
export const ANALYZE_ERROR_MESSAGES: Partial<Record<ApiErrorCode, string>> = {
  IMAGE_TOO_LARGE: 'That photo is too large to send. Please retake it or choose another photo.',
  INVALID_IMAGE: 'That photo could not be opened. Please retake it or choose another photo.',
  RATE_LIMITED: 'Too many scans right now. Please wait a minute and try again.',
  LIVE_BUDGET_EXHAUSTED: 'Live reading is paused for today. You can still try the demo.',
  NETWORK: "I couldn't reach the MediLens server. Check your connection and try again.",
  TIMEOUT: 'Reading the label took too long. Please try again.',
  OCR_FAILED: "I couldn't read the label this time. Please try again or retake the photos.",
};

export function analyzeErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return GENERIC_ERROR;
  return ANALYZE_ERROR_MESSAGES[error.code] ?? error.message;
}
