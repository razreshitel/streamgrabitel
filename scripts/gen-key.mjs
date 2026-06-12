// Generates a stable extension identity: an RSA public key for manifest.json's
// "key" field, and the Chrome extension ID derived from it. Pinning the ID lets
// the native messaging host whitelist this exact extension in allowed_origins,
// so registration works the same on every machine / clone.
//
// Run once: node scripts/gen-key.mjs   (then paste the values where indicated)

import { generateKeyPairSync, createHash } from 'node:crypto';

const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const der = publicKey.export({ type: 'spki', format: 'der' });
const keyB64 = der.toString('base64');

// Chrome ID = first 16 bytes of SHA-256(DER public key), each nibble mapped 0-f -> a-p.
const hash = createHash('sha256').update(der).digest();
let id = '';
for (let i = 0; i < 16; i++) {
  id += String.fromCharCode(97 + (hash[i] >> 4));
  id += String.fromCharCode(97 + (hash[i] & 0x0f));
}

console.log('EXTENSION_ID=' + id);
console.log('MANIFEST_KEY=' + keyB64);
