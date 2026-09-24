# Axios Interceptor Logger (Packetbeat ECS Format)

An advanced Axios interceptor that captures and logs HTTP transactions at the application layer. By hooking directly into Axios, this logger captures **decrypted HTTPS traffic** and formats it natively into the **Elastic Common Schema (ECS)**, perfectly mirroring the JSON structure of network sniffers like Packetbeat.

This allows you to inject application-layer traffic directly into Elasticsearch/Kibana alongside your raw network metrics without requiring complex Logstash mapping!

## Features

- 🔐 **Native HTTPS Interception**: Logs exact request and response payloads, completely bypassing TLS encryption limitations.
- 🔄 **Packetbeat ECS Parity**: Outputs logs in strict Elastic Common Schema (ECS) format.
- 🛡️ **Auto-Sanitization**: Automatically redacts sensitive fields like passwords, secrets, tokens, and Authorization headers.
- 🚫 **Domain Ignoral**: Ignore traffic to specific domains (e.g. `localhost`).
- ⏱️ **Nanosecond Latency**: Tracks transaction duration down to the nanosecond, mapped to `event.duration`.
- 🔗 **Correlation IDs**: Generates (or passes through) UUID trace IDs for distributed tracing.

## Installation

Install the package directly from npm:

```bash
npm install axios-interceptor-logger
```

## Usage

Import the `AxiosLoggerSingleton` and attach it to your Axios instance(s).

```typescript
import axios from "axios";
import { AxiosLoggerSingleton } from "axios-interceptor-logger";

// 1. Initialize the Logger Configuration
const logger = AxiosLoggerSingleton.getInstance({
  verbose: true, // Prints ECS logs to the console
  maxPayloadBytes: 5000, // Caps how many characters of each string field are logged (hard ceiling: 10000)
  redactKeys: ["password", "secret", "token", "authorization", "apikey", "api_key"],
  ignoreDomains: ["localhost"],
  sourceDomain: "my-app-host.internal", // Populates the `source.domain` field in the ECS log
});

// 2. Create an Axios Instance
const apiClient = axios.create({
  baseURL: "https://api.example.com",
});

// 3. Attach the Interceptor
logger.attach(apiClient);

// 4. Make requests (they will now be automatically logged in ECS format!)
await apiClient.post("/login", {
  username: "admin",
  password: "supersecretpassword",
});
```

### Default Redacted Keys

If you don't pass `redactKeys`, any header/body key whose name *contains* one of the following (case-insensitive) is replaced with `[REDACTED]`:

```
authorization, password, token, secret, cookie, apikey, api_key, api-key,
privatekey, private_key, private-key
```

This is a substring match against common secret names — it is **not** a guarantee that every secret-shaped field in your API traffic will be caught. Review the [Responsibility & Disclaimer](#responsibility--disclaimer) section below and pass your own `redactKeys` for anything app-specific (custom auth headers, PII fields, etc.).

### Attaching to `axios.create()`'d Instances

`attach()` only registers interceptors on the exact instance you pass it. By default, if that instance also exposes its own `.create()` — the top-level `axios` default export, for example — the library wraps `.create()` so every instance it produces afterwards (`AeremAuth`, `OcrClient`, or anything else built with `axios.create()`) is automatically attached too, with no per-integration wiring needed:

```typescript
import axios from "axios";
import { AxiosLoggerSingleton } from "axios-interceptor-logger";

const logger = AxiosLoggerSingleton.getInstance({ filePath: "./logs/axios.log" });
logger.attach(axios); // also patches axios.create() from here on

const apiClient = axios.create({ baseURL: "https://api.example.com" }); // attached automatically
```

Set `autoPatchCreate: false` in the initializer if you'd rather call `logger.attach()` yourself on each instance you create.

**Limitations:** `autoPatchCreate` only wraps `.create()` on the exact module/instance you pass to `attach()`. Two things it can't reach:
- An instance built with `new (require("axios").Axios)(config)` instead of `.create()` — bypasses the patch entirely.
- A dependency that bundles its **own** copy of `axios` (a duplicate/nested install, common with mismatched versions in a monorepo) — patching your copy's `.create()` has no effect on a different module instance in memory.

In both cases, call `logger.attach()` directly on that instance instead.

Axios itself has no Express-style `next()` — interceptors chain via promises in FIFO registration order (request and response alike, in current axios versions). Because `autoPatchCreate` attaches synchronously inside the patched `create()`, this library's interceptors are always registered before anything the calling code adds afterward on that instance, so they always run first outbound and first inbound. This is safe by design: `handleRequest` returns the (possibly-mutated) config for downstream interceptors to see, and `handleError` always re-rejects rather than swallowing the error, so interceptors added later (retry logic, token refresh, etc.) still run normally.

### Environment Variables (Deprecated)

- `APP_HOST` — **deprecated, will be removed in a future release.** If set (and `sourceDomain` isn't passed to `getInstance()`), it still populates the `source.domain` field for now, but using it logs a startup deprecation warning. Pass `sourceDomain` to the initializer instead (see [Usage](#usage) above).

### Multi-Instance / Shared Volume Deployments

If several replicas of the same service (Docker Swarm, ECS, Kubernetes, PM2 cluster mode) share one mounted log directory, pointing every replica at the same `filePath` means they're all appending to one file concurrently — writes can interleave and corrupt individual JSON lines, and nothing here coordinates that across processes.

Give each replica its own file instead: pick a stable per-instance id available at startup — the container hostname is usually good enough, since Docker/Swarm/Kubernetes each set one per container — and derive both `filePath` and `sourceDomain` from it before calling `getInstance()`. Using the same id for both means the file a log entry landed in and the `source.domain` inside that entry agree with each other.

```typescript
import os from "node:os";
import path from "node:path";
import axios from "axios";
import { AxiosLoggerSingleton } from "axios-interceptor-logger";

// "/var/log/my-service/axios-outbound.log" -> "/var/log/my-service/axios-outbound-<instanceId>.log"
// Keeps the configured base path and extension exactly as given — only the
// filename gets the per-instance suffix inserted before it.
function instancedLogPath(basePath: string, instanceId: string = os.hostname()): string {
  const ext = path.extname(basePath);
  const dir = path.dirname(basePath);
  const base = path.basename(basePath, ext);
  return path.join(dir, `${base}-${instanceId}${ext}`);
}

const instanceId = os.hostname();

const logger = AxiosLoggerSingleton.getInstance({
  filePath: instancedLogPath(process.env.AXIOS_LOG_PATH!, instanceId),
  sourceDomain: instanceId,
});

logger.attach(axios);
```

Your app's own log-path configuration (env var, config file, whatever you call it) stays a single literal path, same as a single-instance deployment — only the file this library actually opens gets the suffix. A log shipper (Grafana Alloy, Filebeat, etc.) watching the directory with a glob — `axios-outbound-*.log` — picks up every replica's file automatically as they come and go, with no per-replica configuration on the shipper's side.

By default, a container's hostname is a random id that changes every time the container is recreated (redeploy, scale, crash restart) — old files are never reused or cleaned up, so pair this with your own log rotation ([see Responsibility & Disclaimer](#responsibility--disclaimer)). If your orchestrator supports naming replicas predictably (e.g. Docker Swarm's `hostname: "my-service-{{.Task.Slot}}"` service field), using that instead of the raw hostname gives you a bounded, reused set of files instead of an ever-growing one.

## Output Example

The logger intercepts the traffic and outputs standard Packetbeat ECS JSON:

```json
{
  "@timestamp": "2026-09-11T09:34:32.765Z",
  "ecs": { "version": "8.0.0" },
  "agent": {
    "name": "axios-interceptor-logger",
    "type": "axios-logger",
    "version": "1.1.0"
  },
  "event": {
    "start": "2026-09-11T09:34:31.799Z",
    "end": "2026-09-11T09:34:32.765Z",
    "duration": 965000000,
    "dataset": "http"
  },
  "http": {
    "request": {
      "method": "POST",
      "headers": {
        "Accept": "application/json",
        "Authorization": "[REDACTED]"
      },
      "body": {
        "content": "{\"username\":\"admin\",\"password\":\"[REDACTED]\"}"
      }
    },
    "response": {
      "status_code": 200
    }
  },
  "url": {
    "full": "https://api.example.com/login",
    "scheme": "https",
    "domain": "api.example.com"
  }
}
```

## Requirements

- Node.js >= 16 (uses `crypto.randomUUID` and Node's `fs`/streams APIs).
- **Server-side only.** This package imports Node core modules directly and is not meant to be bundled into a browser build — using it there will throw or fail to bundle.

## Responsibility & Disclaimer

This library sits between your code and the network, so "is my logging safe/reliable" depends on more than just this package. To be explicit about where each concern is handled:

**This library (`axios-interceptor-logger`) is responsible for:**
- Not crashing or leaking memory under normal or adversarial payload shapes (bounded recursion depth/keys/array items, backpressure-aware file writes, a circuit breaker on disk errors).
- Redacting the key names listed in [Default Redacted Keys](#default-redacted-keys), or any additional keys you pass via `redactKeys`.
- Falling back to `console` output if the configured log file becomes unwritable, so log entries aren't silently dropped.

**`axios` (the peer dependency) is responsible for:**
- Actually performing the HTTP request/response lifecycle this library hooks into — bugs in header normalization, redirects, or request/response shape are upstream of this package. Pin an `axios@^1.x` version you trust and keep it patched.

**Your application (the dependent) is responsible for:**
- **Log rotation and disk space.** This library appends to a single file forever; it does not rotate or cap file size. Point `filePath` at a location managed by `logrotate`, your process manager, or a log-shipping sidecar — otherwise the log file will grow until the disk fills up.
- **Writable storage.** On read-only filesystems (some serverless/container platforms), file writes will fail and the logger falls back to `console`; set `filePath` to a writable path (e.g. `/tmp`) explicitly rather than relying on the fallback.
- **What actually counts as sensitive for your API.** The default `redactKeys` only catches common secret *names*. Fields like SSNs, card numbers, or app-specific PII in the body will be logged in cleartext (subject to the per-string truncation cap) unless you add them to `redactKeys` or route those endpoints through `ignoreDomains`.
- **Compliance requirements** (GDPR, PCI-DSS, etc.) for what you're allowed to persist to disk — this library logs request/response bodies by design; it's your call which traffic should go through it.
- **Throughput at scale.** Sanitizing and serializing very large request/response bodies is synchronous CPU work (deferred one tick via `setImmediate`, not offloaded to a worker). For endpoints with large payloads, consider `ignoreDomains` or trimming what you send/receive.
