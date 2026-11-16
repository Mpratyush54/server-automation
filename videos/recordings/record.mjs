#!/usr/bin/env node
// Record one or more feature clips from a live Cairn install.
//   node --env-file=recording.env record.mjs deploy-from-git observability
//   node --env-file=recording.env record.mjs all
// Raw videos and marks land in out/<clip>/; then run post/process.mjs.
import { CLIPS } from './lib/clips.mjs';

const wanted = process.argv.slice(2);
if (!wanted.length) {
  console.error(`Usage: node record.mjs <clip...|all>\nClips: ${CLIPS.join(', ')}`);
  process.exit(2);
}
const clips = wanted.includes('all') ? CLIPS : wanted;
for (const clip of clips) {
  if (!CLIPS.includes(clip)) throw new Error(`Unknown clip "${clip}". Clips: ${CLIPS.join(', ')}`);
}
let failed = 0;
for (const clip of clips) {
  console.log(`\n== Recording ${clip}`);
  try {
    const { record } = await import(`./clips/${clip}.mjs`);
    await record();
  } catch (error) {
    failed++;
    console.error(`!! ${clip} failed: ${error.stack || error}`);
  }
}
process.exit(failed ? 1 : 0);
