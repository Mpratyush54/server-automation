"""
Platform Python SDK
Auto-registration, metrics, logging, config, storage, DB connections
"""
import os
import time
import json
import socket
import logging
import threading
from typing import Optional, List, Dict, Any
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError

logger = logging.getLogger('platform')


class PlatformClient:
    def __init__(self):
        self.http = None
        self.options = {}
        self.initialized = False
        self._heartbeat_timer = None
        self._db_connections = {}

    def init(
        self,
        project_name: str,
        platform_url: str,
        environment_name: str = "development",
        version: str = "1.0.0",
        branch: str = "main",
        commit_sha: Optional[str] = None,
        namespace: Optional[str] = None,
        hostname: Optional[str] = None,
        databases: Optional[List[str]] = None,
        sdk_token: Optional[str] = None,
    ):
        token = sdk_token or os.environ.get("PLATFORM_SDK_TOKEN")
        if not token:
            logger.warning(
                "[platform] No SDK token configured (pass sdk_token= or set PLATFORM_SDK_TOKEN); "
                "Platform API calls will be rejected."
            )
        self.options = {
            "project_name": project_name,
            "platform_url": platform_url.rstrip("/"),
            "environment_name": environment_name,
            "version": version,
            "branch": branch,
            "commit_sha": commit_sha,
            "namespace": namespace,
            "hostname": hostname or socket.gethostname(),
            "databases": databases or [],
            "sdk_token": token,
        }

        self._register()
        self._start_heartbeat()

        if "postgres" in self.options["databases"]:
            from .db.postgres import PostgresManager
            self._db_connections["postgres"] = PostgresManager()
            try:
                self._db_connections["postgres"].connect()
            except Exception as e:
                logger.warning(f"PostgreSQL connection failed (non-blocking): {e}")

        if "mongo" in self.options["databases"]:
            from .db.mongo import MongoManager
            self._db_connections["mongo"] = MongoManager()
            try:
                self._db_connections["mongo"].connect()
            except Exception as e:
                logger.warning(f"MongoDB connection failed (non-blocking): {e}")

        if "redis" in self.options["databases"]:
            from .db.redis import RedisManager
            # Per-project ACL user + key prefix from the Platform; None -> PLATFORM_REDIS_* env.
            credentials = self._request("GET", "/api/sdk/db-credentials", params={
                "projectId": self.options["project_name"],
                "dbTypes": "redis",
                "environment": self.options["environment_name"],
            })
            redis_credentials = (credentials or {}).get("redis")
            provisioning_error = isinstance(redis_credentials, dict) and redis_credentials.get("status") == "error"
            redis_config = None
            if isinstance(redis_credentials, dict) and not provisioning_error:
                redis_config = {
                    key: redis_credentials[key]
                    for key in ("host", "port", "username", "password", "db", "url", "ssl")
                    if key in redis_credentials
                }
                if "keyPrefix" in redis_credentials:
                    redis_config["key_prefix"] = redis_credentials["keyPrefix"]
            # Always registered so client.db["redis"] exists; helpers no-op while disconnected.
            self._db_connections["redis"] = RedisManager(redis_config or None)
            if provisioning_error:
                logger.warning("Redis connection skipped: Platform Redis credentials are unavailable")
            else:
                try:
                    self._db_connections["redis"].connect()
                except Exception as e:
                    logger.warning(f"Redis connection failed (non-blocking): {e}")

        self.initialized = True

    def _request(self, method: str, path: str, data: Optional[Dict] = None,
                  params: Optional[Dict] = None) -> Optional[Dict]:
        url = f"{self.options['platform_url']}{path}"
        if params:
            url = f"{url}?{urlencode({k: v for k, v in params.items() if v is not None})}"

        headers = {"Content-Type": "application/json"}
        token = self.options.get("sdk_token")
        if token:
            headers["Authorization"] = f"Bearer {token}"
        body = json.dumps(data).encode() if data else None

        try:
            req = Request(url, data=body, headers=headers, method=method)
            with urlopen(req, timeout=5) as resp:
                raw = resp.read().decode()
                return json.loads(raw) if raw else {}
        except HTTPError as e:
            if e.code in (401, 403):
                logger.error(f"[platform] {method} {path} rejected ({e.code}): check sdk_token / PLATFORM_SDK_TOKEN")
            else:
                logger.warning(f"[platform] Request failed (silent): HTTP {e.code} {method} {path}")
            return None
        except URLError as e:
            logger.warning(f"[platform] Request failed (silent): {e}")
            return None
        except Exception as e:
            logger.warning(f"[platform] Request error (silent): {e}")
            return None

    def _register(self):
        result = self._request("POST", "/api/sdk/register", {
            "projectName": self.options["project_name"],
            "environmentName": self.options["environment_name"],
            "serviceName": self.options["project_name"],
            "version": self.options["version"],
            "branch": self.options["branch"],
            "commitSha": self.options["commit_sha"],
            "namespace": self.options["namespace"],
            "hostname": self.options["hostname"],
            "dbTypes": self.options["databases"],
        })
        if result is None:
            logger.error("[platform] Service registration failed; this service is NOT being monitored")
        return result

    def _start_heartbeat(self):
        def heartbeat():
            while True:
                time.sleep(15)
                self._request("POST", "/api/sdk/heartbeat", {
                    "projectId": self.options["project_name"],
                    "serviceName": self.options["project_name"],
                    "timestamp": time.time(),
                })

        t = threading.Thread(target=heartbeat, daemon=True)
        t.start()

    # --- Config ---
    def config(self, key: str) -> Optional[Any]:
        # SDK-token route (same contract as the Node SDK); /api/config requires a human JWT.
        data = self._request("GET", "/api/sdk/config", params={
            "projectId": self.options["project_name"],
            "environmentId": self.options.get("environment_name"),
        })
        if data and key in data:
            return data[key]
        return None

    # --- Storage ---
    def storage_upload(self, file_path: str, bucket: str):
        import os as _os
        size = _os.path.getsize(file_path)
        return self._request("POST", "/api/storage/upload-url", {
            "projectId": self.options["project_name"],
            "bucket": bucket,
            "originalName": _os.path.basename(file_path),
            "mimeType": "application/octet-stream",
            "size": size,
        })

    # --- Logging ---
    def log(self, level: str, message: str, metadata: Optional[Dict] = None):
        self._request("POST", "/api/sdk/logs", {"logs": [{
            "projectId": self.options["project_name"],
            "environment": self.options["environment_name"],
            "serviceName": self.options["project_name"],
            "hostname": self.options.get("hostname"),
            "level": level,
            "message": message,
            "metadata": metadata or {},
        }]})

    # --- DB Access ---
    @property
    def db(self):
        return self._db_connections

    def shutdown(self):
        for name, conn in self._db_connections.items():
            try:
                conn.disconnect()
            except Exception:
                pass


platform = PlatformClient()
