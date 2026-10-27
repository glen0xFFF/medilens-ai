/**
 * Scans and follow-up questions (spec §5.1).
 *
 * POST /labels/analyze: multipart, field "images", 1–3 files of at most 8 MB,
 * held in memory only (multer memoryStorage; nothing is written to disk).
 * Live mode reads with Muse Spark and checks PH FDA while the daily budget
 * lasts. Demo mode still validates the upload and checks photo quality for
 * real, then reads it as the s1 fixture and marks the result isDemo.
 */
import {
  AnalysisResultSchema,
  ExplainRequestSchema,
  type AnalysisResult,
} from '@medilens/contracts';
import express, { Router, type Request } from 'express';
import multer from 'multer';
import type { RouteContext } from '../app';
import { JSON_BODY_LIMIT, MAX_IMAGE_BYTES } from '../config';
import { validationFailed } from '../http/errors';
import { MAX_IMAGES, PipelineError, analyzeImages, type PipelineDeps } from '../pipeline/analyze';
import { explainQuestion } from '../pipeline/explain';

/** The fixture a real upload is read as in demo mode (Task 10 ruling). */
export const DEMO_UPLOAD_SCENARIO = 's1-clear';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_BYTES, files: MAX_IMAGES, fields: 10, fieldSize: 1024 },
});

/** The stored result for `:id`, or NOT_FOUND (unknown, or expired after 15 minutes). */
export function storedResult(ctx: RouteContext, req: Request): AnalysisResult {
  const id = AnalysisResultSchema.shape.id.safeParse(req.params.id);
  if (!id.success) throw validationFailed('The result id is not valid.');
  const result = ctx.deps.store.get(id.data);
  if (result === undefined) throw new PipelineError('NOT_FOUND');
  return result;
}

export function labelsRouter(ctx: RouteContext): Router {
  const { deps, fixtures } = ctx;
  const router = Router();

  const demoUpload: PipelineDeps = {
    reader: {
      read: (images) => fixtures.reader.read(images, { scenarioId: DEMO_UPLOAD_SCENARIO }),
    },
    references: {
      search: (q) => fixtures.references.search(q, { scenarioId: DEMO_UPLOAD_SCENARIO }),
    },
    store: deps.store,
    now: deps.now,
    newId: deps.newId,
    isDemo: true,
  };

  router.post('/labels/analyze', upload.array('images', MAX_IMAGES), async (req, res) => {
    const files = Array.isArray(req.files) ? req.files : [];
    if (files.length === 0) throw validationFailed('Send 1 to 3 photos in the "images" field.');
    const images = files.map((f) => f.buffer);

    let pipeline = demoUpload;
    if (deps.providerMode === 'live') {
      const live = deps.live;
      if (live === undefined) throw new PipelineError('INTERNAL_ERROR', 'No live providers.');
      // checked before the model is called; demo scenarios stay available
      if (deps.meter.exhausted()) throw new PipelineError('LIVE_BUDGET_EXHAUSTED');
      pipeline = {
        reader: live.reader,
        references: live.references,
        store: deps.store,
        now: deps.now,
        newId: deps.newId,
        isDemo: false,
      };
    }
    res.json(await analyzeImages(images, pipeline));
  });

  router.get('/labels/:id', (req, res) => {
    res.json(storedResult(ctx, req));
  });

  router.post('/labels/:id/explain', express.json({ limit: JSON_BODY_LIMIT }), async (req, res) => {
    const result = storedResult(ctx, req);
    const body = ExplainRequestSchema.safeParse(req.body);
    if (!body.success) {
      throw validationFailed('Send {"question": "..."} with 1 to 300 characters.');
    }
    const answer = await explainQuestion(result, body.data.question, {
      fixture: fixtures.answerer,
      live: deps.live?.answerer,
      liveBudgetExhausted: () => deps.meter.exhausted(),
    });
    res.json(answer);
  });

  return router;
}
