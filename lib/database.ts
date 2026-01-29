/**
 * Shared Database Configuration
 *
 * SINGLE SOURCE OF TRUTH for database connections in scripts.
 *
 * Priority order:
 * 1. DATABASE_URL (local postgres - preferred for speed)
 * 2. Default: postgresql://localhost/scanner_local
 *
 * Supabase is used for daily backups only, not live operations.
 *
 * Usage:
 *   import { getPool, transaction, healthCheck } from '../lib/database.js';
 *   const pool = getPool();
 *
 *   // Transactions
 *   await transaction(async (client) => {
 *     await client.query('INSERT INTO ...');
 *     await client.query('UPDATE ...');
 *   });
 *
 *   // Health checks
 *   const { ok, latencyMs } = await healthCheck();
 */

import { Pool, PoolClient, PoolConfig } from 'pg';
import pino from 'pino';

// Create module logger
const log = pino({
  level: process.env.LOG_LEVEL?.toLowerCase() || 'info',
  transport: process.env.NODE_ENV !== 'production'
    ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' } }
    : undefined,
}).child({ module: 'database' });

// Database URL resolution - Local takes priority for speed and consistency
export function getDatabaseUrl(): string {
  return process.env.DATABASE_URL || 'postgresql://localhost/scanner_local';
}

// Check if we're connected to Supabase
export function isSupabase(): boolean {
  const url = getDatabaseUrl();
  return url.includes('supabase') || url.includes('pooler.supabase');
}

// Get SSL config based on connection type
export function getSslConfig(): PoolConfig['ssl'] {
  if (isSupabase()) {
    // Validate SSL certs in production to prevent MITM attacks
    return { rejectUnauthorized: process.env.NODE_ENV === 'production' };
  }
  return undefined;
}

// Singleton pool instance
let _pool: Pool | null = null;
let _shutdownRegistered = false;

// Get or create pool instance
export function getPool(): Pool {
  if (!_pool) {
    const connectionString = getDatabaseUrl();
    _pool = new Pool({
      connectionString,
      ssl: getSslConfig(),
      max: parseInt(process.env.PG_POOL_MAX ?? '10', 10),
      min: 0,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: parseInt(process.env.PG_CONNECTION_TIMEOUT_MS ?? '10000', 10),
      statement_timeout: parseInt(process.env.PG_STATEMENT_TIMEOUT_MS ?? '30000', 10),
      keepAlive: true,
    });

    // Handle pool errors
    _pool.on('error', (err) => {
      log.error({ err }, 'Unexpected pool error on idle client');
    });

    // Log connection info
    const dbType = isSupabase() ? 'Supabase' : 'Local';
    const urlPreview = connectionString.includes('@')
      ? connectionString.split('@')[1]?.split('/')[0] || 'unknown'
      : 'localhost';
    log.info({ dbType, host: urlPreview }, 'Database pool initialized');

    // Register graceful shutdown handlers (once)
    if (!_shutdownRegistered) {
      setupGracefulShutdown();
      _shutdownRegistered = true;
    }
  }
  return _pool;
}

// Create a new pool with custom config (for special cases)
export function createPool(overrides?: Partial<PoolConfig>): Pool {
  const connectionString = getDatabaseUrl();
  return new Pool({
    connectionString,
    ssl: getSslConfig(),
    ...overrides,
  });
}

/**
 * Execute operations within a database transaction.
 * Automatically handles BEGIN, COMMIT, and ROLLBACK.
 *
 * @example
 * await transaction(async (client) => {
 *   await client.query('INSERT INTO orders(id) VALUES($1)', [orderId]);
 *   await client.query('UPDATE inventory SET qty = qty - 1 WHERE id = $1', [itemId]);
 * });
 */
export async function transaction<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Check database connectivity and measure latency.
 *
 * @returns Object with ok status and latency in milliseconds
 */
export async function healthCheck(): Promise<{ ok: boolean; latencyMs: number }> {
  const start = Date.now();
  try {
    const pool = getPool();
    await pool.query('SELECT 1');
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    log.error({ err }, 'Health check failed');
    return { ok: false, latencyMs: Date.now() - start };
  }
}

/**
 * Get current pool statistics for monitoring/debugging.
 */
export function poolStats(): { total: number; idle: number; waiting: number } {
  if (!_pool) {
    return { total: 0, idle: 0, waiting: 0 };
  }
  return {
    total: _pool.totalCount,
    idle: _pool.idleCount,
    waiting: _pool.waitingCount,
  };
}

// Graceful shutdown
export async function closePool(): Promise<void> {
  if (_pool) {
    log.info(poolStats(), 'Closing database pool');
    await _pool.end();
    _pool = null;
  }
}

// Setup graceful shutdown handlers
function setupGracefulShutdown(): void {
  const shutdown = async (signal: string) => {
    log.info({ signal }, 'Received shutdown signal');
    await closePool();
    process.exit(0);
  };

  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

// Export for CommonJS compatibility
export default {
  getPool,
  getDatabaseUrl,
  isSupabase,
  getSslConfig,
  createPool,
  closePool,
  transaction,
  healthCheck,
  poolStats,
};
