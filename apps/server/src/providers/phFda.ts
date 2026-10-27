/**
 * Live PH FDA registry lookup (spec §2, §5.4). Backend-only, honest
 * User-Agent, 5 s timeout, 24 h cache of successful responses, at most two
 * fetches per search: registration number first, then the name (for records
 * when the number found nothing, or for advisories only when it did).
 *
 * Response field names, confirmed against one real response on 2026-10-27
 * (`GET /api/search?q=biogesic`, first 4 KB):
 *   top level: lto_food, lto_drugs, lto_medicaldevice, lto_healthrelateddevice,
 *     lto_pco, fdafoodproducts, cdrr, ... fdawebsite
 *   cdrr rows: registration_number, generic_name, brand_name,
 *     dosage_strength_form, classification, packaging, manufacturer,
 *     country_of_origin, trader, importer, distributor, app_type,
 *     issuance_date, expiry_date, pharmacologic_category
 * The fdawebsite rows were beyond the 4 KB captured, so their field names are
 * NOT confirmed: `title` comes from the research memo (§4.2); the link is read
 * from the first value among url / link / permalink / guid that the contract
 * accepts. Confirm in the live smoke test. Until then (final review Minor 9),
 * a non-empty fdawebsite list that maps to no advisory at all, or a row about
 * this product whose link is unusable, flags `advisoriesUnchecked`, so a
 * field-name mismatch is never read as "no advisory".
 *
 * `expiry_date` is the registration-certificate expiry, never the product's.
 */
import { AdvisorySchema, ReferenceRecordSchema, type ReferenceRecord } from '@medilens/contracts';
import { normalizeName, normalizeRegistrationNumber } from '../domain/parsers';
import { TtlCache } from './cache';
import type {
  ProviderContext,
  ReferenceProvider,
  ReferenceQuery,
  ReferenceSearchResult,
} from './types';

export const PH_FDA_PROVIDER = 'ph-fda';
const API_URL = 'https://verification.fda.gov.ph/api/search?q=';
const SOURCE_URL = 'https://verification.fda.gov.ph/?search=';
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const ADVISORY_URL_KEYS = ['url', 'link', 'permalink', 'guid'] as const;

export interface PhFdaDeps {
  fetch: typeof fetch;
  now: () => number;
  userAgent: string;
  timeoutMs?: number;
  cacheTtlMs?: number;
}

type Advisory = { title: string; url: string };
/**
 * One successful lookup of one term: mapped records, every advisory row the
 * contract accepts, the titles of rows that had a title but no link the
 * contract accepts, and whether a non-empty advisory list mapped to nothing
 * at all (field names not as expected).
 */
type TermResult = {
  records: ReferenceRecord[];
  advisories: Advisory[];
  unusableTitles: string[];
  unmappable: boolean;
};
type FetchOutcome = { ok: true; value: TermResult } | { ok: false; reason: string };

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function text(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
}

function mapRecord(row: unknown, term: string, checkedAt: string): ReferenceRecord | null {
  if (!isObject(row)) return null;
  const parsed = ReferenceRecordSchema.safeParse({
    provider: PH_FDA_PROVIDER,
    sourceUrl: SOURCE_URL + encodeURIComponent(term),
    registrationNumber: text(row.registration_number),
    brandName: text(row.brand_name),
    genericName: text(row.generic_name),
    strengthForm: text(row.dosage_strength_form),
    manufacturer: text(row.manufacturer),
    classification: text(row.classification),
    registrationExpiry: text(row.expiry_date),
    checkedAt,
  });
  return parsed.success ? parsed.data : null;
}

/**
 * An advisory row as the contract's AdvisorySchema accepts it (final review
 * Minor 7: a link `new URL()` parses but the contract rejects, such as
 * "https:/host/x" or "https://localhost/x", would fail the whole scan), else
 * the row's title when it has one, else nothing.
 */
function mapAdvisory(row: unknown): { advisory: Advisory } | { unusableTitle: string } | null {
  if (!isObject(row)) return null;
  const title = text(row.title);
  if (title === null) return null;
  for (const key of ADVISORY_URL_KEYS) {
    const url = text(row[key]);
    if (url === null) continue;
    const parsed = AdvisorySchema.safeParse({ title, url });
    if (parsed.success) return { advisory: parsed.data };
  }
  return { unusableTitle: title };
}

function mapAdvisories(
  rows: unknown[],
): Pick<TermResult, 'advisories' | 'unusableTitles' | 'unmappable'> {
  const advisories: Advisory[] = [];
  const unusableTitles: string[] = [];
  for (const row of rows) {
    const m = mapAdvisory(row);
    if (m === null) continue;
    if ('advisory' in m) advisories.push(m.advisory);
    else unusableTitles.push(m.unusableTitle);
  }
  // final review Minor 9: rows that map to nothing at all (no title under the
  // field names assumed above) are an unknown, never "no advisory"
  return { advisories, unusableTitles, unmappable: rows.length > 0 && advisories.length === 0 };
}

export function createPhFdaProvider(deps: PhFdaDeps): ReferenceProvider {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cache = new TtlCache<string, TermResult>(
    deps.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS,
    deps.now,
  );

  async function fetchTerm(term: string): Promise<FetchOutcome> {
    const cached = cache.get(term);
    if (cached !== undefined) return { ok: true, value: cached };

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('timeout'));
      }, timeoutMs);
    });
    let body: string;
    try {
      // Body read is inside the race too: a stalled body is still a timeout.
      body = await Promise.race([
        (async () => {
          const res = await deps.fetch(API_URL + encodeURIComponent(term), {
            method: 'GET',
            headers: { 'User-Agent': deps.userAgent, Accept: 'application/json' },
            signal: controller.signal,
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.text();
        })(),
        timeout,
      ]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'request failed';
      return { ok: false, reason: `PH FDA lookup failed: ${msg}` };
    } finally {
      clearTimeout(timer);
    }

    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      return { ok: false, reason: 'PH FDA lookup failed: response was not JSON' };
    }
    if (!isObject(json) || !Array.isArray(json.cdrr) || !Array.isArray(json.fdawebsite)) {
      return { ok: false, reason: 'PH FDA lookup failed: unexpected response shape' };
    }

    const checkedAt = new Date(deps.now()).toISOString();
    const value: TermResult = {
      records: json.cdrr
        .map((row) => mapRecord(row, term, checkedAt))
        .filter((r): r is ReferenceRecord => r !== null),
      ...mapAdvisories(json.fdawebsite),
    };
    cache.set(term, value);
    return { ok: true, value };
  }

  return {
    async search(q: ReferenceQuery, _ctx: ProviderContext): Promise<ReferenceSearchResult> {
      const reg =
        q.registrationNumber === undefined ? null : normalizeRegistrationNumber(q.registrationNumber);
      const name = q.name === undefined ? '' : normalizeName(q.name);
      const terms = [reg, name].filter((t): t is string => t !== null && t !== '');
      if (terms.length === 0) return { kind: 'not_attempted' };

      // At most two fetches. Registration number first; if it finds nothing,
      // the name. Advisory pages are keyed by product name, so a registration
      // hit spends the second fetch on a name term for advisories only.
      const first = await fetchTerm(terms[0] as string);
      if (!first.ok) return { kind: 'unavailable', reason: first.reason };
      const found = first.value;
      const advisoryPool: Advisory[] = [...found.advisories];
      const unusablePool: string[] = [...found.unusableTitles];
      let advisoriesUnchecked = found.unmappable;

      // Brands of the first lookup's records. Only a registration hit makes
      // them this pack's brand; a name search can return other products.
      const recordBrands = [
        ...new Set(
          found.records
            .map((r) => (r.brandName === null ? '' : normalizeName(r.brandName)))
            .filter((b) => b !== ''),
        ),
      ];
      let records = found.records;

      if (reg !== null && terms[0] === reg) {
        if (found.records.length === 0) {
          if (name !== '') {
            const second = await fetchTerm(name);
            if (!second.ok) return { kind: 'unavailable', reason: second.reason };
            records = second.value.records;
            advisoryPool.push(...second.value.advisories);
            unusablePool.push(...second.value.unusableTitles);
            if (second.value.unmappable) advisoriesUnchecked = true;
          }
        } else {
          const advisoryTerm = name !== '' ? name : recordBrands[0];
          if (advisoryTerm === undefined) {
            advisoriesUnchecked = true;
          } else {
            const second = await fetchTerm(advisoryTerm);
            // Records stay from the registration hit; a failed advisory
            // lookup is flagged, never silently read as "no advisory".
            if (second.ok) {
              advisoryPool.push(...second.value.advisories);
              unusablePool.push(...second.value.unusableTitles);
              if (second.value.unmappable) advisoriesUnchecked = true;
            } else {
              advisoriesUnchecked = true;
            }
          }
        }
      }

      const regHit = reg !== null && terms[0] === reg && found.records.length > 0;
      const brands = [...new Set([...(name !== '' ? [name] : []), ...(regHit ? recordBrands : [])])];
      // An advisory about this product whose link the contract rejects is
      // dropped, so the advisories are flagged unchecked, never "none" (Minor 7).
      if (unusablePool.some((t) => brands.some((b) => t.toLowerCase().includes(b)))) {
        advisoriesUnchecked = true;
      }
      const advisories: Advisory[] = [];
      for (const a of advisoryPool) {
        const title = a.title.toLowerCase();
        if (!brands.some((b) => title.includes(b))) continue;
        if (advisories.some((x) => x.title === a.title && x.url === a.url)) continue;
        advisories.push({ ...a });
      }
      return {
        kind: 'ok',
        records: records.map((r) => ({ ...r })),
        advisories,
        ...(advisoriesUnchecked ? { advisoriesUnchecked: true as const } : {}),
      };
    },
  };
}
