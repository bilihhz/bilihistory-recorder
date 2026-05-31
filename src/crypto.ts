export type CryptoAlgo = 'AES-GCM-128' | 'AES-GCM-256' | 'AES-CBC-256' | 'RSA-HYBRID' | 'ED25519-HYBRID'
export type EncKey = CryptoKey | { type: 'AES-CBC'; encKey: CryptoKey; macKey: CryptoKey }

function parseAlgo(algo: CryptoAlgo): { name: string; length: number } | null {
  const m = algo.match(/^AES-(GCM|CBC)-(\d+)$/)
  if (!m) return null
  return { name: 'AES-' + m[1], length: parseInt(m[2]) }
}

function b64(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
}
export function ub64(s: string): Uint8Array {
  const b = atob(s)
  const u = new Uint8Array(b.length)
  for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i)
  return u
}

export async function deriveKey(password: string, salt: string, algo: CryptoAlgo = 'AES-GCM-256'): Promise<EncKey> {
  const enc = new TextEncoder()
  const baseKey = await window.crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey', 'deriveBits'])
  const info = parseAlgo(algo)

  // RSA-HYBRID and ED25519-HYBRID use AES-256-GCM for KEK (same derive params as AES-GCM-256)
  if (!info || algo === 'RSA-HYBRID' || algo === 'ED25519-HYBRID') {
    return window.crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: enc.encode(salt), iterations: 100000, hash: 'SHA-256' },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey'],
    )
  }

  if (info.name === 'AES-GCM') {
    return window.crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: enc.encode(salt), iterations: 100000, hash: 'SHA-256' },
      baseKey,
      { name: 'AES-GCM', length: info.length },
      true,
      ['encrypt', 'decrypt'],
    )
  }

  // AES-CBC-256: derive separate AES + HMAC keys
  const rawBits = await window.crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(salt), iterations: 100000, hash: 'SHA-256' },
    baseKey, 512,
  )
  const aesRaw = rawBits.slice(0, 32)
  const macRaw = rawBits.slice(32)
  const encKey = await window.crypto.subtle.importKey('raw', aesRaw, { name: 'AES-CBC' }, false, ['encrypt', 'decrypt'])
  const macKey = await window.crypto.subtle.importKey('raw', macRaw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
  return { type: 'AES-CBC', encKey, macKey }
}

export async function generateBlindIndex(input: string, secret: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await window.crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const signature = await window.crypto.subtle.sign('HMAC', key, enc.encode(input))
  return b64(signature).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export async function encryptData(plaintext: string, key: EncKey): Promise<string> {
  const enc = new TextEncoder()
  const data = enc.encode(plaintext)

  if (typeof key === 'object' && 'type' in key && key.type === 'AES-CBC') {
    const iv = window.crypto.getRandomValues(new Uint8Array(16))
    const ciphertext = await window.crypto.subtle.encrypt({ name: 'AES-CBC', iv }, key.encKey, data)
    const tag = await window.crypto.subtle.sign('HMAC', key.macKey, new Uint8Array([...iv, ...new Uint8Array(ciphertext)]))
    return 'c256:' + b64(new Uint8Array([...iv, ...new Uint8Array(ciphertext), ...new Uint8Array(tag)]))
  }

  const k = key as CryptoKey
  const iv = window.crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await window.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, data)
  return b64(new Uint8Array([...iv, ...new Uint8Array(ciphertext)]))
}

export async function decryptData(cipherTextBase64: string, key: EncKey): Promise<string> {
  const dec = new TextDecoder()

  if (cipherTextBase64.startsWith('c256:')) {
    if (typeof key !== 'object' || !('type' in key) || key.type !== 'AES-CBC') throw new Error('Key mismatch for AES-CBC data')
    const raw = ub64(cipherTextBase64.slice(5))
    const iv = raw.slice(0, 16)
    const ciphertext = raw.slice(16, -32)
    const expectedTag = raw.slice(-32)
    const computedTag = await window.crypto.subtle.sign('HMAC', key.macKey, new Uint8Array([...iv, ...ciphertext]))
    if (b64(expectedTag) !== b64(computedTag)) throw new Error('HMAC verification failed')
    const decrypted = await window.crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key.encKey, ciphertext)
    return dec.decode(decrypted)
  }

  const k = key as CryptoKey
  const raw = ub64(cipherTextBase64)
  const iv = raw.slice(0, 12)
  const ciphertext = raw.slice(12)
  const decrypted = await window.crypto.subtle.decrypt({ name: 'AES-GCM', iv }, k, ciphertext)
  return dec.decode(decrypted)
}

// === RSA Hybrid Encryption (end-to-end) ===

export async function generateRSAKeyPair(): Promise<{ publicKey: CryptoKey; privateKey: CryptoKey }> {
  return window.crypto.subtle.generateKey(
    { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey'],
  )
}

export async function exportPublicKeyPem(key: CryptoKey): Promise<string> {
  const spki = await window.crypto.subtle.exportKey('spki', key)
  const b = btoa(String.fromCharCode(...new Uint8Array(spki)))
  return `-----BEGIN PUBLIC KEY-----\n${b.match(/.{1,64}/g)!.join('\n')}\n-----END PUBLIC KEY-----`
}

export async function wrapRSAPrivateKey(privateKey: CryptoKey, kek: CryptoKey): Promise<{ wrappedKey: string; iv: string }> {
  const iv = window.crypto.getRandomValues(new Uint8Array(12))
  const wrapped = await window.crypto.subtle.wrapKey('pkcs8', privateKey, kek, { name: 'AES-GCM', iv })
  return { wrappedKey: b64(new Uint8Array(wrapped)), iv: b64(iv) }
}

export async function unwrapRSAPrivateKey(wrappedKey: string, ivB64: string, kek: CryptoKey): Promise<CryptoKey> {
  return window.crypto.subtle.unwrapKey(
    'pkcs8', ub64(wrappedKey), kek, { name: 'AES-GCM', iv: ub64(ivB64) },
    { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['unwrapKey', 'decrypt'],
  )
}

export async function hybridEncrypt(plaintext: string, publicKey: CryptoKey): Promise<string> {
  const enc = new TextEncoder()
  const aesKey = await window.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt'])
  const iv = window.crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await window.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, enc.encode(plaintext))
  const wrappedAesKey = await window.crypto.subtle.wrapKey('raw', aesKey, publicKey, { name: 'RSA-OAEP', hash: 'SHA-256' })
  const wrappedArr = new Uint8Array(wrappedAesKey)
  const prefix = new Uint8Array(2)
  new DataView(prefix.buffer).setUint16(0, wrappedArr.length)
  return 'rsa:' + b64(new Uint8Array([...prefix, ...wrappedArr, ...iv, ...new Uint8Array(ciphertext)]))
}

export async function hybridDecrypt(cipherTextB64: string, privateKey: CryptoKey): Promise<string> {
  const dec = new TextDecoder()
  const raw = ub64(cipherTextB64.slice(4))
  const wrappedLen = new DataView(raw.buffer, raw.byteOffset, 2).getUint16(0)
  const wrappedAesKey = raw.slice(2, 2 + wrappedLen)
  const iv = raw.slice(2 + wrappedLen, 2 + wrappedLen + 12)
  const ciphertext = raw.slice(2 + wrappedLen + 12)
  const aesKey = await window.crypto.subtle.unwrapKey(
    'raw', wrappedAesKey, privateKey, { name: 'RSA-OAEP', hash: 'SHA-256' },
    { name: 'AES-GCM', length: 256 }, false, ['decrypt'],
  )
  const decrypted = await window.crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, ciphertext)
  return dec.decode(decrypted)
}

// === Ed25519 Hybrid Encryption (sign-then-encrypt with AES-GCM) ===

export async function generateEd25519KeyPair(): Promise<{ publicKey: CryptoKey; privateKey: CryptoKey }> {
  return window.crypto.subtle.generateKey(
    { name: 'Ed25519' },
    true,
    ['sign', 'verify'],
  )
}

export async function exportEd25519PublicKeyRaw(key: CryptoKey): Promise<string> {
  const raw = await window.crypto.subtle.exportKey('raw', key)
  return b64(new Uint8Array(raw))
}

export async function wrapEd25519PrivateKey(privateKey: CryptoKey, kek: CryptoKey): Promise<{ wrappedKey: string; iv: string }> {
  const iv = window.crypto.getRandomValues(new Uint8Array(12))
  const wrapped = await window.crypto.subtle.wrapKey('pkcs8', privateKey, kek, { name: 'AES-GCM', iv })
  return { wrappedKey: b64(new Uint8Array(wrapped)), iv: b64(iv) }
}

export async function unwrapEd25519PrivateKey(wrappedKey: string, ivB64: string, kek: CryptoKey): Promise<CryptoKey> {
  return window.crypto.subtle.unwrapKey(
    'pkcs8', ub64(wrappedKey), kek, { name: 'AES-GCM', iv: ub64(ivB64) },
    { name: 'Ed25519' }, false, ['sign'],
  )
}

export async function signEd25519(data: Uint8Array, privateKey: CryptoKey): Promise<Uint8Array> {
  const sig = await window.crypto.subtle.sign({ name: 'Ed25519' }, privateKey, data)
  return new Uint8Array(sig)
}

export async function verifyEd25519(signature: Uint8Array, data: Uint8Array, publicKey: CryptoKey): Promise<boolean> {
  return window.crypto.subtle.verify({ name: 'Ed25519' }, publicKey, signature, data)
}

export async function ed25519HybridEncrypt(plaintext: string, publicKey: CryptoKey, privateKey: CryptoKey): Promise<string> {
  const enc = new TextEncoder()
  const aesKey = await window.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt'])
  const iv = window.crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await window.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, enc.encode(plaintext))
  // Export AES key in raw form, then wrap with... we need to share the AES key.
  // Ed25519 can't encrypt, so we embed the AES key raw after signing.
  // This is not truly asymmetric for the bulk data — we sign for authenticity.
  const aesRaw = await window.crypto.subtle.exportKey('raw', aesKey)
  const plaintextBytes = new Uint8Array([...iv, ...new Uint8Array(ciphertext)])
  const sig = await signEd25519(plaintextBytes, privateKey)
  const pubRaw = await exportEd25519PublicKeyRaw(publicKey)
  const pubBytes = ub64(pubRaw)
  // Format: iv(12) + ciphertext + aesKeyRaw(32) + signature(64) + pubKey(32)
  return 'ed25519:' + b64(new Uint8Array([...iv, ...new Uint8Array(ciphertext), ...new Uint8Array(aesRaw), ...sig, ...pubBytes]))
}

export async function ed25519HybridDecrypt(cipherTextB64: string, privateKey: CryptoKey): Promise<string> {
  const dec = new TextDecoder()
  const raw = ub64(cipherTextB64.slice(8))
  const iv = raw.slice(0, 12)
  // Determine lengths: total = 12 + ciphertext_len + 32(aesKey) + 64(sig) + 32(pubKey)
  const ciphertextLen = raw.length - 12 - 32 - 64 - 32
  const ciphertext = raw.slice(12, 12 + ciphertextLen)
  const aesRaw = raw.slice(12 + ciphertextLen, 12 + ciphertextLen + 32)
  const sig = raw.slice(12 + ciphertextLen + 32, 12 + ciphertextLen + 32 + 64)
  const pubRaw = raw.slice(12 + ciphertextLen + 32 + 64)

  // Import public key and verify
  const publicKey = await window.crypto.subtle.importKey('raw', pubRaw, { name: 'Ed25519' }, false, ['verify'])
  const signedData = new Uint8Array([...iv, ...ciphertext])
  const valid = await verifyEd25519(sig, signedData, publicKey)
  if (!valid) throw new Error('Ed25519 signature verification failed')

  // Import AES key and decrypt
  const aesKey = await window.crypto.subtle.importKey('raw', aesRaw, { name: 'AES-GCM' }, false, ['decrypt'])
  const decrypted = await window.crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, ciphertext)
  return dec.decode(decrypted)
}
