import express from 'express';
import axios from 'axios';

// We are importing the library as a consumer would
import { AxiosLoggerSingleton } from 'axios-interceptor-logger';

const app = express();
app.use(express.json());

// 1. Initialize the Logger (this should only happen once)
const logger = AxiosLoggerSingleton.getInstance({
  verbose: true, // Print output to the console for demonstration
  redactKeys: ['password', 'secret', 'token', 'authorization'],
  maxPayloadBytes: 2000,
  sourceDomain: 'example-server', // Populates `source.domain` in the ECS log
});

// 2. Attach the logger to the `axios` module itself. By default
//    (`autoPatchCreate: true`) this also wraps axios.create(), so every
//    instance created below — or later, elsewhere in the app — is attached
//    automatically with no extra wiring.
logger.attach(axios);

// 3. Create an Axios instance that this server will use for outbound requests
//    (attached automatically thanks to the patched axios.create() above)
const apiClient = axios.create({
  baseURL: 'https://jsonplaceholder.typicode.com',
  timeout: 5000
});

// --- ROUTES ---

// Route 1: A standard GET request
app.get('/api/users', async (req, res) => {
  try {
    // This outbound request will be logged automatically (Latency, Status, URL, etc.)
    const response = await apiClient.get('/users/1');
    res.json({ message: 'Fetched user successfully', data: response.data });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

// Route 2: A POST request containing sensitive data
app.post('/api/login', async (req, res) => {
  try {
    // This payload contains sensitive keys. 
    // The logger will intercept this and redact 'password' and 'secretCode' in the logs.
    const payload = {
      username: 'admin',
      password: 'super-secret-password-123', // Will be redacted
      secretCode: 'xyz987',                  // Will be redacted
      normalField: 'hello world'             // Will be logged normally
    };
    
    // Simulating an outbound POST request to an auth provider
    const response = await apiClient.post('/posts', payload);
    res.json({ message: 'Login request sent', data: response.data });
  } catch (error) {
    res.status(500).json({ error: 'Login failed' });
  }
});

// Route 3: Simulating a 404 Error request
app.get('/api/error', async (req, res) => {
  try {
    // This will trigger a 404. The error interceptor will log the full failure context.
    await apiClient.get('/invalid-endpoint-that-does-not-exist');
    res.json({ message: 'Success' });
  } catch (error) {
    res.status(500).json({ error: 'Outbound request failed, check logs.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 Example Server is running on http://localhost:${PORT}`);
  console.log('\nTry triggering outbound requests by visiting these routes:');
  console.log(`  1. GET  http://localhost:${PORT}/api/users (Success)`);
  console.log(`  2. POST http://localhost:${PORT}/api/login (Shows Redaction)`);
  console.log(`  3. GET  http://localhost:${PORT}/api/error (Shows Error Logging)\n`);
});
