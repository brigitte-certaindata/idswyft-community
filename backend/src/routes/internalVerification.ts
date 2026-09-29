import express, { Request, Response } from 'express';
import { param } from 'express-validator';
import { authenticateServiceKey } from '@/middleware/auth.js';
import { catchAsync } from '@/middleware/errorHandler.js';
import { validate } from '@/middleware/validate.js';
import { logVerificationEvent } from '@/utils/logger.js';
import {
  FINISHED_STATUSES,
  deleteVerificationData,
  findVerificationForServiceKey,
  getVerificationImages,
} from '@/services/verificationData.js';

/**
 * Internal routes for an integrator that keeps its own copy of a finished
 * verification (AgentPay's outcome cache): read the image storage keys once,
 * then delete this service's database copy. Service key (isk_*) only, and
 * scoped to the key that created the verification. Never called by a browser.
 *
 * An unknown verification, or one created by a different key, is a 404 on
 * both routes, so ids cannot be probed across keys.
 */
const router = express.Router();

const verificationIdParam = [param('verification_id').isUUID().withMessage('Invalid verification ID')];

async function requireServiceKeyVerification(req: Request, res: Response) {
  const verification = await findVerificationForServiceKey(
    req.params.verification_id,
    (req as any).developer.id,
    (req as any).apiKey.id,
  );
  if (!verification) {
    res.status(404).json({ error: 'Verification request not found' });
  }
  return verification;
}

// ─── Current image storage keys ─────────────────────────────────────────────
router.get('/:verification_id/internal/images',
  authenticateServiceKey,
  verificationIdParam,
  validate,
  catchAsync(async (req: Request, res: Response) => {
    const verification = await requireServiceKeyVerification(req, res);
    if (!verification) return;

    const images = await getVerificationImages(verification);
    res.json({ verification_id: verification.id, images });
  })
);

// ─── Delete this service's database copy ────────────────────────────────────
// Only for a finished verification, so an applicant still capturing is never
// cut off. Storage files stay: the caller serves and deletes them itself.
router.delete('/:verification_id/internal/data',
  authenticateServiceKey,
  verificationIdParam,
  validate,
  catchAsync(async (req: Request, res: Response) => {
    const verification = await requireServiceKeyVerification(req, res);
    if (!verification) return;

    if (!FINISHED_STATUSES.includes(verification.status)) {
      return res.status(409).json({
        error: 'Verification has not finished',
        status: verification.status,
      });
    }

    await deleteVerificationData(verification.id);
    logVerificationEvent('verification_data_deleted', verification.id);
    res.json({ verification_id: verification.id, deleted: true });
  })
);

export default router;
