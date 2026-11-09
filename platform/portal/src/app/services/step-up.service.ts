import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { isStepUpRequired } from './mfa.service';

export interface StepUpRequest {
  reason: string;
  resolve: (ok: boolean) => void;
}

/**
 * Step-up for sensitive actions (#24). `run()` retries an action once after the user confirms a
 * fresh second factor in the step-up modal (shared/step-up-modal.component.ts), when the API
 * answered 401 `step_up_required`.
 */
@Injectable({ providedIn: 'root' })
export class StepUpService {
  readonly request$ = new BehaviorSubject<StepUpRequest | null>(null);

  /** Ask for a code. Resolves true after a successful step-up, false when cancelled. */
  request(reason = 'Confirm it is you'): Promise<boolean> {
    this.request$.value?.resolve(false);
    return new Promise<boolean>((resolve) => {
      const req: StepUpRequest = {
        reason,
        resolve: (ok: boolean) => {
          if (this.request$.value === req) this.request$.next(null);
          resolve(ok);
        },
      };
      this.request$.next(req);
    });
  }

  /** Run `action`; on `step_up_required` ask for a code and retry once. */
  async run<T>(action: () => Promise<T>, reason?: string): Promise<T> {
    try {
      return await action();
    } catch (err) {
      if (!isStepUpRequired(err)) throw err;
      if (!(await this.request(reason))) throw err;
      return action();
    }
  }
}
