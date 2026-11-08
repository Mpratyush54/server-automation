import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// A supplied denylist adds to the built-in list; it cannot disable it.
const builtin = new URL('./server-address-denylist.txt', import.meta.url);
const sources = [builtin, ...process.argv.slice(2)];
if (process.env.SERVER_ADDRESS_DENYLIST) sources.push(process.env.SERVER_ADDRESS_DENYLIST);
const patterns = sources.flatMap(source => readFileSync(source, 'utf8').split(/\r?\n/))
  .map(line => line.trim()).filter(line => line && !line.startsWith('#'))
  .map(line => new RegExp(line));
const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).split('\0').filter(Boolean);
let failed = false;
for (const file of files) {
  let content;
  try { content = readFileSync(path.join(root, file), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') continue; throw error; }
  if (content.includes('\0')) continue; // Binary artifacts.
  content.split(/\r?\n/).forEach((line, index) => {
    if (patterns.some(pattern => pattern.test(line))) {
      // Report locations only: the matching line might contain credentials.
      console.error(`${file}:${index + 1}: denylisted server address`);
      failed = true;
    }
  });
}
if (failed) process.exitCode = 1;
else console.log('No denylisted server addresses in tracked files.');
