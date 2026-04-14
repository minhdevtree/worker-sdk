import {mkdirSync, appendFileSync, readdirSync, unlinkSync, statSync} from 'fs';
import {join} from 'path';

/**
 * File logger that writes structured JSON lines to daily log files.
 * Thread-safe via appendFileSync (atomic append on most OS).
 */
export class FileLogger {
  /**
   * @param {object} options
   * @param {string} options.dir - Directory to write log files
   * @param {number} [options.retentionDays=30] - Delete log files older than this
   */
  constructor({dir, retentionDays = 30}) {
    this._dir = dir;
    this._retentionDays = retentionDays;

    mkdirSync(dir, {recursive: true});
  }

  /**
   * Write a log entry to today's file.
   * @param {object} entry - {job, id, level, msg, data}
   */
  write(entry) {
    const now = new Date();
    const filename = `${formatDate(now)}.log`;
    const filepath = join(this._dir, filename);

    const line = JSON.stringify({
      ts: now.toISOString(),
      job: entry.job,
      id: entry.id,
      level: entry.level,
      msg: entry.msg,
      ...(entry.data ? {data: entry.data} : {})
    }) + '\n';

    try {
      appendFileSync(filepath, line);
    } catch (err) {
      // Don't crash the worker if log write fails
      process.stderr.write(`[worker-sdk] Failed to write log file: ${err.message}\n`);
    }
  }

  /**
   * Delete log files older than retentionDays.
   */
  cleanup() {
    if (!this._retentionDays) return;

    const cutoff = Date.now() - this._retentionDays * 24 * 60 * 60 * 1000;

    try {
      const files = readdirSync(this._dir).filter(f => f.endsWith('.log'));

      for (const file of files) {
        const filepath = join(this._dir, file);
        const stat = statSync(filepath);
        if (stat.mtimeMs < cutoff) {
          unlinkSync(filepath);
        }
      }
    } catch (err) {
      process.stderr.write(`[worker-sdk] Log cleanup failed: ${err.message}\n`);
    }
  }
}

function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
