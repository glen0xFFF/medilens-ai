/**
 * GET /references/:id: the registry side of a stored analysis, for the
 * verification and sources screen. `checkedAt` is when registry data was
 * retrieved: the newest candidate's check time, or the analysis time when the
 * registry answered with no candidates; null when the registry was not
 * checked or could not be reached, so a failed lookup never shows a check
 * time. Registry `registrationExpiry` is the certificate's expiry and is
 * passed through only as part of each candidate record.
 */
import type { AnalysisResult, ReferenceRecord } from '@medilens/contracts';
import { Router } from 'express';
import type { RouteContext } from '../app';
import { storedResult } from './labels';

export interface ReferencesResponse {
  candidates: ReferenceRecord[];
  advisories: { title: string; url: string }[];
  limitations: string[];
  checkedAt: string | null;
}

function checkedAt(result: AnalysisResult): string | null {
  const { status, candidates } = result.match;
  if (status === 'not_attempted' || status === 'unavailable') return null;
  const times = candidates.map((c) => c.checkedAt).sort();
  return times.at(-1) ?? result.createdAt;
}

export function referencesRouter(ctx: RouteContext): Router {
  const router = Router();
  router.get('/references/:id', (req, res) => {
    const result = storedResult(ctx, req);
    const body: ReferencesResponse = {
      candidates: result.match.candidates,
      advisories: result.match.advisories,
      limitations: result.match.limitations,
      checkedAt: checkedAt(result),
    };
    res.json(body);
  });
  return router;
}
