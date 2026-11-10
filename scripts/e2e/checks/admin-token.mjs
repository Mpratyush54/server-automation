// node admin-token.mjs
// Prints a full admin session token (through the MFA challenge, see adminSession)
// to stdout, for shell scripts to capture: TOKEN=$(node admin-token.mjs).
// Callers must never echo the captured value. Errors go to stderr, exit 1.
import { adminSession } from './common.mjs';

try {
  const { token } = await adminSession({ log: (m) => console.error(`  ..   ${m}`) });
  process.stdout.write(`${token}\n`);
} catch (e) {
  console.error(`admin session failed: ${e?.message || e}`);
  process.exit(1);
}
