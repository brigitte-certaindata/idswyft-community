/**
 * Tests for the service-key-only internal routes:
 *   GET    /api/v2/verify/:id/internal/images
 *   DELETE /api/v2/verify/:id/internal/data
 *
 * Supabase is replaced by an in-memory fake that records every query, so the
 * tests can assert both what is returned and exactly what is deleted.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const VID = 'a0a0a0a0-b1b1-c2c2-d3d3-e4e4e4e4e4e4';

type Call = { table: string; op: string; filters: Array<[string, string, unknown]>; payload?: unknown };

const db = vi.hoisted(() => ({
  verification: null as any,
  documents: [] as any[],
  selfies: [] as any[],
  calls: [] as Call[],
  failDeleteOn: null as string | null,
}));

vi.mock('@/config/database.js', () => {
  function builder(table: string) {
    const state: { op: string; filters: Array<[string, string, unknown]>; payload?: unknown } = {
      op: 'select',
      filters: [],
    };
    const run = () => {
      db.calls.push({ table, op: state.op, filters: state.filters, payload: state.payload });
      if (state.op !== 'select') {
        return db.failDeleteOn === table
          ? { data: null, error: { message: 'boom' } }
          : { data: null, error: null };
      }
      if (table === 'verification_requests') {
        const v = db.verification;
        const matches = v && state.filters.every(([, column, value]) => v[column] === value);
        return { data: matches ? v : null, error: null };
      }
      if (table === 'documents') return { data: db.documents, error: null };
      if (table === 'selfies') return { data: db.selfies, error: null };
      return { data: [], error: null };
    };
    const b: any = {
      select: () => { state.op = 'select'; return b; },
      update: (payload: unknown) => { state.op = 'update'; state.payload = payload; return b; },
      delete: () => { state.op = 'delete'; return b; },
      eq: (column: string, value: unknown) => { state.filters.push(['eq', column, value]); return b; },
      not: (column: string, _op: string, value: unknown) => { state.filters.push(['not', column, value]); return b; },
      order: () => b,
      maybeSingle: () => b,
      then: (resolve: any, reject: any) => Promise.resolve(run()).then(resolve, reject),
    };
    return b;
  }
  return { supabase: { from: (table: string) => builder(table) } };
});

vi.mock('@/middleware/auth.js', () => ({
  authenticateServiceKey: (req: any, _res: any, next: any) => {
    req.apiKey = { id: 'key-1', is_service: true };
    req.developer = { id: 'dev-1' };
    next();
  },
}));

vi.mock('@/middleware/errorHandler.js', () => ({
  catchAsync: (fn: any) => (req: any, res: any, next: any) =>
    Promise.resolve(fn(req, res, next)).catch(next),
}));

vi.mock('@/middleware/validate.js', () => ({
  validate: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('@/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  logVerificationEvent: vi.fn(),
}));

async function buildApp() {
  const { default: router } = await import('../internalVerification.js');
  const app = express();
  app.use(express.json());
  app.use('/api/v2/verify', router);
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err.statusCode || 500).json({ error: err.message });
  });
  return app;
}

function finishedVerification(overrides: Record<string, unknown> = {}) {
  return {
    id: VID,
    developer_id: 'dev-1',
    api_key_id: 'key-1',
    status: 'verified',
    document_id: 'doc-front-2',
    selfie_id: 'selfie-2',
    ...overrides,
  };
}

beforeEach(() => {
  db.verification = finishedVerification();
  db.documents = [];
  db.selfies = [];
  db.calls = [];
  db.failDeleteOn = null;
});

describe('GET /:id/internal/images', () => {
  it('returns the current front, back and selfie keys', async () => {
    db.documents = [
      { id: 'doc-front-2', file_path: 'documents/front.jpg', created_at: '2026-09-29T10:00:00Z' },
      { id: 'doc-back-2', file_path: 'documents/back.jpg', created_at: '2026-09-29T10:01:00Z' },
    ];
    db.selfies = [{ id: 'selfie-2', file_path: 'selfies/selfie.jpg', created_at: '2026-09-29T10:02:00Z' }];

    const res = await request(await buildApp()).get(`/api/v2/verify/${VID}/internal/images`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      verification_id: VID,
      images: [
        { type: 'document_front', key: 'documents/front.jpg' },
        { type: 'document_back', key: 'documents/back.jpg' },
        { type: 'selfie', key: 'selfies/selfie.jpg' },
      ],
    });
  });

  it('leaves out images from an earlier attempt', async () => {
    // An attempt whose files could not all be deleted on restart keeps its rows.
    db.documents = [
      { id: 'doc-back-1', file_path: 'documents/old-back.jpg', created_at: '2026-09-29T09:01:00Z' },
      { id: 'doc-front-2', file_path: 'documents/front.jpg', created_at: '2026-09-29T10:00:00Z' },
      { id: 'doc-back-2', file_path: 'documents/back.jpg', created_at: '2026-09-29T10:01:00Z' },
    ];
    db.selfies = [
      { id: 'selfie-1', file_path: 'selfies/old.jpg', created_at: '2026-09-29T09:02:00Z' },
      { id: 'selfie-2', file_path: 'selfies/selfie.jpg', created_at: '2026-09-29T10:02:00Z' },
    ];

    const res = await request(await buildApp()).get(`/api/v2/verify/${VID}/internal/images`);

    expect(res.body.images.map((i: any) => i.key)).toEqual([
      'documents/front.jpg',
      'documents/back.jpg',
      'selfies/selfie.jpg',
    ]);
  });

  it('returns no back when only the front was uploaded', async () => {
    db.documents = [{ id: 'doc-front-2', file_path: 'documents/front.jpg', created_at: '2026-09-29T10:00:00Z' }];
    db.verification = finishedVerification({ selfie_id: null });

    const res = await request(await buildApp()).get(`/api/v2/verify/${VID}/internal/images`);

    expect(res.body.images).toEqual([{ type: 'document_front', key: 'documents/front.jpg' }]);
  });

  it('is a 404 for a verification created by a different key', async () => {
    db.verification = finishedVerification({ api_key_id: 'someone-elses-key' });

    const res = await request(await buildApp()).get(`/api/v2/verify/${VID}/internal/images`);

    expect(res.status).toBe(404);
    expect(res.body.images).toBeUndefined();
  });

  it('is a 404 for an unknown verification', async () => {
    db.verification = null;

    const res = await request(await buildApp()).get(`/api/v2/verify/${VID}/internal/images`);

    expect(res.status).toBe(404);
  });
});

describe('DELETE /:id/internal/data', () => {
  const deletes = () => db.calls.filter((c) => c.op === 'delete').map((c) => c.table);

  it('deletes every row held for a finished verification, the verification last', async () => {
    const res = await request(await buildApp()).delete(`/api/v2/verify/${VID}/internal/data`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ verification_id: VID, deleted: true });

    const deleted = deletes();
    for (const table of [
      'documents',
      'selfies',
      'verification_contexts',
      'mobile_handoff_sessions',
      'batch_items',
      'verification_risk_scores',
      'aml_screenings',
      'dedup_fingerprints',
    ]) {
      expect(deleted).toContain(table);
    }
    expect(deleted[deleted.length - 1]).toBe('verification_requests');
  });

  it('deletes the tables without a foreign key by verification_id', async () => {
    await request(await buildApp()).delete(`/api/v2/verify/${VID}/internal/data`);

    for (const table of ['verification_contexts', 'mobile_handoff_sessions', 'batch_items']) {
      const call = db.calls.find((c) => c.table === table && c.op === 'delete');
      expect(call?.filters).toContainEqual(['eq', 'verification_id', VID]);
    }
  });

  it('detaches re-verifications that point at it before deleting it', async () => {
    await request(await buildApp()).delete(`/api/v2/verify/${VID}/internal/data`);

    const detach = db.calls.find((c) => c.table === 'verification_requests' && c.op === 'update');
    expect(detach?.payload).toEqual({ parent_verification_id: null });
    expect(detach?.filters).toContainEqual(['eq', 'parent_verification_id', VID]);
    expect(db.calls.indexOf(detach!)).toBeLessThan(
      db.calls.findIndex((c) => c.table === 'verification_requests' && c.op === 'delete'),
    );
  });

  it('never touches storage', async () => {
    await request(await buildApp()).delete(`/api/v2/verify/${VID}/internal/data`);

    // No documents/selfies file listing: the files stay for the caller.
    expect(db.calls.some((c) => c.op === 'select' && (c.table === 'documents' || c.table === 'selfies'))).toBe(false);
  });

  it('refuses a verification that has not finished', async () => {
    db.verification = finishedVerification({ status: 'processing' });

    const res = await request(await buildApp()).delete(`/api/v2/verify/${VID}/internal/data`);

    expect(res.status).toBe(409);
    expect(deletes()).toEqual([]);
  });

  it('keeps the verification row when a child delete fails, so a retry finds it', async () => {
    db.failDeleteOn = 'verification_contexts';

    const res = await request(await buildApp()).delete(`/api/v2/verify/${VID}/internal/data`);

    expect(res.status).toBe(500);
    expect(deletes()).not.toContain('verification_requests');
  });

  it('is a 404 once the verification is gone', async () => {
    db.verification = null;

    const res = await request(await buildApp()).delete(`/api/v2/verify/${VID}/internal/data`);

    expect(res.status).toBe(404);
    expect(deletes()).toEqual([]);
  });

  it('is a 404 for a verification created by a different key', async () => {
    db.verification = finishedVerification({ api_key_id: 'someone-elses-key' });

    const res = await request(await buildApp()).delete(`/api/v2/verify/${VID}/internal/data`);

    expect(res.status).toBe(404);
    expect(deletes()).toEqual([]);
  });
});
