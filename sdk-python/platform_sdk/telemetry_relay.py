"""Bounded, authenticated telemetry transport. Imported only for enabled telemetry."""
import collections
import email.utils
import http.server
import random
import secrets
import threading
import time
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler

MAX_BYTES = 8 * 1024 * 1024
MAX_BATCHES = 16


def retry_delay(attempt, header=None):
    if header:
        try:
            return max(0, float(header))
        except ValueError:
            try:
                return max(0, email.utils.parsedate_to_datetime(header).timestamp() - time.time())
            except (ValueError, TypeError, OverflowError):
                pass
    return min(30, 2 ** attempt) * random.uniform(.5, 1.5)


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None  # Never forward bearer credentials to a redirect target.


class TelemetryRelay:
    def __init__(self, config):
        self.config = config
        self.dropped = 0
        self._queue = collections.deque()
        self._bytes = 0
        self._condition = threading.Condition()
        self._stop = threading.Event()
        self._server = None
        self._prefix = '/' + secrets.token_hex(24)
        self._opener = build_opener(NoRedirect())

    def start(self):
        relay = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                path = self.path[len(relay._prefix):]
                route = urlsplit(path).path
                if not self.path.startswith(relay._prefix + '/') or route not in (
                    '/v1/traces', '/v1/logs', '/v1/metrics', '/pyroscope/ingest'
                ):
                    self.send_error(404)
                    return
                try:
                    size = int(self.headers.get('Content-Length', '-1'))
                except ValueError:
                    size = -1
                if size < 0 or size > MAX_BYTES:
                    relay.dropped += 1
                    self.send_error(413)
                    return
                self.connection.settimeout(5)
                body = self.rfile.read(size)
                relay.enqueue(path, body, self.headers.get('Content-Type', 'application/octet-stream'), self.headers.get('Content-Encoding'))
                self.send_response(202)
                self.send_header('Content-Length', '0')
                self.end_headers()

        self._server = http.server.HTTPServer(('127.0.0.1', 0), Handler)
        threading.Thread(target=self._server.serve_forever, daemon=True).start()
        self._worker = threading.Thread(target=self._run, daemon=True)
        self._worker.start()
        return f'http://127.0.0.1:{self._server.server_port}{self._prefix}'

    def enqueue(self, path, body, content_type, encoding=None):
        with self._condition:
            if self._stop.is_set() or len(self._queue) >= MAX_BATCHES or self._bytes + len(body) > MAX_BYTES:
                self.dropped += 1
                return
            self._queue.append((path, body, content_type, encoding))
            self._bytes += len(body)
            self._condition.notify()

    def _send(self, batch):
        path, body, content_type, encoding = batch
        for attempt in range(3):
            cfg = self.config() or {}
            from .telemetry import expires_at
            if self._stop.is_set() or not cfg.get('enabled') or expires_at(cfg) <= time.time():
                return False
            profile = path.startswith('/pyroscope/')
            endpoint = cfg.get('profilesEndpoint' if profile else 'otlpEndpoint')
            if not endpoint:
                return False
            suffix = path[len('/pyroscope'):] if profile else path
            headers = {'Authorization': 'Bearer ' + cfg['ingestToken'], 'Content-Type': content_type}
            if encoding:
                headers['Content-Encoding'] = encoding
            retry_after = None
            try:
                request = Request(endpoint.rstrip('/') + suffix, body, headers, method='POST')
                with self._opener.open(request, timeout=5) as response:
                    return 200 <= response.status < 300
            except HTTPError as error:
                retry_after = error.headers.get('Retry-After')
                retryable = error.code in (408, 429, 500, 502, 503, 504)
                error.close()
                if not retryable:
                    return False
            except Exception:
                pass
            if attempt == 2 or self._stop.wait(retry_delay(attempt, retry_after)):
                return False
        return False

    def _run(self):
        while not self._stop.is_set():
            with self._condition:
                self._condition.wait_for(lambda: self._queue or self._stop.is_set())
                if self._stop.is_set():
                    return
                batch = self._queue[0]  # Count the in-flight batch against both limits.
            try:
                success = self._send(batch)
            except Exception:
                success = False
            with self._condition:
                self._queue.popleft()
                self._bytes -= len(batch[1])
                if not success:
                    self.dropped += 1

    def stop(self):
        self._stop.set()
        with self._condition:
            self._condition.notify_all()
        if self._server:
            self._server.shutdown()
            self._server.server_close()
        if hasattr(self, '_worker'):
            self._worker.join(timeout=6)
        with self._condition:
            self.dropped += len(self._queue)
            self._queue.clear()
            self._bytes = 0
