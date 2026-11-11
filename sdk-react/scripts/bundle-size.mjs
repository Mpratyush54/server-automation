#!/usr/bin/env node
// Measures what RUM adds to an app bundle and checks tree-shaking (run after `npm run build`).
// Bundles the ESM build (dist/esm) with esbuild the way an app bundler would (minified,
// code splitting), with framework/peer deps external, then reports gzip sizes of the chunks
// an app loads up front (static imports) and the chunks loaded lazily (dynamic import()).
// Fails when the RUM cost exceeds the budget, Faro reaches the initial chunks, or an app that
// does not use RUM can reach Faro at all. Session replay (#40) is measured separately: the
// replay controller and the rrweb recorder must be lazy chunks with their own budgets, and
// rrweb must never be reachable from an app that does not configure replay.
import { build } from 'esbuild';
import { gzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const BUDGET_GZIP = 30 * 1024;
const REPLAY_CONTROLLER_BUDGET_GZIP = 8 * 1024; // rum-replay.ts: consent, sampling, chunker, uploader
const REPLAY_RECORDER_BUDGET_GZIP = 40 * 1024; // rum-replay-record.ts: rrweb record + fflate gzip
const root = resolve(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const entryFile = join(root, 'dist/esm/index.js').split(String.fromCharCode(92)).join('/');
const external = [
  ...Object.keys(pkg.peerDependencies || {}),
  // Bundled (measured): Faro, and rrweb + fflate for session replay.
  ...Object.keys(pkg.dependencies || {}).filter((d) => !d.startsWith('@grafana/') && !d.startsWith('@rrweb/') && d !== 'fflate'),
  '@angular/*',
  'rxjs',
  'rxjs/*',
];
// The SDK's provider/module symbol (argv[2]): it can enable RUM at runtime from config, so
// Faro may be emitted as a lazy chunk for it, but never in the initial chunks.
const providerSymbol = process.argv[2];

const scenarios = {
  // App that never touches RUM: no Faro anywhere in its build.
  noRum: `import { redactSensitive } from '${entryFile}'; console.log(redactSensitive('x'));`,
  // App that calls initRum (what the provider/module does when `rum` is set).
  rum: `import { redactSensitive, initRum, setRumView } from '${entryFile}'; console.log(redactSensitive('x')); initRum({ telemetry: null }); setRumView('/');`,
  // App that enables replay and asks for consent.
  replay: `import { initRum, setConsent } from '${entryFile}'; initRum({ telemetry: null, replay: { sampleRate: 1 } }); setConsent({ replay: true });`,
};
if (providerSymbol) {
  scenarios.provider = `import { redactSensitive, ${providerSymbol} } from '${entryFile}'; console.log(redactSensitive('x'), ${providerSymbol});`;
}

const gz = (buf) => gzipSync(buf, { level: 9 }).length;
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

async function measure(contents) {
  const res = await build({
    stdin: { contents, resolveDir: root, loader: 'js', sourcefile: 'app-entry.js' },
    bundle: true,
    minify: true,
    splitting: true,
    format: 'esm',
    platform: 'browser',
    mainFields: ['module', 'main'],
    external,
    outdir: join(root, '.size-out'),
    write: false,
    metafile: true,
    logLevel: 'error',
  });
  const norm = (p) => resolve(root, p);
  const files = new Map(res.outputFiles.map((f) => [resolve(f.path), f.contents]));
  const outputs = new Map(Object.entries(res.metafile.outputs).map(([k, v]) => [norm(k), v]));
  const entry = [...outputs].find(([, v]) => v.entryPoint === 'app-entry.js')[0];
  // Initial = reachable through static imports; lazy = reachable through dynamic import() from those.
  const initial = new Set();
  const lazy = new Set();
  const walk = (key, set) => {
    if (set.has(key) || !outputs.has(key)) return;
    set.add(key);
    for (const imp of outputs.get(key).imports) if (imp.kind === 'import-statement') walk(norm(imp.path), set);
  };
  walk(entry, initial);
  // Transitively: dynamic imports of lazy chunks are lazy too (replay controller -> recorder).
  const walkLazy = (key) => {
    if (lazy.has(key) || initial.has(key) || !outputs.has(key)) return;
    lazy.add(key);
    for (const imp of outputs.get(key).imports) walkLazy(norm(imp.path));
  };
  for (const key of initial) {
    for (const imp of outputs.get(key).imports) if (imp.kind === 'dynamic-import') walkLazy(norm(imp.path));
  }
  const has = (k, re) => Object.keys(outputs.get(k).inputs).some((i) => re.test(i));
  const kind = (k) => (has(k, /@grafana/) ? 'faro' : has(k, /rrweb|fflate|rum-replay-record/) ? 'recorder' : has(k, /rum-replay\.js$/) ? 'replay' : 'other');
  const stats = (set, only) => {
    const keys = [...set].filter((k) => !only || only.includes(kind(k)));
    return {
      gzip: keys.reduce((a, k) => a + gz(Buffer.from(files.get(k))), 0),
      faro: keys.some((k) => has(k, /@grafana/)),
      rrweb: keys.some((k) => has(k, /rrweb/)),
      replay: keys.some((k) => has(k, /rum-replay/)),
      chunks: keys.length,
    };
  };
  return {
    initial: stats(initial),
    lazy: stats(lazy, ['faro', 'other']),
    replay: stats(lazy, ['replay']),
    recorder: stats(lazy, ['recorder']),
    allLazy: stats(lazy),
  };
}

const noRum = await measure(scenarios.noRum);
const rum = await measure(scenarios.rum);
const replay = await measure(scenarios.replay);
const provider = scenarios.provider ? await measure(scenarios.provider) : null;
const eagerAdded = rum.initial.gzip - noRum.initial.gzip;
const total = eagerAdded + rum.lazy.gzip;

console.log(`${pkg.name} RUM bundle cost (esbuild, minified, gzip -9, peer deps external):`);
console.log(`  RUM unused:  initial ${kb(noRum.initial.gzip)}; Faro reachable: ${noRum.initial.faro || noRum.allLazy.faro}; rrweb reachable: ${noRum.initial.rrweb || noRum.allLazy.rrweb}; lazy chunks: ${noRum.allLazy.chunks}`);
console.log(`  RUM enabled: initial ${kb(rum.initial.gzip)} (+${kb(eagerAdded)}, Faro in initial: ${rum.initial.faro})`);
console.log(`               lazy    ${kb(rum.lazy.gzip)} in ${rum.lazy.chunks} chunk(s), fetched only when RUM is enabled + sampled`);
if (provider) {
  console.log(`  ${providerSymbol} without rum: initial ${kb(provider.initial.gzip)}; Faro in initial: ${provider.initial.faro}; lazy (never fetched while rum is off): ${kb(provider.lazy.gzip)}`);
}
console.log(`  total added when enabled: ${kb(total)} (budget < ${kb(BUDGET_GZIP)})`);
console.log(`  Session replay (lazy, only when rum.replay is set):`);
console.log(`    controller ${kb(replay.replay.gzip)} (budget < ${kb(REPLAY_CONTROLLER_BUDGET_GZIP)}), fetched when replay is configured`);
console.log(`    recorder   ${kb(replay.recorder.gzip)} (budget < ${kb(REPLAY_RECORDER_BUDGET_GZIP)}), rrweb + gzip, fetched only after sampling + consent`);
console.log(`    rrweb in initial chunks: ${replay.initial.rrweb}; replay code in initial chunks: ${replay.initial.replay}`);

let failed = false;
if (noRum.initial.faro || noRum.allLazy.faro || noRum.allLazy.chunks) {
  console.error('FAIL: an app that does not use RUM can reach Faro');
  failed = true;
}
if (noRum.initial.rrweb || noRum.allLazy.rrweb || noRum.initial.replay) {
  console.error('FAIL: an app that does not use RUM can reach session replay / rrweb');
  failed = true;
}
if (rum.initial.rrweb || replay.initial.rrweb || replay.initial.replay || (provider && (provider.initial.rrweb || provider.initial.replay))) {
  console.error('FAIL: replay code or rrweb is in the initial chunks (must be lazy imports)');
  failed = true;
}
if (replay.replay.gzip >= REPLAY_CONTROLLER_BUDGET_GZIP || !replay.replay.chunks) {
  console.error('FAIL: replay controller missing or over budget');
  failed = true;
}
if (replay.recorder.gzip >= REPLAY_RECORDER_BUDGET_GZIP || !replay.recorder.chunks) {
  console.error('FAIL: replay recorder missing or over budget');
  failed = true;
}
if (rum.initial.faro) {
  console.error('FAIL: Faro is in the initial chunks (must be a lazy import)');
  failed = true;
}
if (provider && provider.initial.faro) {
  console.error(`FAIL: ${providerSymbol} pulls Faro into the initial chunks`);
  failed = true;
}
if (total >= BUDGET_GZIP) {
  console.error('FAIL: RUM exceeds the bundle budget');
  failed = true;
}
process.exit(failed ? 1 : 0);
