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
  maxPayloadBytes: 5000, // Truncates massive JSON bodies
  redactKeys: ["password", "secret", "token", "authorization"],
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
