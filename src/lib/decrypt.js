// AES-128-CBC segment decryption for HLS (#EXT-X-KEY:METHOD=AES-128).
// Uses the WebCrypto SubtleCrypto API, which strips PKCS#7 padding for us.

export async function importAesKey(keyBytes) {
  return crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, ['decrypt']);
}

export async function aesDecrypt(data, cryptoKey, iv) {
  const buf = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, cryptoKey, data);
  return new Uint8Array(buf);
}
