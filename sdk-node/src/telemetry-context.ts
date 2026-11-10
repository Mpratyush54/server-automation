// No OTel imports or context lookups until telemetry is enabled.
let correlate: (() => Record<string, string>) | undefined;
let emit: ((level: string, message: string, attributes: any) => void) | undefined;
export function setTelemetryContext(reader?: typeof correlate, writer?: typeof emit): void {
  correlate = reader;
  emit = writer;
}
export function traceContext(): Record<string, string> {
  try { return correlate?.() || {}; } catch { return {}; }
}
export function telemetryLog(level: string, message: string, attributes: any): void {
  try { emit?.(level, message, attributes); } catch { /* Observability must not crash the caller. */ }
}
