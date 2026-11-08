import { runOnce } from './run-once';
import { runDecayCheck, PREVIEW_DECAY_JOB } from '../lib/preview-decay';

void runOnce(PREVIEW_DECAY_JOB, runDecayCheck);
