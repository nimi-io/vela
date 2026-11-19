import crypto from "node:crypto";
import { env } from "./env.js";

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** URL-safe random base62 id. */
export function randomId(length = 24): string {
  let out = "";
  while (out.length < length) {
    const bytes = crypto.randomBytes(length * 2);
    for (const b of bytes) {
      if (b < 248) out += ALPHABET[b % 62]; // 248 = 62*4, avoids modulo bias
      if (out.length === length) break;
    }
  }
  return out;
}

export function randomSecret(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function sha256(input: string | Buffer): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function hmacHex(key: string | Buffer, data: string): string {
  return crypto.createHmac("sha256", key).update(data).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

const derived = new Map<string, Buffer>();

/** Derive a purpose-specific 32-byte key from MASTER_KEY (HKDF-SHA256). */
export function deriveKey(purpose: string): Buffer {
  let key = derived.get(purpose);
  if (!key) {
    key = Buffer.from(crypto.hkdfSync("sha256", Buffer.from(env().MASTER_KEY), Buffer.alloc(0), Buffer.from(`vela:${purpose}`), 32));
    derived.set(purpose, key);
  }
  return key;
}

/** AES-256-GCM encrypt → base64(iv | tag | ciphertext). */
export function encrypt(plaintext: string | Buffer): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", deriveKey("encryption"), iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
}

export function decrypt(payload: string): Buffer {
  const buf = Buffer.from(payload, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", deriveKey("encryption"), buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]);
}

export function encryptJson(value: unknown): string {
  return encrypt(JSON.stringify(value));
}

export function decryptJson<T>(payload: string): T {
  return JSON.parse(decrypt(payload).toString("utf8")) as T;
}

export function generateRsaKeyPair(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { publicKey, privateKey };
}

/**
 * Stream tokens are embedded in playback URL paths after a viewer's JWT has been verified, so
 * every rendition/segment request can be authorised with a cheap HMAC instead of RSA.
 * Format: <exp>.<sig>  (exp = unix seconds). Public playback uses the literal "p".
 */
export function signStreamToken(playbackId: string, exp: number): string {
  const sig = hmacHex(deriveKey("stream-token"), `${playbackId}:${exp}`).slice(0, 32);
  return `${exp}.${sig}`;
}

export function verifyStreamToken(playbackId: string, token: string): boolean {
  const [expStr, sig] = token.split(".");
  const exp = Number(expStr);
  if (!exp || !sig || exp < Math.floor(Date.now() / 1000)) return false;
  const expected = hmacHex(deriveKey("stream-token"), `${playbackId}:${exp}`).slice(0, 32);
  return safeEqual(expected, sig);
}
