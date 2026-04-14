import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {FileLogger} from '../src/logging/fileLogger.js';
import {readFileSync, mkdirSync, rmSync, readdirSync, writeFileSync, utimesSync} from 'fs';
import {join} from 'path';
import {tmpdir} from 'os';

describe('FileLogger', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `worker-sdk-filelog-${Date.now()}`);
    mkdirSync(tmpDir, {recursive: true});
  });

  afterEach(() => {
    rmSync(tmpDir, {recursive: true, force: true});
  });

  it('should create a daily log file with JSON lines', () => {
    const logger = new FileLogger({dir: tmpDir});

    logger.write({job: 'testJob', id: 'job-1', level: 'INFO', msg: 'hello'});
    logger.write({job: 'testJob', id: 'job-1', level: 'ERROR', msg: 'failed', data: {err: 'oops'}});

    const today = new Date().toISOString().slice(0, 10);
    const content = readFileSync(join(tmpDir, `${today}.log`), 'utf-8');
    const lines = content.trim().split('\n').map(l => JSON.parse(l));

    expect(lines.length).toBe(2);
    expect(lines[0].job).toBe('testJob');
    expect(lines[0].level).toBe('INFO');
    expect(lines[0].msg).toBe('hello');
    expect(lines[0].ts).toBeDefined();
    expect(lines[1].level).toBe('ERROR');
    expect(lines[1].data).toEqual({err: 'oops'});
  });

  it('should clean up files older than retentionDays', () => {
    const logger = new FileLogger({dir: tmpDir, retentionDays: 7});

    // Create a fake old log file
    const oldFile = join(tmpDir, '2020-01-01.log');
    writeFileSync(oldFile, 'old data\n');
    // Set mtime to 30 days ago
    const oldTime = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    utimesSync(oldFile, oldTime, oldTime);

    // Create a recent file
    const recentFile = join(tmpDir, '2026-04-14.log');
    writeFileSync(recentFile, 'recent data\n');

    logger.cleanup();

    const remaining = readdirSync(tmpDir);
    expect(remaining).not.toContain('2020-01-01.log');
    expect(remaining).toContain('2026-04-14.log');
  });

  it('should not crash if log directory becomes unwritable', () => {
    const logger = new FileLogger({dir: tmpDir});

    // Remove the dir to simulate failure
    rmSync(tmpDir, {recursive: true, force: true});

    // Should not throw — fails silently
    expect(() => {
      logger.write({job: 'x', id: '1', level: 'INFO', msg: 'test'});
    }).not.toThrow();

    // Recreate for afterEach cleanup
    mkdirSync(tmpDir, {recursive: true});
  });
});
