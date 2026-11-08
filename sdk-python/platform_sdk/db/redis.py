import os
import redis
import logging

logger = logging.getLogger('platform')

_TRUTHY = ("1", "true", "yes", "on")


def _env_config() -> dict:
    """Connection settings from PLATFORM_REDIS_* environment variables."""
    config = {
        "host": os.environ.get("PLATFORM_REDIS_HOST", "localhost"),
        "port": int(os.environ.get("PLATFORM_REDIS_PORT", "6379")),
        "password": os.environ.get("PLATFORM_REDIS_PASSWORD", None),
    }
    if os.environ.get("PLATFORM_REDIS_URL"):
        config["url"] = os.environ["PLATFORM_REDIS_URL"]
    if os.environ.get("PLATFORM_REDIS_DB"):
        config["db"] = int(os.environ["PLATFORM_REDIS_DB"])
    if os.environ.get("PLATFORM_REDIS_TLS", "").strip().lower() in _TRUTHY:
        config["ssl"] = True
    return config


class RedisManager:
    """Redis connection that authenticates as the project ACL user and confines
    helper operations to the project key prefix (parity with sdk-node RedisManager).

    Config keys: host, port, password, db, username, key_prefix, url (redis:// or
    rediss:// for TLS) plus any other redis-py keyword argument (e.g. ssl=True).
    """

    def __init__(self, config: dict = None):
        self.config = dict(config or _env_config())
        self.config.setdefault("username", os.environ.get("PLATFORM_REDIS_USERNAME"))
        self.key_prefix = self.config.pop(
            "key_prefix", os.environ.get("PLATFORM_REDIS_KEY_PREFIX", "")
        ) or ""
        self.client = None
        self.connected = False

    def connect(self):
        options = dict(self.config)
        url = options.pop("url", None)
        if url:
            # Values encoded in the URL (rediss:// enables TLS) take precedence over options.
            options = {k: v for k, v in options.items() if v is not None and k not in ("host", "port")}
            self.client = redis.Redis.from_url(url, **options, decode_responses=True)
        else:
            self.client = redis.Redis(**options, decode_responses=True)
        self.client.ping()
        self.connected = True
        logger.info("[platform] Redis connected")

    def prefixed(self, key):
        """Return ``key`` inside the project prefix. Applied once: a key that already
        starts with the prefix is returned unchanged. Raw ``client`` calls must wrap
        every key argument with this method."""
        prefix = self.key_prefix
        if isinstance(key, bytes):
            prefix = prefix.encode()
        if key.startswith(prefix):
            return key
        return prefix + key

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

    def delete(self, key: str):
        if self.client:
            return self.client.delete(self.prefixed(key))
        return None

    def disconnect(self):
        if self.client:
            self.client.close()
            self.connected = False
            logger.info("[platform] Redis disconnected")
