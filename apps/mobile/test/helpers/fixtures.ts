/**
 * Responses captured from the real server in demo mode (PROVIDER_MODE=demo,
 * `npx tsx src/server.ts`, then curl against /api/v1), not hand-written. Each
 * is parsed with the shared contracts schemas, so a contract change that the
 * fixtures no longer satisfy fails here first.
 */
import {
  AnalysisResultSchema,
  AnswerSchema,
  DemoScenarioSummarySchema,
  type AnalysisResult,
} from '@medilens/contracts';
import { z } from 'zod';
import { ReferencesSchema } from '../../src/api/client';
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
  s1: ReferencesSchema.parse(s1Refs),
  s4: ReferencesSchema.parse(s4Refs),
};

export const ANSWERS = {
  s1Strength: AnswerSchema.parse(s1Strength),
  s7Refused: AnswerSchema.parse(s7Refused),
};

export const SCENARIOS = z.array(DemoScenarioSummarySchema).parse(scenariosJson);
export const PRESETS = z.array(z.string()).parse(presetsJson);

/** The scenario id (as the server lists it) whose result fixture is `key`. */
export const SCENARIO_IDS = {
  s1: 's1-clear',
  s4: 's4-conflict',
} as const;
