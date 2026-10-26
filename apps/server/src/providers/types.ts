import type { ReferenceRecord } from '@medilens/contracts';

/** Outcome of a registry lookup, as handed to the matcher. */
export type ReferenceSearchResult =
  | { kind: 'ok'; records: ReferenceRecord[]; advisories: { title: string; url: string }[] }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'not_attempted' };
