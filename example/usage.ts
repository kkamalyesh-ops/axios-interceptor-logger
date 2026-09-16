import axios from 'axios';
import { AxiosLoggerSingleton } from 'axios-interceptor-logger';

// Initialize Logger
const logger = AxiosLoggerSingleton.getInstance({
  verbose: true,
  maxPayloadBytes: 5000, 
  redactKeys: ['password', 'secret', 'token'],
  ignoreDomains: ['localhost'],
});

// Create Axios Instance
const httpsClient = axios.create({
  baseURL: 'https://httpbin.org',
});

// Attach Logger
logger.attach(httpsClient);

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
