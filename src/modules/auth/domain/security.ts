import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

export const randomToken = () => randomBytes(32).toString('base64url');
export const sha256 = (value: string) => createHash('sha256').update(value).digest('base64url');

export function safeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);

  return left.length === right.length && timingSafeEqual(left, right);
}

/** Separate key from API credentials; server-only AES-256-GCM provider grant storage. */
export function createCipher(key?: string) {
  const bytes = key ? Buffer.from(key, 'base64') : randomBytes(32);

  if (bytes.length !== 32) {
    throw new Error('AUTH_TOKEN_ENCRYPTION_KEY must contain exactly 32 base64-encoded bytes.');
  }

  return {
    encrypt(value: unknown) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', bytes, iv);
      const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);

      return [
        'v1',
        iv.toString('base64url'),
        cipher.getAuthTag().toString('base64url'),
        data.toString('base64url'),
      ].join('.');
    },

    decrypt<T>(value: string): T {
      const [version, iv, tag, data] = value.split('.');

      if (version !== 'v1' || !iv || !tag || !data) {
        throw new Error('Invalid encrypted account data.');
      }

      const cipher = createDecipheriv('aes-256-gcm', bytes, Buffer.from(iv, 'base64url'));
      cipher.setAuthTag(Buffer.from(tag, 'base64url'));

      const plain = Buffer.concat([cipher.update(Buffer.from(data, 'base64url')), cipher.final()]);

      return JSON.parse(plain.toString('utf8')) as T;
    },
  };
}

export function safeWebUrl(value: string, label: string) {
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);

  if (
    (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      `${label} must be HTTPS (HTTP loopback is allowed for local development), without credentials, query or fragment.`,
    );
  }

  return url;
}
