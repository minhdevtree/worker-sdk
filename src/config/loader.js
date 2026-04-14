import {readFileSync} from 'fs';
import yaml from 'js-yaml';

const DEFAULT_CONCURRENCY = {heavy: 2, medium: 5, light: 10};

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

  normalizeRedisOptions(config.redis);

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
