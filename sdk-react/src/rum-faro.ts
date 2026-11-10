/**
 * Grafana Faro wiring. Loaded only through `import('./rum-faro')` from rum.ts,
 * so bundlers put Faro in a separate lazy chunk that disabled apps never fetch.
 *
 * Uses faro-core's `initializeFaro` with an explicit instrumentation list
 * (errors, web vitals, session, view, performance) instead of the web-sdk
 * `initializeFaro`, which always pulls in ua-parser-js (~7 KB gzip), plus a
 * small transport and web-vitals reporter of our own (bundle budget).
 *
 * NOTE: shared verbatim between sdk-react and sdk-angular.
 */
import {
  initializeFaro,
  defaultBatchingConfig,
  defaultGlobalObjectKey,
  defaultInternalLoggerLevel,
  defaultLogArgsSerializer,
  defaultUnpatchedConsole,
  genShortID,
} from '@grafana/faro-core';
import {
  ErrorsInstrumentation,
  PerformanceInstrumentation,
  SessionInstrumentation,
  ViewInstrumentation,
  parseStacktrace,
} from '@grafana/faro-web-sdk';
import { SDK_NAME, SENSITIVE_INPUT_SELECTOR } from './rum-deps';
import { RumHandle, RumPlan, RumTransportItem, sanitizeUrl, scrubText, scrubTransportItem, shouldPropagate } from './rum';
import { ClientSpan, installPropagation } from './rum-propagation';
import { PlatformTransport } from './rum-transport';
import { PlatformWebVitalsInstrumentation } from './rum-vitals';

const EVENT_DOMAIN = 'platform.rum';

/** Short, stable-ish CSS selector for an element; never includes text or values. */
export function cssSelector(el: any, maxDepth = 5): string {
  const parts: string[] = [];
  let node = el;
  for (let depth = 0; node && node.nodeType === 1 && depth < maxDepth; depth++) {
    const tag = String(node.tagName || '').toLowerCase();
    if (!tag || tag === 'html') break;
    const named = node.getAttribute?.('data-rum-name') || node.getAttribute?.('data-testid');
    if (named) {
      parts.unshift(`${tag}[${node.getAttribute('data-rum-name') ? 'data-rum-name' : 'data-testid'}="${scrubText(named)}"]`);
      break;
    }
    if (node.id && /^[A-Za-z][\w-]{0,63}$/.test(node.id)) {
      parts.unshift(`${tag}#${node.id}`);
      break;
    }
    let part = tag;
    const classes = String(typeof node.className === 'string' ? node.className : '')
      .split(/\s+/)
      .filter((c) => c && /^[A-Za-z_-][\w-]{0,40}$/.test(c))
      .slice(0, 2);
    if (classes.length) part += '.' + classes.join('.');
    const parent = node.parentElement;
    if (parent && parent.children) {
      const same = Array.prototype.filter.call(parent.children, (c: any) => c.tagName === node.tagName);
      if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
    }
    parts.unshift(part);
    node = parent;
  }
  return parts.join(' > ');
}

/** Attributes for a click on `target` (selector + tag; text only when opted in and not sensitive). */
export function clickAttributes(target: any, captureText: boolean): Record<string, string> | null {
  const el = target && target.nodeType === 1 ? target : target?.parentElement;
  if (!el) return null;
  const actionable = el.closest?.('a,button,input,select,textarea,label,summary,[role="button"],[role="link"],[data-rum-name]') || el;
  const attrs: Record<string, string> = {
    selector: cssSelector(actionable),
    tag: String(actionable.tagName || '').toLowerCase(),
  };
  const masked = !!actionable.closest?.(SENSITIVE_INPUT_SELECTOR) || !!actionable.matches?.(SENSITIVE_INPUT_SELECTOR);
  if (masked) attrs.masked = 'true';
  const isField = /^(input|textarea|select)$/.test(attrs.tag);
  if (captureText && !masked && !isField) {
    const text = String(actionable.innerText ?? actionable.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 64);
    if (text) attrs.text = scrubText(text);
  }
  return attrs;
}

function attr(key: string, value: string | number | boolean) {
  if (typeof value === 'number') return { key, value: Number.isInteger(value) ? { intValue: value } : { doubleValue: value } };
  if (typeof value === 'boolean') return { key, value: { boolValue: value } };
  return { key, value: { stringValue: value } };
}

function unixNano(ms: number): string {
  return `${Math.round(ms * 1000)}000`;
}

/** OTLP/JSON trace payload for one client span (sent with `faro.api.pushTraces`). */
export function spanToOtlp(
  span: ClientSpan,
  plan: Pick<RumPlan, 'appName' | 'environment' | 'resource' | 'options'>,
  ctx: { sessionId?: string; viewId?: string; viewName?: string },
) {
  const url = sanitizeUrl(new URL(span.url, typeof location !== 'undefined' ? location.href : undefined).href, plan.options.captureQueryValues);
  let host = '';
  try {
    host = new URL(url).host;
  } catch {
    /* ignore */
  }
  const resourceAttrs = [attr('service.name', plan.appName), attr('telemetry.sdk.language', 'webjs')];
  if (plan.environment) resourceAttrs.push(attr('deployment.environment', plan.environment));
  for (const [k, v] of Object.entries(plan.resource || {})) if (typeof v === 'string') resourceAttrs.push(attr(k, v));
  const spanAttrs = [
    attr('http.request.method', span.method),
    attr('url.full', url),
    attr('server.address', host),
    attr('http.response.status_code', span.status),
  ];
  if (ctx.sessionId) spanAttrs.push(attr('session.id', ctx.sessionId));
  if (ctx.viewId) spanAttrs.push(attr('view.id', ctx.viewId));
  if (ctx.viewName) spanAttrs.push(attr('view.name', ctx.viewName));
  return {
    resourceSpans: [
      {
        resource: { attributes: resourceAttrs },
        scopeSpans: [
          {
            scope: { name: SDK_NAME },
            spans: [
              {
                traceId: span.traceId,
                spanId: span.spanId,
                name: `HTTP ${span.method}`,
                kind: 3, // SPAN_KIND_CLIENT
                startTimeUnixNano: unixNano(span.startMs),
                endTimeUnixNano: unixNano(Math.max(span.endMs, span.startMs)),
                attributes: spanAttrs,
                status: { code: span.error || span.status >= 500 ? 2 : 0 },
              },
            ],
          },
        ],
      },
    ],
  };
}

/** Faro core config for a plan (exported for tests). */
export function buildFaroConfig(plan: RumPlan, view: { id: string; name: string }) {
  const keepQuery = !!plan.options.captureQueryValues;
  const userBeforeSend = plan.options.beforeSend;
  const beforeSend = (item: any) => {
    const scrubbed = scrubTransportItem(item as RumTransportItem, keepQuery);
    return userBeforeSend ? userBeforeSend(scrubbed) : scrubbed;
  };
  const pageMeta = () => ({
    page: { id: view.id, url: typeof location !== 'undefined' ? sanitizeUrl(location.href, keepQuery) : '' },
  });
  const browserMeta = () => ({
    browser: {
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
      language: typeof navigator !== 'undefined' ? navigator.language : '',
      mobile: typeof navigator !== 'undefined' && /Mobi/.test(navigator.userAgent),
      viewportWidth: typeof window !== 'undefined' ? String(window.innerWidth) : '',
      viewportHeight: typeof window !== 'undefined' ? String(window.innerHeight) : '',
    },
  });
  const sdkMeta = () => ({ sdk: { name: SDK_NAME, integrations: [{ name: 'platform-rum' }] } });
  return {
    app: { name: plan.appName, version: plan.options.appVersion, environment: plan.environment },
    batching: { ...defaultBatchingConfig },
    dedupe: true,
    globalObjectKey: defaultGlobalObjectKey,
    instrumentations: [
      new ErrorsInstrumentation(),
      new PlatformWebVitalsInstrumentation(() => view.id),
      new SessionInstrumentation(),
      new ViewInstrumentation(),
      new PerformanceInstrumentation(),
    ],
    internalLoggerLevel: defaultInternalLoggerLevel,
    isolate: false,
    logArgsSerializer: defaultLogArgsSerializer,
    metas: [browserMeta, pageMeta, sdkMeta],
    parseStacktrace,
    paused: false,
    preventGlobalExposure: true,
    transports: [new PlatformTransport({ url: plan.faroEndpoint, token: plan.browserToken })],
    unpatchedConsole: defaultUnpatchedConsole,
    beforeSend,
    eventDomain: EVENT_DOMAIN,
    ignoreUrls: [plan.faroEndpoint, /\/collect(?:\/[\w]*)?$/],
    // Sampling already happened in planRum (unsampled sessions never load Faro).
    sessionTracking: {
      enabled: true,
      persistent: false,
      samplingRate: 1,
      session: { attributes: { ...plan.resource } },
    },
    view: { name: view.name },
    trackResources: plan.options.trackResources !== false,
  };
}

/** Start Faro, click tracking and trace propagation for a plan. */
export function startFaro(plan: RumPlan, initialView: string): RumHandle {
  const view = { id: genShortID(), name: initialView };
  const faro: any = initializeFaro(buildFaroConfig(plan, view) as any);
  const cleanups: Array<() => void> = [];
  const sessionId = () => faro?.api?.getSession?.()?.id as string | undefined;

  const pushEvent = (name: string, attributes?: Record<string, string>) => {
    try {
      faro.api.pushEvent(name, { view_id: view.id, ...(attributes || {}) }, EVENT_DOMAIN);
    } catch {
      /* ignore */
    }
  };

  if (typeof document !== 'undefined') {
    const onClick = (ev: Event) => {
      const attrs = clickAttributes(ev.target, !!plan.options.captureActionText);
      if (attrs) pushEvent('click', attrs);
    };
    document.addEventListener('click', onClick, true);
    cleanups.push(() => document.removeEventListener('click', onClick, true));
  }

  const origin = typeof location !== 'undefined' ? location.origin : undefined;
  let collector = '';
  try {
    collector = new URL(plan.faroEndpoint).href;
  } catch {
    /* ignore */
  }
  cleanups.push(
    installPropagation({
      allow: (url) => {
        try {
          if (collector && new URL(url, origin).href.startsWith(collector)) return false;
        } catch {
          return false;
        }
        return shouldPropagate(url, plan.propagateTo, origin);
      },
      onSpan: (span) => {
        try {
          faro.api.pushTraces(spanToOtlp(span, plan, { sessionId: sessionId(), viewId: view.id, viewName: view.name }));
        } catch {
          /* ignore */
        }
      },
    }),
  );

  return {
    setView(name: string) {
      if (!name || name === view.name) return;
      view.id = genShortID();
      view.name = name;
      try {
        faro.api.setView({ name });
      } catch {
        /* ignore */
      }
    },
    getSessionId: sessionId,
    getViewId: () => view.id,
    pushEvent,
    pushError(error: unknown, context?: Record<string, string>) {
      try {
        const err = error instanceof Error ? error : new Error(String(error));
        faro.api.pushError(err, context ? { context: { view_id: view.id, ...context } } : { context: { view_id: view.id } });
      } catch {
        /* ignore */
      }
    },
    stop() {
      cleanups.splice(0).forEach((fn) => fn());
      try {
        faro.pause?.();
        faro.instrumentations?.remove?.(...(faro.instrumentations?.instrumentations || []));
      } catch {
        /* ignore */
      }
    },
  };
}
