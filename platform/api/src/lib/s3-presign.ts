import crypto from 'crypto';

/**
 * AWS Signature V4 query-string presigning for S3-compatible stores (MinIO,
 * AWS S3, R2, ...). Dependency-free so presigned URLs need no extra SDK.
 */
export interface PresignOptions {
  method: 'GET' | 'PUT' | 'HEAD' | 'DELETE';
  /** Base URL of the S3 API, e.g. https://s3.example.com or http://minio.storage:9000 */
  endpoint: string;
  bucket: string;
  key: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  expiresSeconds?: number;
  /** Path-style (default, what MinIO uses) or virtual-hosted-style URLs. */
  pathStyle?: boolean;
  sessionToken?: string;
  now?: Date;
}

/** RFC 3986 encoding as SigV4 requires. */
export function uriEncode(value: string, keepSlash = false): string {
  const encoded = encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return keepSlash ? encoded.replace(/%2F/g, '/') : encoded;
}

function hmac(key: crypto.BinaryLike, data: string): Buffer {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

function sha256Hex(data: string): string {
  return crypto.createHash('sha256').update(data, 'utf8').digest('hex');
}

function amzDate(d: Date): { stamp: string; day: string } {
  const stamp = d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return { stamp, day: stamp.slice(0, 8) };
}

export function presignS3Url(opts: PresignOptions): string {
  const region = opts.region || 'us-east-1';
  const expires = Math.max(1, Math.min(opts.expiresSeconds ?? 900, 604800));
  const base = new URL(opts.endpoint);
  const pathStyle = opts.pathStyle !== false;
  const host = pathStyle ? base.host : `${opts.bucket}.${base.host}`;
  const prefix = base.pathname.replace(/\/+$/, '');
  const canonicalUri = pathStyle
    ? `${prefix}/${uriEncode(opts.bucket)}/${uriEncode(opts.key, true)}`
    : `${prefix}/${uriEncode(opts.key, true)}`;

  const { stamp, day } = amzDate(opts.now || new Date());
  const scope = `${day}/${region}/s3/aws4_request`;
  const params: Record<string, string> = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${opts.accessKeyId}/${scope}`,
    'X-Amz-Date': stamp,
    'X-Amz-Expires': String(expires),
    'X-Amz-SignedHeaders': 'host',
  };
  if (opts.sessionToken) params['X-Amz-Security-Token'] = opts.sessionToken;
  const canonicalQuery = Object.keys(params)
    .sort()
    .map((k) => `${uriEncode(k)}=${uriEncode(params[k])}`)
    .join('&');

  const canonicalRequest = [opts.method, canonicalUri, canonicalQuery, `host:${host}`, '', 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256Hex(canonicalRequest)].join('\n');
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${opts.secretAccessKey}`, day), region), 's3'), 'aws4_request');
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');

  return `${base.protocol}//${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}
