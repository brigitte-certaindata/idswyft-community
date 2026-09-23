import { describe, it, expect, vi } from 'vitest';

// Mock heavy dependencies so only the pure crypto helpers are exercised
vi.mock('@/config/database.js', () => ({
  supabase: { from: vi.fn() },
  connectDB: vi.fn(),
}));
vi.mock('@/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  logWebhookDelivery: vi.fn(),
}));
vi.mock('@/config/index.js', () => ({
  default: { webhooks: { retryAttempts: 3, timeoutMs: 5000 }, encryptionKey: 'test-encryption-key' },
}));
vi.mock('axios', () => ({ default: { post: vi.fn() } }));
vi.mock('@/utils/validateUrl.js', () => ({
  validateWebhookUrl: vi.fn().mockResolvedValue(undefined),
  getSafeHttpAgent: vi.fn(),
  getSafeHttpsAgent: vi.fn(),
  SsrfError: class SsrfError extends Error {},
}));

import axios from 'axios';
import { createWebhookSignature, verifyWebhookSignature, buildWebhookHeaders, WebhookService } from '../../services/webhook.js';
import { supabase } from '@/config/database.js';
import { validateWebhookUrl, SsrfError } from '@/utils/validateUrl.js';

const secret = 'test-secret-key-12345';
const payload = JSON.stringify({ event: 'verification.completed', data: {} });

describe('Webhook HMAC signing', () => {
  it('creates an HMAC-SHA256 signature in sha256=<hex> format', () => {
    const sig = createWebhookSignature(payload, secret);
    expect(sig).toMatch(/^sha256=[a-f0-9]{64}$/);
  });

  it('produces the same signature for the same input', () => {
    const sig1 = createWebhookSignature(payload, secret);
    const sig2 = createWebhookSignature(payload, secret);
    expect(sig1).toBe(sig2);
  });

  it('produces different signatures for different secrets', () => {
    const sig1 = createWebhookSignature(payload, 'secret-one');
    const sig2 = createWebhookSignature(payload, 'secret-two');
    expect(sig1).not.toBe(sig2);
  });

  it('verifies a valid signature', () => {
    const sig = createWebhookSignature(payload, secret);
    expect(verifyWebhookSignature(payload, sig, secret)).toBe(true);
  });

  it('rejects a tampered payload', () => {
    const sig = createWebhookSignature(payload, secret);
    const tampered = JSON.stringify({ event: 'verification.completed', data: { injected: true } });
    expect(verifyWebhookSignature(tampered, sig, secret)).toBe(false);
  });

  it('rejects a forged signature', () => {
    const forgery = 'sha256=' + 'a'.repeat(64);
    expect(verifyWebhookSignature(payload, forgery, secret)).toBe(false);
  });

  it('rejects signatures with mismatched length', () => {
    expect(verifyWebhookSignature(payload, 'sha256=tooshort', secret)).toBe(false);
  });
});

describe('buildWebhookHeaders', () => {
  it('sets X-Idswyft-Sandbox=true and verification-mode=sandbox for sandbox webhooks', () => {
    const headers = buildWebhookHeaders({ is_sandbox: true }, 'delivery-123', 1);
    expect(headers['X-Idswyft-Sandbox']).toBe('true');
    expect(headers['X-Idswyft-Verification-Mode']).toBe('sandbox');
  });

  it('sets X-Idswyft-Sandbox=false and verification-mode=production for production webhooks', () => {
    const headers = buildWebhookHeaders({ is_sandbox: false }, 'delivery-456', 1);
    expect(headers['X-Idswyft-Sandbox']).toBe('false');
    expect(headers['X-Idswyft-Verification-Mode']).toBe('production');
  });

  it('treats undefined is_sandbox as false (defensive default)', () => {
    const headers = buildWebhookHeaders({ is_sandbox: undefined as any }, 'delivery-x', 1);
    expect(headers['X-Idswyft-Sandbox']).toBe('false');
    expect(headers['X-Idswyft-Verification-Mode']).toBe('production');
  });

  it('preserves the existing required headers', () => {
    const headers = buildWebhookHeaders({ is_sandbox: false }, 'delivery-789', 2);
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['User-Agent']).toBe('Idswyft-Webhooks/1.0');
    expect(headers['X-Idswyft-Webhook-Id']).toBe('delivery-789');
    expect(headers['X-Idswyft-Delivery-Attempt']).toBe('2');
  });

  it('renders attempt as a string (header values must be strings)', () => {
    const headers = buildWebhookHeaders({ is_sandbox: false }, 'd', 3);
    expect(typeof headers['X-Idswyft-Delivery-Attempt']).toBe('string');
    expect(headers['X-Idswyft-Delivery-Attempt']).toBe('3');
  });

  // Service-key context headers (Phase 2) — emitted only when payload.is_service is true
  it('does NOT emit service-key headers when payload is omitted (regression: ik_* developer webhook)', () => {
    const headers = buildWebhookHeaders({ is_sandbox: false }, 'd', 1);
    expect(headers['X-Idswyft-Is-Service']).toBeUndefined();
    expect(headers['X-Idswyft-Service-Product']).toBeUndefined();
    expect(headers['X-Idswyft-Service-Environment']).toBeUndefined();
  });

  it('does NOT emit service-key headers when payload.is_service is false', () => {
    const headers = buildWebhookHeaders(
      { is_sandbox: false },
      'd',
      1,
      { is_service: false, service_product: null, service_environment: null },
    );
    expect(headers['X-Idswyft-Is-Service']).toBeUndefined();
    expect(headers['X-Idswyft-Service-Product']).toBeUndefined();
    expect(headers['X-Idswyft-Service-Environment']).toBeUndefined();
  });

  it('emits all three X-Idswyft-Service-* headers when is_service is true', () => {
    const headers = buildWebhookHeaders(
      { is_sandbox: false },
      'd',
      1,
      {
        is_service: true,
        service_product: 'gatepass',
        service_environment: 'production',
      },
    );
    expect(headers['X-Idswyft-Is-Service']).toBe('true');
    expect(headers['X-Idswyft-Service-Product']).toBe('gatepass');
    expect(headers['X-Idswyft-Service-Environment']).toBe('production');
  });

  it('omits Service-Product/Service-Environment when is_service=true but those fields are null', () => {
    const headers = buildWebhookHeaders(
      { is_sandbox: false },
      'd',
      1,
      { is_service: true, service_product: null, service_environment: null },
    );
    expect(headers['X-Idswyft-Is-Service']).toBe('true');
    expect(headers['X-Idswyft-Service-Product']).toBeUndefined();
    expect(headers['X-Idswyft-Service-Environment']).toBeUndefined();
  });
});

// community #58 part 2: the /test endpoint must NOT persist a webhook_deliveries
// row, or the NOT-NULL FK on verification_request_id rejects the insert and the
// test can never fire.
describe('WebhookService.sendTestWebhook', () => {
  const webhook: any = {
    id: 'wh-1',
    url: 'https://receiver.example.com/hook',
    is_sandbox: false,
    secret_key: 'a-plaintext-secret',
  };
  const payload: any = { user_id: 'u', verification_id: 'test', status: 'verified', timestamp: 't' };

  it('fires the POST without writing any webhook_deliveries row (no FK to hit)', async () => {
    vi.clearAllMocks();
    (axios.post as any).mockResolvedValue({ status: 200, data: { ok: true } });

    const res = await new WebhookService().sendTestWebhook(webhook, payload);

    expect(res).toEqual({ delivered: true, response_status: 200 });
    expect(axios.post).toHaveBeenCalledTimes(1);
    expect((axios.post as any).mock.calls[0][0]).toBe(webhook.url);
    // The critical assertion: no DB access at all, so the FK can't be triggered.
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it('signs the test payload and marks it as a test', async () => {
    vi.clearAllMocks();
    (axios.post as any).mockResolvedValue({ status: 200, data: {} });

    await new WebhookService().sendTestWebhook(webhook, payload);

    const headers = (axios.post as any).mock.calls[0][2].headers;
    expect(headers['X-Idswyft-Test']).toBe('true');
    expect(headers['X-Idswyft-Signature']).toMatch(/^sha256=[a-f0-9]{64}$/);
  });

  it('reports a non-2xx endpoint as not delivered instead of throwing', async () => {
    vi.clearAllMocks();
    (axios.post as any).mockResolvedValue({ status: 500, data: 'nope' });

    const res = await new WebhookService().sendTestWebhook(webhook, payload);
    expect(res.delivered).toBe(false);
    expect(res.response_status).toBe(500);
  });

  it('returns an SSRF reason without firing the POST when the URL is rejected', async () => {
    vi.clearAllMocks();
    (validateWebhookUrl as any).mockRejectedValueOnce(new SsrfError('private address'));

    const res = await new WebhookService().sendTestWebhook(webhook, payload);
    expect(res.delivered).toBe(false);
    expect(res.response_status).toBe(0);
    expect(res.error).toContain('SSRF');
    expect(axios.post).not.toHaveBeenCalled();
  });
});
