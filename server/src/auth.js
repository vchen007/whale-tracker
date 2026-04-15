import { sign, constants, createPrivateKey } from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Load and parse the RSA private key from disk.
 * Accepts PKCS#1 (BEGIN RSA PRIVATE KEY) or PKCS#8 (BEGIN PRIVATE KEY).
 */
export function loadPrivateKey(keyPath) {
  const absPath = resolve(keyPath);
  const pem = readFileSync(absPath, 'utf8');
  // Parse via createPrivateKey so Node.js normalises the format internally.
  return createPrivateKey({ key: pem, format: 'pem' });
}

/**
 * Sign the Kalshi request with RSA-PSS SHA-256.
 *
 * Kalshi signing spec:
 *   message  = timestampMs (string) + method + path
 *   algorithm: RSA-PSS, hash SHA-256, MGF1 SHA-256, saltLength = 32
 *   encoding : base64
 */
export function buildAuthParams(privateKey, apiKeyId, wsPath = '/trade-api/ws/v2') {
  const timestampMs = Date.now().toString();
  const message = timestampMs + 'GET' + wsPath;

  const signature = sign('sha256', Buffer.from(message, 'utf8'), {
    key: privateKey,
    padding: constants.RSA_PKCS1_PSS_PADDING,
    saltLength: 32,
  }).toString('base64');

  return { api_key: apiKeyId, signature, timestamp: timestampMs };
}
