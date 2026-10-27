/**
 * Responses captured from a real server, not hand-written. The result,
 * answer, references, scenario and preset bodies came from the Node server in
 * demo mode (PROVIDER_MODE=demo, `npx tsx src/server.ts`, then curl against
 * /api/v1); the go-*.json bodies from the Go API (`go build ./services/api`,
 * run with MODEL_PROVIDER=mock REFERENCE_PROVIDER=fixture, then curl against
 * /api/v1/config/capabilities and POST /api/v1/demo/scenarios {"scenarioId":
 * "s1-clear"} and its GET /api/v1/analyses/{id}). Each is parsed with the
 * shared contracts schemas, so a contract change that the fixtures no longer
 * satisfy fails here first.
 */
import {
  AnalysisCreatedSchema,
  AnalysisReferencesSchema,
  AnalysisResultSchema,
  AnalysisStatusSchema,
  AnswerSchema,
  CapabilitiesSchema,
  DemoScenarioSummarySchema,
  type AnalysisResult,
} from '@medilens/contracts';
import { z } from 'zod';
import goCapabilities from '../fixtures/go-capabilities.json';
import goS1Created from '../fixtures/go-s1.created.json';
import goS1Status from '../fixtures/go-s1.status.json';
import presetsJson from '../fixtures/presets.json';
import s1Refs from '../fixtures/s1-clear.references.json';
import s1 from '../fixtures/s1-clear.result.json';
import s1Strength from '../fixtures/s1-strength.answer.json';
import s2 from '../fixtures/s2-blurry.result.json';
import s3 from '../fixtures/s3-similar.result.json';
import s4Refs from '../fixtures/s4-conflict.references.json';
import s4 from '../fixtures/s4-conflict.result.json';
import s5 from '../fixtures/s5-nomatch.result.json';
import s6 from '../fixtures/s6-loose-pill.result.json';
import s7Refused from '../fixtures/s7-refused.answer.json';
import s7 from '../fixtures/s7-unsupported-question.result.json';
import s8 from '../fixtures/s8-registry-down.result.json';
import scenariosJson from '../fixtures/scenarios.json';

const result = (raw: unknown): AnalysisResult => AnalysisResultSchema.parse(raw);

export const RESULTS = {
  s1: result(s1),
  s2: result(s2),
  s3: result(s3),
  s4: result(s4),
  s5: result(s5),
  s6: result(s6),
  s7: result(s7),
  s8: result(s8),
};

export const REFERENCES = {
  s1: AnalysisReferencesSchema.parse(s1Refs),
  s4: AnalysisReferencesSchema.parse(s4Refs),
};

export const ANSWERS = {
  s1Strength: AnswerSchema.parse(s1Strength),
  s7Refused: AnswerSchema.parse(s7Refused),
};

export const SCENARIOS = z.array(DemoScenarioSummarySchema).parse(scenariosJson);
export const PRESETS = z.array(z.string()).parse(presetsJson);

/** The Go API in mock/fixture mode: modelProvider "mock", so the app shows the demo notice. */
export const CAPABILITIES = CapabilitiesSchema.parse(goCapabilities);
/** POST /api/v1/demo/scenarios {"scenarioId":"s1-clear"}: 202. */
export const S1_CREATED = AnalysisCreatedSchema.parse(goS1Created);
/** GET /api/v1/analyses/{id} once that analysis completed: every stage it ran, in order. */
export const S1_STATUS = AnalysisStatusSchema.parse(goS1Status);

/** The scenario id (as the server lists it) whose result fixture is `key`. */
export const SCENARIO_IDS = {
  s1: 's1-clear',
  s4: 's4-conflict',
} as const;
