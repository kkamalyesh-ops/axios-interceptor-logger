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

## Environment Variables

- `APP_HOST`: If set, the logger will populate the `source.domain` field in the ECS log with this value. If missing, it defaults to `localhost`.

## Output Example

The logger intercepts the traffic and outputs standard Packetbeat ECS JSON:

```json
{
  "@timestamp": "2026-09-11T09:34:32.765Z",
  "ecs": { "version": "8.0.0" },
  "agent": {
    "name": "axios-interceptor-logger",
    "type": "axios-logger",
    "version": "1.0.1"
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
