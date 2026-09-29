import { supabase } from '@/config/database.js';
import { logger } from '@/utils/logger.js';

/**
 * Internal, service-key-only operations on one verification's stored data,
 * for an integrator that keeps its own copy of the finished result (see
 * routes/internalVerification.ts).
 */

export type VerificationImageType = 'document_front' | 'document_back' | 'selfie';

export interface VerificationImage {
  type: VerificationImageType;
  key: string;
}

export interface ServiceKeyVerification {
  id: string;
  status: string;
  document_id: string | null;
  selfie_id: string | null;
}

/** Terminal verification_requests.status values. */
export const FINISHED_STATUSES = ['verified', 'failed', 'manual_review'];

/**
 * Looks a verification up for a service key. Scoped by api_key_id as well as
 * developer_id: every service key shares one shadow developer, so
 * developer_id alone is not a boundary between keys (see scopeForRequest).
 */
export async function findVerificationForServiceKey(
  verificationId: string,
  developerId: string,
  apiKeyId: string,
): Promise<ServiceKeyVerification | null> {
  const { data, error } = await supabase
    .from('verification_requests')
    .select('id, status, document_id, selfie_id')
    .eq('id', verificationId)
    .eq('developer_id', developerId)
    .eq('api_key_id', apiKeyId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to look up verification: ${error.message}`);
  }
  return (data as ServiceKeyVerification) ?? null;
}

/**
 * The storage keys of the verification's current images: the front the
 * verification points at, the latest back uploaded after it, and the selfie
 * it points at. Rows from an earlier attempt are not returned.
 */
export async function getVerificationImages(
  verification: ServiceKeyVerification,
): Promise<VerificationImage[]> {
  const docs = await filesFor('documents', verification.id);
  const selfies = await filesFor('selfies', verification.id);

  const images: VerificationImage[] = [];

  const front = docs.find((doc) => doc.id === verification.document_id);
  if (front) {
    images.push({ type: 'document_front', key: front.file_path });

    // The back upload does not mark its row, so the back is the latest other
    // document uploaded after the front.
    const frontTime = timeOf(front.created_at);
    const back = docs
      .filter((doc) => doc.id !== front.id && timeOf(doc.created_at) >= frontTime)
      .pop();
    if (back) {
      images.push({ type: 'document_back', key: back.file_path });
    }
  }

  const selfie = selfies.find((s) => s.id === verification.selfie_id);
  if (selfie) {
    images.push({ type: 'selfie', key: selfie.file_path });
  }

  return images;
}

/**
 * Hard-deletes every database row held for a verification. Storage files are
 * deliberately left alone: the caller still serves them from its own copy of
 * the keys, and deletes them itself when its retention period ends.
 *
 * verification_contexts, mobile_handoff_sessions and batch_items have no
 * foreign key to verification_requests, so they are deleted explicitly; the
 * other child tables are deleted explicitly too where they hold identity
 * data, and the rest cascade. Any failure throws before verification_requests
 * is deleted, so a retry finds the verification again.
 */
export async function deleteVerificationData(verificationId: string): Promise<void> {
  // A re-verification pointing at this one would block the delete: the
  // parent_verification_id reference has no ON DELETE clause.
  await check(
    'verification_requests (children)',
    supabase
      .from('verification_requests')
      .update({ parent_verification_id: null })
      .eq('parent_verification_id', verificationId),
  );

  const byRequestId = [
    'documents',
    'selfies',
    'verification_risk_scores',
    'aml_screenings',
    'expiry_alerts',
    'reverification_schedules',
    'phone_otp_codes',
    'phone_otp_rate_limits',
    'dedup_fingerprints',
  ];
  for (const table of byRequestId) {
    await check(table, supabase.from(table).delete().eq('verification_request_id', verificationId));
  }

  const byVerificationId = ['verification_contexts', 'mobile_handoff_sessions', 'batch_items'];
  for (const table of byVerificationId) {
    await check(table, supabase.from(table).delete().eq('verification_id', verificationId));
  }

  await check('verification_requests', supabase.from('verification_requests').delete().eq('id', verificationId));

  logger.info('Verification data deleted', { verificationId });
}

async function filesFor(
  table: 'documents' | 'selfies',
  verificationId: string,
): Promise<Array<{ id: string; file_path: string; created_at: string }>> {
  const { data, error } = await supabase
    .from(table)
    .select('id, file_path, created_at')
    .eq('verification_request_id', verificationId)
    .not('file_path', 'is', null)
    .order('created_at', { ascending: true });

  if (error) {
    throw new Error(`Failed to read ${table}: ${error.message}`);
  }
  return (data as any[]) ?? [];
}

async function check(table: string, query: PromiseLike<{ error: any }>): Promise<void> {
  const { error } = await query;
  if (error) {
    throw new Error(`Failed to delete from ${table}: ${error.message ?? error}`);
  }
}

function timeOf(value: string | Date): number {
  return new Date(value).getTime();
}
