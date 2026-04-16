import {describe, it, expect, vi, beforeEach} from 'vitest';

const mockUpsertJobScheduler = vi.fn().mockResolvedValue({});

vi.mock('bullmq', () => ({
  Queue: vi.fn().mockImplementation(function(name, opts) {
    this.name = name;
    this.upsertJobScheduler = mockUpsertJobScheduler;
    this.close = vi.fn();
  })
}));

import {CronManager} from '../src/cron/cronManager.js';

describe('CronManager', () => {
  beforeEach(() => {
    mockUpsertJobScheduler.mockClear();
  });

  it('should register cron jobs from config', async () => {
    const jobs = {
      dailyScan: {tier: 'heavy', timeout: 600000, cron: '0 0 * * *'},
      weeklyReport: {tier: 'light', timeout: 30000, cron: '0 0 * * 0'},
      noCronJob: {tier: 'medium', timeout: 30000}
    };

    const manager = new CronManager({});
    await manager.register(jobs, {leader: true});

    expect(mockUpsertJobScheduler).toHaveBeenCalledTimes(2);

    expect(mockUpsertJobScheduler).toHaveBeenCalledWith(
      'dailyScan',
      {pattern: '0 0 * * *'},
      expect.objectContaining({name: 'dailyScan'})
    );

    expect(mockUpsertJobScheduler).toHaveBeenCalledWith(
      'weeklyReport',
      {pattern: '0 0 * * 0'},
      expect.objectContaining({name: 'weeklyReport'})
    );
  });

  it('should skip jobs without cron field', async () => {
    const jobs = {
      regularJob: {tier: 'medium', timeout: 30000}
    };

    const manager = new CronManager({});
    await manager.register(jobs);

    expect(mockUpsertJobScheduler).not.toHaveBeenCalled();
  });

  it('should use correct tier queue for each cron job', async () => {
    const jobs = {
      heavyCron: {tier: 'heavy', timeout: 600000, cron: '0 0 * * *'}
    };

    const manager = new CronManager({});
    await manager.register(jobs, {leader: true});

    expect(mockUpsertJobScheduler).toHaveBeenCalledTimes(1);
  });

  it('should skip registration when leader is false', async () => {
    const {Queue} = await import('bullmq');
    Queue.mockClear();
    const cm = new CronManager({host: '127.0.0.1', port: 6379});
    const jobs = {
      cleanup: {tier: 'light', cron: '0 3 * * 0'}
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await cm.register(jobs, {leader: false});

    // No queue should have been constructed (since we early-return before _getQueue)
    expect(Queue).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('should register schedules when leader is true', async () => {
    const {Queue} = await import('bullmq');
    Queue.mockClear();
    const cm = new CronManager({host: '127.0.0.1', port: 6379});
    const jobs = {
      cleanup: {tier: 'light', cron: '0 3 * * 0'}
    };
    await cm.register(jobs, {leader: true});

    // Queue is constructed for the light tier
    expect(Queue).toHaveBeenCalled();
    const queueInstance = Queue.mock.instances[0];
    expect(queueInstance.upsertJobScheduler).toHaveBeenCalledWith(
      'cleanup',
      {pattern: '0 3 * * 0'},
      expect.any(Object)
    );
  });

  it('should warn when jobs have cron entries but leader is false', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cm = new CronManager({host: '127.0.0.1', port: 6379});
    const jobs = {
      cleanup: {tier: 'light', cron: '0 3 * * 0'},
      backup: {tier: 'medium', cron: '0 4 * * 0'}
    };
    await cm.register(jobs, {leader: false});

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('cron')
    );
    warn.mockRestore();
  });
});
