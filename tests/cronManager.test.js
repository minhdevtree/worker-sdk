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
    await manager.register(jobs);

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
    await manager.register(jobs);

    expect(mockUpsertJobScheduler).toHaveBeenCalledTimes(1);
  });
});
