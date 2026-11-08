import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadOpenApiJson, resetOpenApiCacheForTests } from '../../../src/lib/openapi-spec';

afterEach(() => {
  resetOpenApiCacheForTests();
  jest.restoreAllMocks();
});

it('parses openapi.yaml once and serves the cached JSON afterwards', () => {
  const read = jest.spyOn(fs, 'readFileSync');
  const first = loadOpenApiJson();
  const yamlReads = () => read.mock.calls.filter(([p]) => String(p).endsWith('openapi.yaml')).length;
  expect(yamlReads()).toBe(1);
  for (let i = 0; i < 20; i++) expect(loadOpenApiJson()).toBe(first);
  expect(yamlReads()).toBe(1);
  const spec = JSON.parse(first);
  expect(spec.openapi).toMatch(/^3\./);
  expect(spec.paths['/health/ready']).toBeDefined();
});

it('throws when the spec file is missing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plat-openapi-'));
  try {
    expect(() => loadOpenApiJson(dir)).toThrow();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
