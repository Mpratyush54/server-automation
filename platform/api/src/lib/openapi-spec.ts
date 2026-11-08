import fs from 'fs';
import path from 'path';

/**
 * The OpenAPI document served at GET /api/openapi.json, built from openapi.yaml once per
 * process and kept as a serialized JSON string.
 *
 * It used to be read and YAML-parsed on every request, with the YAML parser loaded lazily on
 * the first one. The spec only changes with a new image, so one parse is enough; call
 * `loadOpenApiJson()` at startup to keep even the first request off the parse path.
 */
const API_ROOT = path.join(__dirname, '..', '..');

let cached: string | null = null;

export class OpenApiUnavailableError extends Error {}

export function loadOpenApiJson(root: string = API_ROOT): string {
  if (cached !== null) return cached;
  const raw = fs.readFileSync(path.join(root, 'openapi.yaml'), 'utf8');
  let spec: unknown;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const yaml = require('yaml');
    spec = yaml.parse(raw);
  } catch {
    // No YAML parser in this build: fall back to a bundled JSON companion.
    const jsonPath = path.join(root, 'openapi.json');
    if (!fs.existsSync(jsonPath)) throw new OpenApiUnavailableError('OpenAPI spec unavailable');
    spec = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  }
  cached = JSON.stringify(spec);
  return cached;
}

/** Test hook. */
export function resetOpenApiCacheForTests(): void {
  cached = null;
}
