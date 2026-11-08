import { runOnce } from './run-once';
import { runTokenCleanup, TOKEN_CLEANUP_JOB } from '../lib/token-cleanup';

void runOnce(TOKEN_CLEANUP_JOB, runTokenCleanup);
