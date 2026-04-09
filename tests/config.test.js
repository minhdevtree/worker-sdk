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
});
