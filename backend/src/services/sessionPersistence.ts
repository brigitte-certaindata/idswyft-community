import { supabase } from '@/config/database.js';
import { VerificationStatus } from '@idswyft/shared';
import type { SessionState } from '@idswyft/shared';
import { APIError } from '@/middleware/errorHandler.js';
import { logger } from '@/utils/logger.js';

/** Save session state to verification_contexts table */
export async function saveSessionState(verificationId: string, state: Readonly<SessionState>): Promise<void> {
  // Strip biometric data (GDPR Article 9) — embeddings must not persist permanently.
  // Only strip once verification is terminal (COMPLETE/HARD_REJECTED) — the front
  // embedding is needed by the face match step which runs in a later HTTP request.
  const sanitized: any = JSON.parse(JSON.stringify(state));
  const isTerminal = state.current_step === VerificationStatus.COMPLETE
    || state.current_step === VerificationStatus.HARD_REJECTED;
  if (isTerminal) {
    if (sanitized.front_extraction) sanitized.front_extraction.face_embedding = null;
    if (sanitized.live_capture) sanitized.live_capture.face_embedding = null;
    // Voice embeddings are never stored in session state (only on the engine side),
    // but strip the voice_match result's internal data for defense-in-depth.
  }

  const context = {
    verification_id: verificationId,
    context: JSON.stringify(sanitized),
    updated_at: new Date().toISOString(),
  };

  const { error } = await supabase
    .from('verification_contexts')
    .upsert(context, { onConflict: 'verification_id' });
  // Fail loudly: the adapter returns { error } rather than throwing, so a
  // swallowed failure here would leave the next capture step reading stale or
  // missing session state while the current request still reports success.
  if (error) {
    logger.error('Failed to save session state', {
      verificationId, error: error.message, code: (error as any).code,
    });
    throw new APIError('Failed to persist verification state', 500, 'SESSION_STATE_SAVE_FAILED');
  }
}

/** Load session state from verification_contexts table */
export async function loadSessionState(verificationId: string): Promise<SessionState | null> {
  const { data, error } = await supabase
    .from('verification_contexts')
    .select('context')
    .eq('verification_id', verificationId)
    .single();

  // Distinguish "no row yet" (a legitimate new session) from a real DB error.
  // The PG adapter returns code 'PGRST116' when .single() finds no rows; any
  // other error is a genuine failure and must not be swallowed into a fresh
  // session (which would silently reset the applicant's progress).
  if (error && (error as any).code !== 'PGRST116') {
    logger.error('Failed to load session state', {
      verificationId, error: error.message, code: (error as any).code,
    });
    throw new APIError('Failed to load verification state', 500, 'SESSION_STATE_LOAD_FAILED');
  }

  if (!data?.context) return null;
  return typeof data.context === 'string' ? JSON.parse(data.context) : data.context;
}
