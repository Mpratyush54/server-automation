/** SMTP send time is bounded: transport timeouts and an overall deadline. */
const mockTransport = { sendMail: jest.fn(), close: jest.fn() };
const mockCreateTransport = jest.fn((_opts: any) => mockTransport);
jest.mock('nodemailer', () => ({ __esModule: true, default: { createTransport: (o: any) => mockCreateTransport(o) } }));

import { sendMail, smtpTimeouts, transportOptions, DEFAULT_SMTP_TIMEOUT_MS, SmtpTimeoutError } from '../../../src/lib/smtp-service';

beforeEach(() => {
  mockTransport.sendMail.mockReset();
  mockTransport.close.mockReset();
  mockCreateTransport.mockClear();
});

describe('SMTP timeouts', () => {
  it('every provider gets connect / greeting / socket timeouts bounded by timeoutMs', () => {
    for (const provider of ['custom', 'ses', 'sendgrid', 'mailgun'] as const) {
      const o = transportOptions({ provider, host: 'smtp.example.test', fromEmail: 'a@example.test' }, 10_000);
      expect(o).toMatchObject({ connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 10_000 });
    }
    expect(smtpTimeouts().connectionTimeout).toBe(DEFAULT_SMTP_TIMEOUT_MS);
    expect(DEFAULT_SMTP_TIMEOUT_MS).toBeLessThan(120_000);
  });

  it('sendMail passes the timeouts to nodemailer and closes the transport', async () => {
    mockTransport.sendMail.mockResolvedValue({});
    await sendMail({ provider: 'custom', host: 'smtp.example.test', fromEmail: 'a@example.test' }, ['x@example.test'], 's', 'h', { timeoutMs: 3_000 });
    expect(mockCreateTransport.mock.calls[0][0]).toMatchObject({ host: 'smtp.example.test', connectionTimeout: 3_000, socketTimeout: 3_000 });
    expect(mockTransport.close).toHaveBeenCalled();
  });

  it('an unresponsive server fails within the deadline instead of hanging', async () => {
    jest.useFakeTimers();
    try {
      mockTransport.sendMail.mockReturnValue(new Promise(() => {}));
      const p = sendMail({ provider: 'custom', host: 'blackhole.example.test', fromEmail: 'a@example.test' }, 'x@example.test', 's', 'h', { timeoutMs: 2_000 });
      const assertion = expect(p).rejects.toBeInstanceOf(SmtpTimeoutError);
      jest.advanceTimersByTime(2_001);
      await assertion;
      expect(mockTransport.close).toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });
});
