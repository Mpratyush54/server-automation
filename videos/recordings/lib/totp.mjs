// RFC 6238 time-based one-time codes (SHA-1, 6 digits, 30 s), as the Cairn
// portal's authenticator sign-in expects. No dependencies.
import { createHmac } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Decode(secret) {
  const clean = secret.toUpperCase().replace(/[\s=-]/g, '');
  let bits = '';
  for (const char of clean) {
    const value = ALPHABET.indexOf(char);
    if (value < 0) throw new Error('The TOTP secret is not base32');
    bits += value.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

export function totp(secret, { time = Date.now(), step = 30, digits = 6 } = {}) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(time / 1000 / step)));
  const hmac = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return String(code).padStart(digits, '0');
}

/**
 * A code from a time step that has not been used yet. The API rejects a
 * replayed step, so wait for the next one when `lastStep` is the current step.
 */
export async function freshTotp(secret, lastStep = -1, step = 30) {
  let now = Date.now();
  const current = Math.floor(now / 1000 / step);
  if (current <= lastStep) {
    const wait = (current + 1) * step * 1000 - now + 250;
    await new Promise((resolve) => setTimeout(resolve, wait));
    now = Date.now();
  }
  return { code: totp(secret, { time: now, step }), step: Math.floor(now / 1000 / step) };
}
