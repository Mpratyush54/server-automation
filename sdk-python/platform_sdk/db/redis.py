import redis
import logging

logger = logging.getLogger('platform')


class RedisManager:
    def __init__(self, config: dict = None):
        import os as _os
        self.config = config or {
            "host": _os.environ.get("PLATFORM_REDIS_HOST", "localhost"),
            "port": int(_os.environ.get("PLATFORM_REDIS_PORT", "6379")),
            "password": _os.environ.get("PLATFORM_REDIS_PASSWORD", None),
        }
        self.config = dict(self.config)
        self.config.setdefault("username", _os.environ.get("PLATFORM_REDIS_USERNAME"))
        self.key_prefix = self.config.pop(
            "key_prefix", _os.environ.get("PLATFORM_REDIS_KEY_PREFIX", "")
        ) or ""
        self.client = None
        self.connected = False

    def connect(self):
        self.client = redis.Redis(**self.config, decode_responses=True)
        self.client.ping()
        self.connected = True
        logger.info("[platform] Redis connected")

    def get(self, key: str) -> str:
        if self.client:
            return self.client.get(self.prefixed(key))
        return None

    def set(self, key: str, value: str, ttl: int = None):
        if self.client:
            if ttl:
                self.client.setex(self.prefixed(key), ttl, value)
            else:
                self.client.set(self.prefixed(key), value)

    def prefixed(self, key: str) -> str:
        """Return a project key, leaving an already-prefixed key unchanged."""
        if key.startswith(self.key_prefix):
            return key
        return self.key_prefix + key

    def delete(self, key: str):
        if self.client:
            return self.client.delete(self.prefixed(key))

    def disconnect(self):
        if self.client:
            self.client.close()
            self.connected = False
            logger.info("[platform] Redis disconnected")
