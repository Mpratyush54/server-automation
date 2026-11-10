"""No-network tests; also runnable without pytest: python -m unittest discover -s tests -p test_telemetry.py."""
import builtins
import datetime
import logging
import os
import sys
import time
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from platform_sdk import PlatformClient
from platform_sdk.telemetry import Telemetry, TraceCorrelationFilter, resource_attributes
from platform_sdk.telemetry_relay import TelemetryRelay, retry_delay, MAX_BATCHES


def config(token='plat_ingest_test'):
    return {'enabled': True, 'otlpEndpoint': 'https://otel.example.test',
            'profilesEndpoint': 'https://otel.example.test/pyroscope', 'ingestToken': token,
            'ingestTokenExpiresAt': (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=5)).isoformat(),
            'resource': {'platform.project_id': 'project-test', 'deployment.environment': 'production'}}


class TelemetryTests(unittest.TestCase):
    def setUp(self):
        self.options = {'project_name': 'app', 'environment_name': 'development', 'version': 'v2'}

    def test_disabled_never_imports_optional_packages_or_starts_timers(self):
        original = builtins.__import__
        def guarded(name, *args, **kwargs):
            if name.startswith(('opentelemetry', 'pyroscope')):
                self.fail('Optional telemetry package imported on disabled path')
            return original(name, *args, **kwargs)
        with patch('builtins.__import__', side_effect=guarded), patch('threading.Timer') as timer:
            for value in (None, {}, {'enabled': False}):
                Telemetry(self.options, MagicMock()).start(value)
            with patch.dict(os.environ, {'PLATFORM_OTEL_ENABLED': 'false'}):
                Telemetry(self.options, MagicMock()).start(config())
            timer.assert_not_called()

    def test_client_env_off_does_not_fetch_telemetry_config(self):
        client = PlatformClient()
        with patch.dict(os.environ, {'PLATFORM_OTEL_ENABLED': '0'}), patch.object(client, '_request', return_value={}) as request, patch.object(client, '_start_heartbeat'):
            client.init('app', 'https://platform.example.test')
            self.assertFalse(any(call.args[1] == '/api/sdk/config' for call in request.call_args_list))
            self.assertIsNone(client._telemetry)

    def test_platform_release_overrides_app_and_config_versions(self):
        with patch.dict(os.environ, {'PLATFORM_RELEASE': 'sha123', 'APP_VERSION': 'old'}, clear=True):
            cfg = config()
            cfg['resource']['service.version'] = 'stale'
            self.assertEqual(resource_attributes(self.options, cfg)['service.version'], 'sha123')

    def test_resource_uses_server_scope_and_downward_api(self):
        with patch.dict(os.environ, {'K8S_POD_NAME': 'pod-test'}, clear=True):
            attrs = resource_attributes(self.options, config())
        self.assertEqual(attrs['platform.project_id'], 'project-test')
        self.assertEqual(attrs['deployment.environment'], 'production')
        self.assertEqual(attrs['service.version'], 'v2')
        self.assertEqual(attrs['k8s.pod.name'], 'pod-test')

    def test_enabled_initializes_exporters_with_mocked_config_and_no_network(self):
        names = ('opentelemetry', 'opentelemetry.sdk.resources', 'opentelemetry.sdk.trace',
                 'opentelemetry.sdk.trace.sampling', 'opentelemetry.sdk.trace.export',
                 'opentelemetry.sdk.metrics', 'opentelemetry.sdk.metrics.export',
                 'opentelemetry.sdk._logs', 'opentelemetry.sdk._logs.export',
                 'opentelemetry.exporter.otlp.proto.http.trace_exporter',
                 'opentelemetry.exporter.otlp.proto.http.metric_exporter',
                 'opentelemetry.exporter.otlp.proto.http._log_exporter',
                 'opentelemetry.metrics', 'pyroscope', 'pyroscope.otel')
        modules = {name: MagicMock() for name in names}
        telemetry = Telemetry(self.options, lambda: {'telemetry': config()})
        with patch.dict(sys.modules, modules), patch('platform_sdk.telemetry_relay.TelemetryRelay') as relay, patch.object(telemetry, '_start_instrumentors'), patch('threading.Timer'), patch.object(logging.getLogger(), 'addHandler'), patch.object(logging.getLogger(), 'removeHandler'):
            relay.return_value.start.return_value = 'http://127.0.0.1:1234/private'
            telemetry.start(config())
            self.assertFalse(telemetry._stopped)
            modules['opentelemetry.exporter.otlp.proto.http.trace_exporter'].OTLPSpanExporter.assert_called_once_with(endpoint='http://127.0.0.1:1234/private/v1/traces')
            modules['opentelemetry.exporter.otlp.proto.http.metric_exporter'].OTLPMetricExporter.assert_called_once_with(endpoint='http://127.0.0.1:1234/private/v1/metrics')
            modules['opentelemetry.exporter.otlp.proto.http._log_exporter'].OTLPLogExporter.assert_called_once_with(endpoint='http://127.0.0.1:1234/private/v1/logs')
            tags = modules['pyroscope'].configure.call_args.kwargs['tags']
            self.assertEqual(tags['platform_project_id'], 'project-test')
            modules['pyroscope.otel'].PyroscopeSpanProcessor.assert_called_once()
            telemetry.shutdown()

    def test_refresh_rotates_token_before_expiry_without_reinstalling(self):
        telemetry = Telemetry(self.options, lambda: {'telemetry': config('plat_ingest_rotated')})
        telemetry.config = config()
        with patch('threading.Timer') as timer:
            telemetry._schedule()
            self.assertGreater(timer.call_args.args[0], 0)
            self.assertLess(timer.call_args.args[0], 300)
            telemetry.refresh()
        self.assertEqual(telemetry.config['ingestToken'], 'plat_ingest_rotated')

    def test_refresh_transient_failure_retries_but_revocation_stops(self):
        telemetry = Telemetry(self.options, lambda: None)
        telemetry.config = config()
        with patch('threading.Timer') as timer:
            telemetry.refresh()
            self.assertEqual(timer.call_args.args[0], 5)
        telemetry.fetch_config = lambda: {'telemetry': {'enabled': False}}
        telemetry.refresh()
        self.assertTrue(telemetry._stopped)

    def test_rejects_expired_or_insecure_configuration(self):
        for changes in ({'ingestTokenExpiresAt': '2000-01-01T00:00:00Z'}, {'otlpEndpoint': 'http://otel.example.test'}, {'otlpEndpoint': 'https://user:password@otel.example.test'}):
            with self.assertRaises(ValueError):
                Telemetry.validate({**config(), **changes})

    def test_relay_bounded_and_drop_counted(self):
        relay = TelemetryRelay(config)
        for _ in range(MAX_BATCHES + 2):
            relay.enqueue('/v1/traces', b'test', 'application/json')
        self.assertEqual(len(relay._queue), MAX_BATCHES)
        self.assertEqual(relay.dropped, 2)
        relay.stop()

    def test_relay_reads_current_token_for_otlp_and_profiles(self):
        cfg = config()
        relay = TelemetryRelay(lambda: cfg)
        response = MagicMock()
        response.__enter__.return_value.status = 200
        relay._opener.open = MagicMock(return_value=response)
        for path in ('/v1/traces', '/v1/logs', '/v1/metrics', '/pyroscope/ingest?name=app'):
            cfg['ingestToken'] = 'plat_ingest_rotated'
            self.assertTrue(relay._send((path, b'payload', 'application/json', None)))
            request = relay._opener.open.call_args.args[0]
            self.assertEqual(request.get_header('Authorization'), 'Bearer plat_ingest_rotated')
            self.assertTrue(request.full_url.startswith('https://otel.example.test/'))

    def test_relay_never_sends_expired_credentials(self):
        relay = TelemetryRelay(lambda: {**config(), 'ingestTokenExpiresAt': '2000-01-01T00:00:00Z'})
        relay._opener.open = MagicMock()
        self.assertFalse(relay._send(('/v1/traces', b'x', 'application/json', None)))
        relay._opener.open.assert_not_called()

    def test_429_retry_after_and_bounded_failures(self):
        from urllib.error import HTTPError
        relay = TelemetryRelay(config)
        relay._opener.open = MagicMock(side_effect=HTTPError('https://otel.example.test', 429, 'busy', {'Retry-After': '7'}, None))
        relay._stop.wait = MagicMock(return_value=False)
        self.assertFalse(relay._send(('/v1/traces', b'x', 'application/json', None)))
        self.assertEqual(relay._opener.open.call_count, 3)
        self.assertEqual(relay._stop.wait.call_args.args[0], 7)
        self.assertEqual(retry_delay(0, '9'), 9)

    def test_sdk_logs_include_correlation(self):
        client = PlatformClient()
        client.options = self.options
        client._telemetry = MagicMock()
        client._telemetry.trace_context.return_value = {'trace_id': 'a' * 32, 'span_id': 'b' * 16}
        with patch.object(client, '_request') as request:
            client.log('INFO', 'query', {'custom': 'value'})
        entry = request.call_args.args[2]['logs'][0]
        self.assertEqual(entry['trace_id'], 'a' * 32)
        self.assertEqual(entry['metadata']['span_id'], 'b' * 16)

    def test_in_memory_resource_and_logging_filter(self):
        try:
            from opentelemetry import trace
            from opentelemetry.sdk.resources import Resource
            from opentelemetry.sdk.trace import TracerProvider
            from opentelemetry.sdk.trace.export import SimpleSpanProcessor
            from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
        except ImportError:
            self.skipTest('Optional OpenTelemetry packages unavailable')
        exporter = InMemorySpanExporter()
        provider = TracerProvider(resource=Resource(resource_attributes(self.options, config())))
        provider.add_span_processor(SimpleSpanProcessor(exporter))
        with provider.get_tracer('test').start_as_current_span('query') as span:
            record = logging.LogRecord('test', logging.INFO, '', 0, 'query', (), None)
            TraceCorrelationFilter().filter(record)
            self.assertEqual(record.trace_id, format(span.get_span_context().trace_id, '032x'))
        self.assertEqual(exporter.get_finished_spans()[0].resource.attributes['platform.project_id'], 'project-test')
        provider.shutdown()


if __name__ == '__main__':
    unittest.main()
