# @minhdevtree/worker-sdk

Self-hosted background job runner powered by BullMQ + Redis. Replace Firebase Cloud Functions with a simple, local job queue.

## Features

- **Tier-based concurrency** — heavy/medium/light queues with configurable limits
- **Cron jobs** — first-class scheduled job support via BullMQ repeatable jobs
- **Bull Board dashboard** — built-in web UI for inspecting jobs, retries, errors
- **TLS Redis support** — connect to remote Redis over TLS (production-ready)
- **Env-driven config** — single YAML works across local dev and production
- **Console capture** — `console.log/warn/error` inside handlers automatically appears in Bull Board
- **Readable job IDs** — `{jobName}-{uuid}` format
- **Graceful shutdown** — drains in-flight jobs on SIGTERM/SIGINT

## Install

```bash
npm install @minhdevtree/worker-sdk
```

Requires Node.js >= 20 and a Redis instance you can reach.

## Quick Start

### 1. Create config

`worker.config.yml`:

```yaml
redis:
  host: ${REDIS_HOST:-127.0.0.1}
  port: ${REDIS_PORT:-6379}
  password: ${REDIS_PASSWORD:-}
  tls: ${REDIS_TLS:-}

logging:
  dir: ./logs                        # local file buffer (short retention)
  retentionDays: 7
  loki:                              # optional — ship to Loki for long-term search
    url: ${LOKI_URL:-}
    batchSize: 100
    flushInterval: 5000
    labels:
      app: my-app
      env: production

dashboard:
  port: 3800
  auth:
    username: admin
    password: ${WORKER_DASHBOARD_PASSWORD}

concurrency:
  heavy: 2
  medium: 5
  light: 10

jobs:
  processOrder:
    tier: heavy
    timeout: 60000
    retry:
      maxAttempts: 3
      baseDelay: 2000

  sendNotification:
    tier: light
    timeout: 10000

  dailyReport:
    tier: medium
    timeout: 300000
    cron: "0 0 * * *"
```

YAML supports `${VAR}` and `${VAR:-default}` env interpolation. The same file can run locally (defaults to `127.0.0.1`) or in production (override via env vars).

### 2. Define handlers

```js
// jobs/processOrder.js
export async function execute(payload, context) {
  const {logger, signal, jobId, attempt} = context;

  logger.info('Processing order', {orderId: payload.orderId});

  // console.log/warn/error inside this function (and any code it calls)
  // is automatically captured to Bull Board logs
  console.log('Doing some work...');

  return {success: true};
}
```

### 3. Start worker

```js
// worker.mjs
import {createWorker} from '@minhdevtree/worker-sdk';
import {execute as processOrder} from './jobs/processOrder.js';
import {execute as sendNotification} from './jobs/sendNotification.js';
import {execute as dailyReport} from './jobs/dailyReport.js';

const worker = createWorker('./worker.config.yml');

worker.register('processOrder', processOrder);
worker.register('sendNotification', sendNotification);
worker.register('dailyReport', dailyReport);

await worker.start();
```

Run it: `node worker.mjs`

### 4. Push jobs from your app

```js
import {createClient} from '@minhdevtree/worker-sdk';

const client = createClient('./worker.config.yml');

await client.add('processOrder', {orderId: 42});
// → returns {id: "processOrder-e7a3b5c2-3a4f-..."}
```

The client is lightweight — only creates BullMQ Queue instances on demand. Safe to import anywhere in your app backend.

### 5. Run dashboard as a separate service (recommended)

```js
// dashboard.mjs
import {createDashboard} from '@minhdevtree/worker-sdk';

const dashboard = createDashboard('./worker.config.yml');
await dashboard.start();
```

Run it: `node dashboard.mjs`

Running the dashboard as its own process means it stays up even when workers restart, and a single dashboard can serve any number of workers (they all share Redis).

## Tiers

Jobs are grouped by resource weight. Each tier maps to a separate BullMQ Worker with its own concurrency limit:

| Tier | Default Concurrency | Use case |
|------|-------------------|----------|
| heavy | 2 | CPU/memory intensive work — bulk API calls, image processing |
| medium | 5 | Moderate processing — page scanning, batch operations |
| light | 10 | Quick tasks — status updates, notifications |

Override defaults in `worker.config.yml`:

```yaml
concurrency:
  heavy: 3
  medium: 10
  light: 20
```

## Dashboard

Bull Board UI mounted at `http://localhost:3800` (port configurable). Features:

- View all queues with job counts
- Filter jobs by status (completed/failed/waiting/active/delayed)
- Inspect payload, result, logs, error/stack trace
- Retry/delete/promote individual jobs
- View repeatable cron schedules

Basic auth is required — set `username` and `password` in config.

## Handler Context

```js
export async function execute(payload, context) {
  context.jobId    // unique job ID — format: jobName-uuid
  context.attempt  // current attempt number (1-based)
  context.logger   // {info, warn, error} — writes to Bull Board + stdout + log file
  context.signal   // AbortSignal — fires when timeout expires
}
```

## File Logging

When `logging.dir` is configured, all job logs are written to daily JSON line files on disk:

```
logs/
  2026-04-14.log
  2026-04-13.log
  ...
```

Each line is a JSON object:

```json
{"ts":"2026-04-14T10:30:00.123Z","job":"processOrder","id":"processOrder-abc123","level":"INFO","msg":"Processing","data":{"orderId":42}}
```

Both `context.logger.info/warn/error` and captured `console.log/warn/error` are written.

Local files act as a short-term buffer — set `retentionDays` to how many days you want to keep on disk (e.g. 7). Old files are auto-deleted on worker startup. For long-term archive, configure `logging.loki` to ship logs to Grafana Loki (see below).

Search with grep:

```bash
# All errors from a specific day
grep '"ERROR"' logs/2026-04-14.log

# Everything for a specific job ID
grep 'processOrder-abc123' logs/2026-04-14.log

# Search across multiple days
grep 'shopId.*xyz' logs/2026-04-*.log
```

For Docker deployments, mount the logs directory as a volume so files persist on the host:

```yaml
volumes:
  - ./logs:/app/functions/logs
```

## Cron Jobs

Add a `cron` field to any job in the config. The SDK registers it as a BullMQ repeatable job — schedule survives restarts.

```yaml
jobs:
  dailyReport:
    tier: medium
    timeout: 300000
    cron: "0 0 * * *"        # every day at midnight
```

The handler is registered like any other job — same `execute(payload, context)` signature.

## Env Variables

| Variable | Required | Description |
|---|---|---|
| `WORKER_DASHBOARD_PASSWORD` | Yes | Bull Board dashboard password |
| `REDIS_HOST` | No | Defaults to YAML config |
| `REDIS_PORT` | No | Defaults to YAML config |
| `REDIS_PASSWORD` | No | Defaults to YAML config |
| `REDIS_TLS` | No | Set to `true` to enable TLS |

Any field in `worker.config.yml` can be made env-driven via `${VAR_NAME:-default}` syntax.

## Long-term log search with Loki

This SDK configures BullMQ to retain only the last ~1000 completed jobs in Redis (`removeOnComplete`). For long-term historical search (weeks or months), configure Loki:

```yaml
logging:
  loki:
    url: http://loki:3100
    batchSize: 100
    flushInterval: 5000
    labels:
      app: my-app
```

The SDK will push every log entry (both `context.logger.*` and captured `console.*`) to Loki in batches. Use Grafana to search by job name, level, shop ID, date range.

If `loki.url` is empty or missing, Loki shipping is disabled — the SDK falls back to file-only logging.

Log retention in Loki is controlled by the Loki server's own `retention_period` config, not by the SDK.

**Setup your Loki stack** — see [SETUP.md](./SETUP.md) for a Docker Compose example that runs Loki + Grafana alongside the worker.

## Multi-worker deployments

A single Redis + Loki + Bull Board can serve any number of workers. Scale horizontally on one machine (`docker compose up --scale`) or across hosts.

### Identity and specialization

```yaml
# worker.config.yml
worker:
  id: ${WORKER_ID:-}              # empty → auto-generated ${hostname}-${pid}

concurrency:
  heavy: 2
  medium: 5
  light: 0                        # 0 = opt out — this worker skips the light tier
```

Each worker gets its own ID. In Docker Compose `--scale N` mode the auto-generated default (`${hostname}-${pid}`) gives meaningful IDs because Docker assigns unique hostnames per replica. For multi-host deployments set `WORKER_ID=mac-mini` / `WORKER_ID=vps-hanoi` per host so Grafana labels stay readable.

Tier opt-out via `concurrency: 0` enables heterogeneous pools: a beefy box can be heavy-only, a small box can be light-only. BullMQ distributes jobs atomically — a worker that doesn't subscribe to a tier never pulls from it.

### Liveness: heartbeats

```yaml
worker:
  heartbeat:
    enabled: true                 # default
    intervalMs: 10000             # beat every 10s
    ttlMs: 30000                  # key expires after 30s of silence
```

Every worker writes a TTL'd key `worker:heartbeat:<workerId>` to Redis on the interval. If a worker dies or loses Redis connectivity, the key expires automatically. Enumerate live workers:

```js
import {listWorkers} from '@minhdevtree/worker-sdk';
import Redis from 'ioredis';

const redis = new Redis({host, port, password});
const workers = await listWorkers(redis);
// → [{workerId, hostname, pid, tiers, startedAt, lastBeat}, ...]
```

### Health checks

Four admin helpers for monitoring cluster state:

```js
import {
  pingRedis,
  getQueueDepths,
  checkDashboard,
  getClusterHealth
} from '@minhdevtree/worker-sdk';

// Redis PING + latency
await pingRedis(redis);
// → {ok: true, latencyMs: 3}

// Per-tier queue depth (waiting/active/delayed/completed/failed/paused + total)
// Each tier reports its own ok flag — a per-tier failure doesn't abort the others.
await getQueueDepths(redis, ['heavy', 'medium', 'light']);
// → {heavy: {ok: true, waiting: 2, active: 1, ..., total: 3}, ...}

// Dashboard /health endpoint probe (no auth)
await checkDashboard('http://host:3800');
// → {ok: true, latencyMs: 12, status: 200, uptime: 1234, timestamp: '...'}

// One-shot aggregate: runs all probes in parallel
await getClusterHealth({
  redis,
  tiers: ['heavy', 'medium', 'light'],   // optional
  dashboardUrl: 'http://host:3800',      // optional
  timeouts: {                            // optional — defaults shown
    redisMs: 2000,
    workersMs: 5000,
    queuesMs: 5000,
    dashboardMs: 3000
  }
});
// → {ok, status: 'healthy'|'degraded'|'unhealthy', checkedAt, redis,
//    workers: {count, items}, queues: {byTier}, dashboard}
```

`getClusterHealth` doesn't short-circuit — a failure in one probe reports `ok: false` for that section but still returns the others. Top-level `ok` is true only if every probed section is ok. The `status` field classifies the rollup: `healthy` (everything ok), `unhealthy` (Redis itself is down — the critical dependency), or `degraded` (Redis ok but at least one other section failed).

`checkDashboard` validates that `baseUrl` parses and uses `http:` or `https:`, sets `redirect: 'manual'`, and rejects responses larger than 64 KiB. These are basic SSRF guards — if you wire `baseUrl` to user input, add your own allow-list on top.

### Scheduled jobs: the cron leader

```yaml
cron:
  leader: ${CRON_LEADER:-false}   # EXACTLY ONE worker should set this to true
```

In a multi-worker pool exactly one worker should be designated the cron leader. Only that worker registers scheduled jobs — others skip registration. If no worker has `cron.leader: true` and your `jobs` config includes cron entries, the SDK warns on startup and scheduled jobs do not fire.

For a pool of three, one compose-file pattern:

```yaml
services:
  worker-leader:
    environment: {CRON_LEADER: "true"}
    # one replica, always on
  worker:
    environment: {CRON_LEADER: "false"}
    # scale this service: docker compose up -d --scale worker=N
```

### Filtering per worker in Grafana

Every log pushed to Loki carries the `workerId` label automatically:

```logql
# just worker-2's logs
{app="my-app", workerId="mac-mini-2"}

# errors from any worker
{app="my-app", level="ERROR"}

# cross-worker comparison by job name
{app="my-app", job="generateAnchor"} | json
```

## Migration from Firebase Pub/Sub

| Before (Firebase) | After (Worker SDK) |
|---|---|
| `functions.runWith({memory, timeout})` | `worker.config.yml` job entry |
| `.pubsub.topic('name').onPublish(fn)` | `worker.register('name', execute)` |
| `JSON.parse(Buffer.from(message.data))` | `payload` (already parsed) |
| `console.log()` | Works as-is — captured to Bull Board |
| `publishTopic('next', data)` | `client.add('next', data)` |
| Runs on Google Cloud | Runs on your machine |

See `SETUP.md` for the full integration guide with handler structure, file layout, and migration steps.
