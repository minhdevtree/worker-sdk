import {readFileSync} from 'fs';
import yaml from 'js-yaml';

const DEFAULT_CONCURRENCY = {heavy: 2, medium: 5, light: 10};
const DEFAULT_HEARTBEAT_INTERVAL_MS = 10000;
const DEFAULT_HEARTBEAT_TTL_MS = 30000;

/**
 * Load and parse YAML config with environment variable interpolation.
 * @param {string} configPath - Path to the YAML config file
 * @returns {object} Parsed config
 */
export function loadConfig(configPath) {
  const raw = readFileSync(configPath, 'utf-8');
  const interpolated = interpolateEnv(raw);
  const config = yaml.load(interpolated);

  config.concurrency = {...DEFAULT_CONCURRENCY, ...config.concurrency};
  config.dashboard = config.dashboard || {};
  config.jobs = config.jobs || {};

  config.worker = config.worker || {};
  config.cron = config.cron || {};

  normalizeRedisOptions(config.redis);
  normalizeLokiOptions(config.logging);
  normalizeWorkerOptions(config.worker);
  normalizeCronOptions(config.cron);

  // Validate Redis config exists after normalization
  if (!config.redis || (!config.redis.host && !config.redis.port)) {
    throw new Error(
      'worker.config.yml: redis config is required. Set redis.host/port in YAML or via REDIS_HOST/REDIS_PORT env vars.'
    );
  }

  return config;
}

/**
 * Normalize Redis connection options after env interpolation.
 * - Strip empty/null fields (when env var is unset, YAML parses ${VAR:-} as null)
 * - Coerce port from string to number (env vars are always strings)
 * - Convert tls: "true" to {} (enables TLS); empty/null/false removes the key
 */
function normalizeRedisOptions(redis) {
  if (!redis) return;

  // Drop empty/null fields so they don't override ioredis defaults
  for (const key of Object.keys(redis)) {
    if (key === 'tls') continue; // tls is handled below
    if (redis[key] === null || redis[key] === '' || redis[key] === undefined) {
      delete redis[key];
    }
  }

  if (typeof redis.port === 'string') {
    const parsed = parseInt(redis.port, 10);
    if (Number.isNaN(parsed)) throw new Error(`Invalid redis.port: "${redis.port}"`);
    redis.port = parsed;
  }

  // Empty/null/false → no TLS
  if (
    redis.tls === undefined ||
    redis.tls === null ||
    redis.tls === '' ||
    redis.tls === 'false' ||
    redis.tls === false
  ) {
    delete redis.tls;
  } else if (redis.tls === 'true' || redis.tls === true) {
    redis.tls = {};
  }
  // If redis.tls is already an object, leave it alone (advanced TLS config)
}

/**
 * Normalize logging.loki options after env interpolation.
 * - Remove loki block entirely if url is empty (keeps SDK in file-only mode).
 * - Coerce batchSize and flushInterval from string to number (env vars are always strings).
 * - Apply defaults: batchSize=100, flushInterval=5000.
 */
function normalizeLokiOptions(logging) {
  if (!logging || !logging.loki) return;

  const loki = logging.loki;

  // Empty url = Loki disabled
  if (!loki.url) {
    delete logging.loki;
    return;
  }

  if (typeof loki.batchSize === 'string') {
    const parsed = parseInt(loki.batchSize, 10);
    if (Number.isNaN(parsed)) throw new Error(`Invalid loki.batchSize: "${loki.batchSize}"`);
    loki.batchSize = parsed;
  }
  if (typeof loki.flushInterval === 'string') {
    const parsed = parseInt(loki.flushInterval, 10);
    if (Number.isNaN(parsed)) throw new Error(`Invalid loki.flushInterval: "${loki.flushInterval}"`);
    loki.flushInterval = parsed;
  }

  // Defaults (use ?? to preserve valid 0 / false values)
  loki.batchSize = loki.batchSize ?? 100;
  loki.flushInterval = loki.flushInterval ?? 5000;
  loki.labels = loki.labels ?? {};
}

/**
 * Normalize worker options after env interpolation.
 * - Apply heartbeat defaults (enabled=true, intervalMs=10000, ttlMs=30000)
 * - Coerce intervalMs/ttlMs from string to number
 * - Coerce enabled from string to boolean
 * - Validate intervalMs < ttlMs (else key expires between beats)
 */
function normalizeWorkerOptions(worker) {
  worker.heartbeat = worker.heartbeat || {};
  const hb = worker.heartbeat;

  // enabled: boolean coercion from string env var
  if (hb.enabled === 'true' || hb.enabled === true) hb.enabled = true;
  else if (hb.enabled === 'false' || hb.enabled === false) hb.enabled = false;
  else hb.enabled = true; // default

  // intervalMs
  if (typeof hb.intervalMs === 'string') {
    const parsed = parseInt(hb.intervalMs, 10);
    if (Number.isNaN(parsed)) throw new Error(`Invalid worker.heartbeat.intervalMs: "${hb.intervalMs}"`);
    hb.intervalMs = parsed;
  }
  hb.intervalMs = hb.intervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;

  // ttlMs
  if (typeof hb.ttlMs === 'string') {
    const parsed = parseInt(hb.ttlMs, 10);
    if (Number.isNaN(parsed)) throw new Error(`Invalid worker.heartbeat.ttlMs: "${hb.ttlMs}"`);
    hb.ttlMs = parsed;
  }
  hb.ttlMs = hb.ttlMs ?? DEFAULT_HEARTBEAT_TTL_MS;

  if (hb.intervalMs <= 0) {
    throw new Error(
      `worker.heartbeat.intervalMs must be > 0 (got ${hb.intervalMs}); ` +
      'a 0 or negative interval would tight-loop or never fire'
    );
  }
  if (hb.ttlMs <= 0) {
    throw new Error(
      `worker.heartbeat.ttlMs must be > 0 (got ${hb.ttlMs}); ` +
      'a 0 or negative TTL would expire the key immediately'
    );
  }

  if (hb.intervalMs >= hb.ttlMs) {
    throw new Error(
      `worker.heartbeat.intervalMs (${hb.intervalMs}) must be less than ttlMs (${hb.ttlMs}); ` +
      'otherwise the heartbeat key expires between beats'
    );
  }
}

/**
 * Normalize cron options after env interpolation.
 * - Coerce leader from string to boolean; default false
 */
function normalizeCronOptions(cron) {
  // Strict: only "true" / true become true. Any other value (including typos
  // like "yes" / "1") becomes false — be explicit in your config.
  if (cron.leader === 'true' || cron.leader === true) cron.leader = true;
  else cron.leader = false;
}

/**
 * Replace ${VAR_NAME} with process.env.VAR_NAME.
 * Supports default values: ${VAR_NAME:-default_value}
 */
function interpolateEnv(str) {
  return str.replace(/\$\{(\w+)(?::-([^}]*))?\}/g, (match, varName, defaultValue) => {
    const value = process.env[varName];
    if (value !== undefined) return value;
    if (defaultValue !== undefined) return defaultValue;
    return match;
  });
}
