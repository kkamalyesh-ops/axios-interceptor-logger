import axios from 'axios';
import { AxiosLoggerSingleton } from 'axios-interceptor-logger';

// Initialize Logger
const logger = AxiosLoggerSingleton.getInstance({
  verbose: true,
  maxPayloadBytes: 5000,
  redactKeys: ['password', 'secret', 'token'],
  ignoreDomains: ['localhost'],
  sourceDomain: 'usage-example', // Populates `source.domain` in the ECS log (replaces the deprecated APP_HOST env var)
});

// Attach to the `axios` module itself rather than one instance. By default
// (`autoPatchCreate: true`) this also wraps axios.create(), so any instance
// created afterwards — like httpsClient below — is attached automatically,
// with no explicit logger.attach(httpsClient) call needed.
logger.attach(axios);

// Create Axios Instance (attached automatically via the patched axios.create())
const httpsClient = axios.create({
  baseURL: 'https://httpbin.org',
});

async function runExamples() {
  console.log('\n=========================================');
  console.log('--- Case 1: JSON Request & Response ---');
  try {
    // Tests: Standard JSON payload and JSON response
    await httpsClient.post('/post', {
      type: 'json-mock',
      user: 'alice',
      secret: 'hidden-secret' // Should be redacted
    });
  } catch (e) { }

  console.log('\n=========================================');
  console.log('--- Case 2: Plain Text Request & Response ---');
  try {
    // Tests: Sending raw plain text (no JSON stringify)
    await httpsClient.post('/post', 'This is a raw text payload for testing purposes.', {
      headers: { 'Content-Type': 'text/plain' }
    });
  } catch (e) { }

  console.log('\n=========================================');
  console.log('--- Case 3: Filepart / Multipart (Binary Blob) ---');
  try {
    // Tests: Using native FormData with a binary Blob
    // Node v18+ has native FormData and Blob support
    const formData = new FormData();
    const mockFileContent = new Blob(['Simulated file contents over multipart form data'], { type: 'text/plain' });
    
    formData.append('username', 'bob');
    formData.append('profilePicture', mockFileContent, 'profile.txt');

    // The logger's sanitizer is designed to catch Blobs/Buffers and replace them with a [BINARY_DATA] tag
    await httpsClient.post('/post', formData, {
      headers: { 'Content-Type': 'multipart/form-data' }
    });
  } catch (e) { }
}

runExamples();
