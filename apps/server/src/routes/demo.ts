/**
 * Demo scenarios (spec §5.1, §7). Always available and always on the fixture
 * providers, in both PROVIDER_MODE values: no model, no registry, no spend.
 */
import { DemoScenarioRequestSchema, type DemoScenarioSummary } from '@medilens/contracts';
import express, { Router } from 'express';
import type { RouteContext } from '../app';
import { JSON_BODY_LIMIT } from '../config';
import { DEMO_SCENARIOS, getScenario } from '../demo/scenarios';
import { HttpError, validationFailed } from '../http/errors';
import { analyzeScenario } from '../pipeline/analyze';

export function demoRouter({ deps, fixtures }: RouteContext): Router {
  const router = Router();

  router.get('/demo/scenarios', (_req, res) => {
    const list: DemoScenarioSummary[] = DEMO_SCENARIOS.map(({ id, title, presetQuestion }) =>
      presetQuestion === undefined ? { id, title } : { id, title, presetQuestion },
    );
    res.json(list);
  });

  router.post('/demo/scenario', express.json({ limit: JSON_BODY_LIMIT }), async (req, res) => {
    const body = DemoScenarioRequestSchema.safeParse(req.body);
    if (!body.success) throw validationFailed('Send {"scenarioId": "<id>"}.');
    if (getScenario(body.data.scenarioId) === undefined) {
      throw new HttpError(404, 'NOT_FOUND', 'Unknown demo scenario.');
    }
    const result = await analyzeScenario(body.data.scenarioId, {
      reader: fixtures.reader,
      references: fixtures.references,
      store: deps.store,
      now: deps.now,
      newId: deps.newId,
      isDemo: true,
    });
    res.json(result);
  });

  return router;
}
