import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {loadConfig} from '../src/config/loader.js';
import {writeFileSync, mkdirSync, rmSync} from 'fs';
import {join} from 'path';
import {tmpdir} from 'os';

describe('ConfigLoader', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `worker-sdk-test-${Date.now()}`);
    mkdirSync(tmpDir, {recursive: true});
  });

  afterEach(() => {
    rmSync(tmpDir, {recursive: true, force: true});
  });

  it('should load YAML config with all sections', () => {
    const configPath = join(tmpDir, 'worker.config.yml');
    writeFileSync(configPath, `
redis:
  host: 127.0.0.1
  port: 6379
dashboard:
  port: 3800
  auth:
    username: admin
    password: secret
concurrency:
  heavy: 2
  medium: 5
  light: 10
jobs:
  testJob:
    tier: medium
    timeout: 30000
    retry:
      maxAttempts: 3
      baseDelay: 1000
`);

    const config = loadConfig(configPath);

    expect(config.redis).toEqual({host: '127.0.0.1', port: 6379});
    expect(config.dashboard.port).toBe(3800);
    expect(config.concurrency).toEqual({heavy: 2, medium: 5, light: 10});
    expect(config.jobs.testJob.tier).toBe('medium');
    expect(config.jobs.testJob.timeout).toBe(30000);
    expect(config.jobs.testJob.retry.maxAttempts).toBe(3);
  });

  it('should interpolate environment variables', () => {
    process.env.TEST_REDIS_HOST = 'redis.example.com';
    process.env.TEST_DASHBOARD_PASS = 'supersecret';

    const configPath = join(tmpDir, 'worker.config.yml');
    writeFileSync(configPath, `
redis:
  host: \${TEST_REDIS_HOST}
  port: 6379
dashboard:
  port: 3800
  auth:
    username: admin
    password: \${TEST_DASHBOARD_PASS}
concurrency:
  heavy: 2
  medium: 5
  light: 10
jobs: {}
`);

    const config = loadConfig(configPath);

    expect(config.redis.host).toBe('redis.example.com');
    expect(config.dashboard.auth.password).toBe('supersecret');

    delete process.env.TEST_REDIS_HOST;
    delete process.env.TEST_DASHBOARD_PASS;
  });

  it('should apply default concurrency if not specified', () => {
    const configPath = join(tmpDir, 'worker.config.yml');
    writeFileSync(configPath, `
redis:
  host: 127.0.0.1
  port: 6379
jobs: {}
`);

    const config = loadConfig(configPath);

    expect(config.concurrency).toEqual({heavy: 2, medium: 5, light: 10});
  });

  it('should throw if config file does not exist', () => {
    expect(() => loadConfig('/nonexistent/path.yml')).toThrow();
  });

  it('should return job tier mapping', () => {
    const configPath = join(tmpDir, 'worker.config.yml');
    writeFileSync(configPath, `
redis:
  host: 127.0.0.1
  port: 6379
jobs:
  heavyJob:
    tier: heavy
    timeout: 60000
  lightJob:
    tier: light
    timeout: 5000
`);

    const config = loadConfig(configPath);

    expect(config.jobs.heavyJob.tier).toBe('heavy');
    expect(config.jobs.lightJob.tier).toBe('light');
  });

  it('should load logging.loki config with defaults', () => {
    const configPath = join(tmpDir, 'worker.config.yml');
    writeFileSync(configPath, `
redis:
  host: 127.0.0.1
  port: 6379
logging:
  dir: ./logs
  retentionDays: 7
  loki:
    url: http://loki:3100
    batchSize: 100
    flushInterval: 5000
    labels:
      app: seo-worker
      env: production
jobs: {}
`);

    const config = loadConfig(configPath);

    expect(config.logging.loki).toEqual({
      url: 'http://loki:3100',
      batchSize: 100,
      flushInterval: 5000,
      labels: {app: 'seo-worker', env: 'production'}
    });
  });

  it('should treat empty loki.url as loki disabled', () => {
    const configPath = join(tmpDir, 'worker.config.yml');
    writeFileSync(configPath, `
redis:
  host: 127.0.0.1
  port: 6379
logging:
  dir: ./logs
  loki:
    url: ''
jobs: {}
`);

    const config = loadConfig(configPath);

    expect(config.logging.loki).toBeUndefined();
  });

  it('should interpolate LOKI_URL env var', () => {
    process.env.TEST_LOKI_URL = 'http://my-loki:3100';

    const configPath = join(tmpDir, 'worker.config.yml');
    writeFileSync(configPath, `
redis:
  host: 127.0.0.1
  port: 6379
logging:
  dir: ./logs
  loki:
    url: \${TEST_LOKI_URL}
jobs: {}
`);

    const config = loadConfig(configPath);
    expect(config.logging.loki.url).toBe('http://my-loki:3100');

    delete process.env.TEST_LOKI_URL;
  });

  it('should coerce string batchSize and flushInterval from env vars', () => {
    process.env.TEST_BATCH_SIZE = '250';
    process.env.TEST_FLUSH_INT = '8000';

    const configPath = join(tmpDir, 'worker.config.yml');
    writeFileSync(configPath, `
redis:
  host: 127.0.0.1
  port: 6379
logging:
  dir: ./logs
  loki:
    url: http://loki:3100
    batchSize: \${TEST_BATCH_SIZE}
    flushInterval: \${TEST_FLUSH_INT}
jobs: {}
`);

    const config = loadConfig(configPath);
    expect(config.logging.loki.batchSize).toBe(250);
    expect(config.logging.loki.flushInterval).toBe(8000);

    delete process.env.TEST_BATCH_SIZE;
    delete process.env.TEST_FLUSH_INT;
  });

  it('should throw on invalid (non-numeric) loki.batchSize', () => {
    process.env.TEST_BAD_BATCH = 'not-a-number';

    const configPath = join(tmpDir, 'worker.config.yml');
    writeFileSync(configPath, `
redis:
  host: 127.0.0.1
  port: 6379
logging:
  dir: ./logs
  loki:
    url: http://loki:3100
    batchSize: \${TEST_BAD_BATCH}
jobs: {}
`);

    expect(() => loadConfig(configPath)).toThrow(/Invalid loki.batchSize/);

    delete process.env.TEST_BAD_BATCH;
  });

  it('should parse worker block with auto-gen workerId when id empty', () => {
    const configPath = join(tmpDir, 'worker.config.yml');
    writeFileSync(configPath, `
redis:
  host: 127.0.0.1
  port: 6379
worker:
  id:
  heartbeat:
    enabled: true
    intervalMs: 10000
    ttlMs: 30000
jobs: {}
`);
    const config = loadConfig(configPath);
    expect(config.worker.id).toBeFalsy(); // engine computes at runtime
    expect(config.worker.heartbeat).toEqual({
      enabled: true,
      intervalMs: 10000,
      ttlMs: 30000
    });
  });

  it('should apply heartbeat defaults when worker block omits them', () => {
    const configPath = join(tmpDir, 'worker.config.yml');
    writeFileSync(configPath, `
redis:
  host: 127.0.0.1
  port: 6379
worker:
  id: custom-id
jobs: {}
`);
    const config = loadConfig(configPath);
    expect(config.worker.id).toBe('custom-id');
    expect(config.worker.heartbeat).toEqual({
      enabled: true,
      intervalMs: 10000,
      ttlMs: 30000
    });
  });

  it('should coerce heartbeat numbers from env strings and reject NaN', () => {
    const configPath = join(tmpDir, 'worker.config.yml');
    writeFileSync(configPath, `
redis:
  host: 127.0.0.1
  port: 6379
worker:
  heartbeat:
    intervalMs: "5000"
    ttlMs: "15000"
jobs: {}
`);
    const config = loadConfig(configPath);
    expect(config.worker.heartbeat.intervalMs).toBe(5000);
    expect(config.worker.heartbeat.ttlMs).toBe(15000);

    writeFileSync(configPath, `
redis:
  host: 127.0.0.1
  port: 6379
worker:
  heartbeat:
    intervalMs: notanumber
jobs: {}
`);
    expect(() => loadConfig(configPath)).toThrow(/intervalMs/i);
  });

  it('should reject heartbeat intervalMs <= 0', () => {
    const configPath = join(tmpDir, 'worker.config.yml');
    writeFileSync(configPath, `
redis:
  host: 127.0.0.1
  port: 6379
worker:
  heartbeat:
    intervalMs: 0
    ttlMs: 30000
jobs: {}
`);
    expect(() => loadConfig(configPath)).toThrow(/intervalMs.*> 0/i);
  });

  it('should reject intervalMs >= ttlMs', () => {
    const configPath = join(tmpDir, 'worker.config.yml');
    writeFileSync(configPath, `
redis:
  host: 127.0.0.1
  port: 6379
worker:
  heartbeat:
    intervalMs: 30000
    ttlMs: 30000
jobs: {}
`);
    expect(() => loadConfig(configPath)).toThrow(/intervalMs.*ttlMs/i);
  });

  it('should coerce cron.leader from env string', () => {
    const configPath = join(tmpDir, 'worker.config.yml');
    writeFileSync(configPath, `
redis:
  host: 127.0.0.1
  port: 6379
cron:
  leader: "true"
jobs: {}
`);
    expect(loadConfig(configPath).cron.leader).toBe(true);

    writeFileSync(configPath, `
redis:
  host: 127.0.0.1
  port: 6379
cron:
  leader: "false"
jobs: {}
`);
    expect(loadConfig(configPath).cron.leader).toBe(false);
  });

  it('should default cron.leader to false when cron block absent', () => {
    const configPath = join(tmpDir, 'worker.config.yml');
    writeFileSync(configPath, `
redis:
  host: 127.0.0.1
  port: 6379
jobs: {}
`);
    expect(loadConfig(configPath).cron.leader).toBe(false);
  });
});
