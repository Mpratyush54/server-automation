"""
CAPS Platform Python SDK
Auto-registration, metrics, logging, config, storage, DB connections
"""
import os
import time
import json
import logging
import threading
from typing import Optional, List, Dict, Any
from urllib.request import Request, urlopen
from urllib.error import URLError

logger = logging.getLogger('caps')


class CapsClient:
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
    ):
        self.options = {
            "project_name": project_name,
            "platform_url": platform_url.rstrip("/"),
            "environment_name": environment_name,
            "version": version,
            "branch": branch,
            "commit_sha": commit_sha,
            "namespace": namespace,
            "hostname": hostname or os.uname().nodename,
            "databases": databases or [],
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
            self._db_connections["redis"] = RedisManager()
            try:
                self._db_connections["redis"].connect()
            except Exception as e:
                logger.warning(f"Redis connection failed (non-blocking): {e}")

        self.initialized = True

    def _request(self, method: str, path: str, data: Optional[Dict] = None,
                  params: Optional[Dict] = None) -> Optional[Dict]:
        url = f"{self.options['platform_url']}{path}"
        if params:
            qs = "&".join(f"{k}={v}" for k, v in params.items())
            url = f"{url}?{qs}"

        headers = {"Content-Type": "application/json"}
        body = json.dumps(data).encode() if data else None

        try:
            req = Request(url, data=body, headers=headers, method=method)
            with urlopen(req, timeout=5) as resp:
                return json.loads(resp.read().decode())
        except URLError as e:
            logger.warning(f"[caps] Request failed (silent): {e}")
            return None
        except Exception as e:
            logger.warning(f"[caps] Request error (silent): {e}")
            return None

    def _register(self):
        return self._request("POST", "/api/sdk/register", {
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
        data = self._request("GET", "/api/config", params={
            "projectId": self.options["project_name"],
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
        self._request("POST", "/api/logs/ingest", {
            "projectId": self.options["project_name"],
            "environmentId": self.options["environment_name"],
            "serviceName": self.options["project_name"],
            "level": level,
            "message": message,
            "metadata": metadata or {},
        })

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


caps = CapsClient()
