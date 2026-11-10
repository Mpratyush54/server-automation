"""Optional observability lifecycle; importing this module imports no OTel/native modules."""
import datetime
import importlib
import logging
import math
import os
import threading
import time
from urllib.parse import urlsplit


def allowed():
    return os.getenv('PLATFORM_OTEL_ENABLED', '').lower() not in ('false', '0', 'off')


def expires_at(config):
    try:
        return datetime.datetime.fromisoformat(config['ingestTokenExpiresAt'].replace('Z', '+00:00')).timestamp()
    except (KeyError, ValueError, TypeError):
        return 0


def resource_attributes(options, config):
    attrs = {
        'service.name': os.getenv('OTEL_SERVICE_NAME') or options['project_name'],
        'service.version': os.getenv('APP_VERSION') or os.getenv('OTEL_SERVICE_VERSION') or options.get('version') or options.get('commit_sha') or os.getenv('GIT_SHA') or 'unknown',
        'deployment.environment': options.get('environment_name', 'development'),
        **config.get('resource', {}),
    }
    for suffix, env in (('namespace.name', 'K8S_NAMESPACE'), ('pod.name', 'K8S_POD_NAME'),
                        ('pod.uid', 'K8S_POD_UID'), ('node.name', 'K8S_NODE_NAME'),
                        ('container.name', 'K8S_CONTAINER_NAME'), ('deployment.name', 'K8S_DEPLOYMENT_NAME')):
        if os.getenv(env):
            attrs['k8s.' + suffix] = os.environ[env]
    return attrs


class TraceCorrelationFilter(logging.Filter):
    def filter(self, record):
        if record.name.startswith(('opentelemetry.', 'urllib3.', 'pyroscope')):
            return False  # Do not recursively export diagnostics from exporters/profilers.
        from opentelemetry import trace
        context = trace.get_current_span().get_span_context()
        if context.is_valid:
            record.trace_id = format(context.trace_id, '032x')
            record.span_id = format(context.span_id, '016x')
        return True


class Telemetry:
    def __init__(self, options, fetch_config):
        self.options = options
        self.fetch_config = fetch_config
        self.config = None
        self._timer = None
        self._stopped = False
        self._relay = None
        self._providers = []
        self._instrumentors = []
        self._handler = None
        self._profiler = None
        self._lock = threading.Lock()

    @staticmethod
    def validate(config):
        if not config.get('ingestToken') or expires_at(config) <= time.time():
            raise ValueError('Invalid telemetry credentials')
        if not config.get('otlpEndpoint'):
            raise ValueError('Missing OTLP endpoint')
        for endpoint in (config.get('otlpEndpoint'), config.get('profilesEndpoint')):
            if endpoint:
                parsed = urlsplit(endpoint)
                if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
                    raise ValueError('Invalid collector URL')
        return config

    def start(self, config):
        if not allowed() or not config or not config.get('enabled'):
            return
        try:
            self.config = self.validate(config)
            from opentelemetry import trace, metrics
            from opentelemetry.sdk.resources import Resource
            from opentelemetry.sdk.trace import TracerProvider
            from opentelemetry.sdk.trace.sampling import ParentBased, TraceIdRatioBased
            from opentelemetry.sdk.trace.export import BatchSpanProcessor
            from opentelemetry.sdk.metrics import MeterProvider
            from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
            from opentelemetry.sdk._logs import LoggerProvider, LoggingHandler
            from opentelemetry.sdk._logs.export import BatchLogRecordProcessor
            from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
            from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
            from opentelemetry.exporter.otlp.proto.http._log_exporter import OTLPLogExporter
            from .telemetry_relay import TelemetryRelay
            self._relay = TelemetryRelay(lambda: self.config)
            base = self._relay.start()
            attrs = resource_attributes(self.options, config)
            resource = Resource.create(attrs)
            try:
                ratio = float(os.getenv('PLATFORM_OTEL_SAMPLING_RATIO', config.get('samplingRatio', 1)))
                ratio = min(1, max(0, ratio)) if math.isfinite(ratio) else 1
            except (ValueError, TypeError):
                ratio = 1
            provider = TracerProvider(resource=resource, sampler=ParentBased(TraceIdRatioBased(ratio)))
            self._providers.append(provider)
            provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(endpoint=base + '/v1/traces'), max_queue_size=512, max_export_batch_size=64))
            trace.set_tracer_provider(provider)
            meter_provider = MeterProvider(resource=resource, metric_readers=[PeriodicExportingMetricReader(OTLPMetricExporter(endpoint=base + '/v1/metrics'), export_interval_millis=30000)])
            self._providers.append(meter_provider)
            metrics.set_meter_provider(meter_provider)
            from opentelemetry.metrics import Observation
            meter_provider.get_meter('platform-sdk').create_observable_gauge(
                'platform.telemetry.dropped_batches', callbacks=[lambda _: [Observation(self.dropped)]],
                description='Batches dropped by the bounded telemetry transport')
            logs = LoggerProvider(resource=resource)
            self._providers.append(logs)
            logs.add_log_record_processor(BatchLogRecordProcessor(OTLPLogExporter(endpoint=base + '/v1/logs'), max_queue_size=512, max_export_batch_size=64))
            self._handler = LoggingHandler(level=logging.NOTSET, logger_provider=logs)
            self._handler.addFilter(TraceCorrelationFilter())
            logging.getLogger().addHandler(self._handler)
            self._start_instrumentors(provider, meter_provider)
            if os.getenv('PLATFORM_PROFILING_ENABLED', '').lower() not in ('false', '0', 'off') and config.get('profilesEndpoint'):
                try:
                    import pyroscope
                    pyroscope.configure(application_name=attrs['service.name'], server_address=base + '/pyroscope', tags={
                        'platform_project_id': attrs.get('platform.project_id', self.options['project_name']),
                        'deployment_environment': attrs['deployment.environment'], 'service_version': attrs['service.version'],
                    })
                    self._profiler = pyroscope
                    from pyroscope.otel import PyroscopeSpanProcessor
                    provider.add_span_processor(PyroscopeSpanProcessor())
                except (ImportError, OSError, RuntimeError):
                    pass  # Native profiling may be unavailable on the host OS.
            self._schedule()
        except Exception:
            self.shutdown()  # Fail open without exposing collector credentials.

    def _start_instrumentors(self, provider, meter_provider):
        import re
        excluded = os.getenv('PLATFORM_OTEL_EXCLUDE_ROUTES', '/health,/healthz,/ready,/readyz,/api/health')
        paths = [re.escape(x.strip()) for x in excluded.split(',') if x.strip()]
        # OTel Python exclusion lists match full URLs. Exclude SDK traffic to prevent recursion.
        regex = ','.join([r'.*/' + self._relay._prefix.lstrip('/') + r'/.*', r'.*/api/sdk/.*'] + [r'.*' + p + r'(/.*|\?.*|$)' for p in paths])
        # Django/requests read their exclusion env during module import, while Flask
        # and FastAPI also accept excluded_urls as a keyword argument.
        self._exclusion_env = {}
        for library in ('REQUESTS', 'FLASK', 'FASTAPI', 'DJANGO'):
            key = 'OTEL_PYTHON_' + library + '_EXCLUDED_URLS'
            self._exclusion_env[key] = os.environ.get(key)
            os.environ[key] = ','.join(filter(None, [os.environ.get(key), regex]))
        for name, class_name in (('requests', 'RequestsInstrumentor'), ('flask', 'FlaskInstrumentor'),
                                 ('fastapi', 'FastAPIInstrumentor'), ('django', 'DjangoInstrumentor'),
                                 ('psycopg', 'PsycopgInstrumentor'), ('psycopg2', 'Psycopg2Instrumentor'),
                                 ('pymongo', 'PymongoInstrumentor'), ('redis', 'RedisInstrumentor')):
            try:
                module = importlib.import_module('opentelemetry.instrumentation.' + name)
                instrumentor = getattr(module, class_name)()
                instrumentor.instrument(tracer_provider=provider, meter_provider=meter_provider, excluded_urls=regex)
                self._instrumentors.append(instrumentor)
            except (ImportError, ModuleNotFoundError):
                pass

    def trace_context(self):
        if not self._providers or self._stopped:
            return {}
        from opentelemetry import trace
        context = trace.get_current_span().get_span_context()
        return {'trace_id': format(context.trace_id, '032x'), 'span_id': format(context.span_id, '016x')} if context.is_valid else {}

    def emit(self, level, message, metadata):
        if self._handler and not self._stopped:
            record = logging.LogRecord('platform.sdk', getattr(logging, level.upper(), logging.INFO), '', 0, message, (), None)
            for key, value in metadata.items():
                if key not in record.__dict__:
                    setattr(record, key, value)
            self._handler.handle(record)

    def _schedule(self, retry=False):
        if self._stopped or not self.config:
            return
        remaining = expires_at(self.config) - time.time()
        delay = 5 if retry else max(.1, remaining - min(60, remaining * .1))
        self._timer = threading.Timer(delay, self.refresh)
        self._timer.daemon = True
        self._timer.start()

    def refresh(self):
        if self._stopped:
            return
        if self._timer:
            self._timer.cancel()
        if not self._lock.acquire(blocking=False):
            return
        try:
            data = self.fetch_config()
            if self._stopped:
                return
            if data is None:
                raise ValueError('Config temporarily unavailable')
            if not allowed() or not data.get('telemetry', {}).get('enabled'):
                self.shutdown()
                return
            self.config = self.validate(data['telemetry'])
            self._schedule()
        except Exception:
            self._schedule(retry=True)
        finally:
            self._lock.release()

    @property
    def dropped(self):
        return self._relay.dropped if self._relay else 0

    def shutdown(self):
        self._stopped = True
        if self._timer:
            self._timer.cancel()
        if self._handler:
            logging.getLogger().removeHandler(self._handler)
            self._handler = None
        for instrumentor in reversed(self._instrumentors):
            try:
                instrumentor.uninstrument()
            except Exception:
                pass
        self._instrumentors.clear()
        for key, value in getattr(self, '_exclusion_env', {}).items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        if self._profiler:
            try:
                self._profiler.shutdown()
            except Exception:
                pass
            self._profiler = None
        for provider in self._providers:
            try:
                provider.shutdown()
            except Exception:
                pass
        self._providers.clear()
        if self._relay:
            self._relay.stop()
