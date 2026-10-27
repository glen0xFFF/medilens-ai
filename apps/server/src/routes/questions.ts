import { Router } from 'express';
import { ALLOWED_QUESTION_EXAMPLES } from '../domain/safety';

/**
 * GET /questions/presets: the preset questions the app shows as buttons. The
 * safety gate is default-deny, so these are the questions a user can be sure
 * are answered rather than refused.
 */
export function questionsRouter(): Router {
  const router = Router();
  router.get('/questions/presets', (_req, res) => {
    res.json([...ALLOWED_QUESTION_EXAMPLES]);
  });
  return router;
}
