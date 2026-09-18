/**
 * Seed our internal service key (isk_*) at deploy time.
 *
 * Why this exists: upstream mints isk_* service keys only through a
 * cloud-only, portal-session-authenticated endpoint (see
 * middleware/auth.ts's generatePrefixedAPIKey doc comment — "service-key
 * minting endpoint for isk_* keys (Phase 5)"). That endpoint isn't present
 * in this community mirror, and this deployment doesn't mount the portal's
 * login routes either — so there is no UI path left to mint one. This
 * script is the deploy-time replacement: run it once per environment,
 * after `npm run migrate`, and it inserts the row directly.
 *
 * Usage:  npx tsx src/scripts/seedInternalKey.ts
 *    or:  npm run seed:internal-key
 *
 * Idempotent: safe to re-run. If an active internal service key already
 * exists for this environment, it does nothing and exits 0 — it does NOT
 * rotate or replace it (rotation, if ever needed, is a separate concern).
 *
 * IMPORTANT: the generated key is printed ONCE, to stdout, on first run.
 * Only its HMAC hash is persisted (same "shown once, hashed at rest"
 * property as every other credential in this system) — capture it into
 * Parameter Store / Secrets Manager immediately. There is no way to
 * retrieve it again; if it's lost, re-running this script will NOT mint a
 * replacement (see idempotency note above) — that requires manually
 * deactivating the old row first.
 */

import pg from 'pg';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import dotenv from 'dotenv';
import config from '../config/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, '../../.env') });

if (!process.env.DATABASE_URL) {
  console.error('❌ DATABASE_URL is not set — see backend/src/scripts/migrate.ts for how to set it.');
  process.exit(1);
}
const DATABASE_URL: string = process.env.DATABASE_URL;

// service_environment must satisfy the CHECK constraint added in
// supabase/migrations/58_add_service_keys.sql (production|staging|development).
// config.nodeEnv comes straight from NODE_ENV, which every other part of this
// app already assumes matches one of those three values (see server.ts's own
// `config.nodeEnv === 'production'` branches) — fail loudly here rather than
// let the INSERT hit the DB constraint with a less obvious error.
const SERVICE_ENVIRONMENT = config.nodeEnv;
const ALLOWED_ENVIRONMENTS = ['production', 'staging', 'development'];
if (!ALLOWED_ENVIRONMENTS.includes(SERVICE_ENVIRONMENT)) {
  console.error(
    `❌ NODE_ENV="${SERVICE_ENVIRONMENT}" is not one of ${ALLOWED_ENVIRONMENTS.join('|')} — ` +
    'set NODE_ENV explicitly before running this script.'
  );
  process.exit(1);
}

const SERVICE_PRODUCT = 'idswyft-internal'; // one of the two values migration 58 allows
const SHADOW_DEVELOPER_EMAIL = 'service+internal@idswyft.app'; // inserted by migration 58
const SERVICE_LABEL = `agentpay-internal-${SERVICE_ENVIRONMENT}`; // human-readable, shown in logs only — not a DB unique constraint

async function main() {
  // Same SSL/local-connection detection as migrate.ts — kept in sync
  // deliberately since both scripts connect to the same database the same way.
  const databaseSsl = process.env.DATABASE_SSL ?? process.env.DB_SSL;
  const isLocalConnection = DATABASE_URL.includes('localhost') ||
    DATABASE_URL.includes('127.0.0.1') ||
    DATABASE_URL.includes('@postgres:');
  const useSSL = databaseSsl !== 'false' && (databaseSsl === 'true' || !isLocalConnection);
  const rejectUnauthorized = process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false';
  const client = new pg.Client({
    connectionString: DATABASE_URL,
    ...(useSSL ? { ssl: { rejectUnauthorized } } : {}),
  });

  try {
    await client.connect();
    console.log('✅ Connected to database');

    // Idempotency check — do NOT rotate an existing key on re-run (see doc comment above).
    const { rows: existing } = await client.query(
      `SELECT id, key_prefix, created_at FROM api_keys
       WHERE is_service = TRUE AND is_active = TRUE
         AND service_product = $1 AND service_environment = $2`,
      [SERVICE_PRODUCT, SERVICE_ENVIRONMENT],
    );
    if (existing.length > 0) {
      console.log(
        `⏭️  An active internal service key already exists for ${SERVICE_ENVIRONMENT} ` +
        `(id=${existing[0].id}, prefix=${existing[0].key_prefix}, minted ${existing[0].created_at}). ` +
        'Nothing to do — this script does not rotate existing keys.'
      );
      return;
    }

    // Shadow developer row (migration 58, step 7) — required FK target.
    const { rows: shadowDev } = await client.query(
      `SELECT id FROM developers WHERE email = $1`,
      [SHADOW_DEVELOPER_EMAIL],
    );
    if (shadowDev.length === 0) {
      console.error(
        `❌ Shadow developer row "${SHADOW_DEVELOPER_EMAIL}" not found. ` +
        'Run `npm run migrate` first (supabase/migrations/58_add_service_keys.sql creates it).'
      );
      process.exit(1);
    }
    const developerId: string = shadowDev[0].id;

    // Same key-generation recipe as generatePrefixedAPIKey('isk') in
    // middleware/auth.ts — reimplemented here rather than imported, because
    // importing that module also pulls in config/database.ts, which throws
    // at import time if the DB env vars aren't shaped exactly like the main
    // app expects and additionally opens its own DB client — unnecessary
    // and risky for a one-shot deploy script that already manages its own
    // `pg.Client` above. Keep this block's algorithm identical to
    // generatePrefixedAPIKey if that function ever changes.
    const rawKey = `isk_${crypto.randomBytes(32).toString('hex')}`;
    const keyHash = crypto.createHmac('sha256', config.apiKeySecret).update(rawKey).digest('hex');
    const keyPrefix = rawKey.substring(0, 8);

    await client.query(
      `INSERT INTO api_keys
         (developer_id, key_hash, key_prefix, name, is_sandbox, is_active,
          is_service, service_product, service_environment, service_label)
       VALUES ($1, $2, $3, $4, FALSE, TRUE, TRUE, $5, $6, $7)`,
      [
        developerId,
        keyHash,
        keyPrefix,
        `AgentPay internal key (${SERVICE_ENVIRONMENT})`,
        SERVICE_PRODUCT,
        SERVICE_ENVIRONMENT,
        SERVICE_LABEL,
      ],
    );

    console.log('\n✅ Internal service key minted.');
    console.log(`   Environment:  ${SERVICE_ENVIRONMENT}`);
    console.log(`   Key prefix:   ${keyPrefix}`);
    console.log('\n   RAW KEY (shown once — capture into Parameter Store / Secrets Manager now):');
    console.log(`   ${rawKey}\n`);
    console.log('   Present it on capture-flow requests as:  X-API-Key: ' + rawKey);
  } finally {
    await client.end();
  }
}

main().catch(err => {
  console.error('❌ Seeding internal key failed:', err.message);
  process.exit(1);
});
