import pytest
from unittest.mock import patch, MagicMock
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from platform_sdk.db.redis import RedisManager


@pytest.fixture(autouse=True)
def _clean_redis_env(monkeypatch):
    """Keep developer PLATFORM_REDIS_* variables from leaking into assertions."""
    for name in list(os.environ):
        if name.startswith("PLATFORM_REDIS_"):
            monkeypatch.delenv(name, raising=False)


class TestRedisManager:
    def test_init_with_config(self):
        config = {"host": "localhost", "port": 6379, "password": None}
        manager = RedisManager(config)
        assert manager.config == {**config, "username": None}
        assert manager.connected is False

    def test_init_without_config(self):
        manager = RedisManager()
        assert manager.connected is False

    @patch('platform_sdk.db.redis.redis.Redis')
    def test_connect_success(self, mock_redis_class):
        mock_client = MagicMock()
        mock_redis_class.return_value = mock_client

        manager = RedisManager({"host": "localhost", "port": 6379})
        manager.connect()

        assert manager.connected is True
        mock_client.ping.assert_called_once()

    @patch('platform_sdk.db.redis.redis.Redis')
    def test_connect_failure(self, mock_redis_class):
        mock_client = MagicMock()
        mock_client.ping.side_effect = Exception("Connection refused")
        mock_redis_class.return_value = mock_client

        manager = RedisManager({"host": "localhost"})
        with pytest.raises(Exception, match="Connection refused"):
            manager.connect()

        assert manager.connected is False

    def test_get_when_not_connected(self):
        manager = RedisManager()
        assert manager.get("key") is None

    @patch('platform_sdk.db.redis.redis.Redis')
    def test_get_when_connected(self, mock_redis_class):
        mock_client = MagicMock()
        mock_client.get.return_value = "test-value"
        mock_redis_class.return_value = mock_client

        manager = RedisManager({})
        manager.connect()

        result = manager.get("test-key")
        assert result == "test-value"
        mock_client.get.assert_called_once_with("test-key")

    def test_set_when_not_connected(self):
        manager = RedisManager()
        manager.set("key", "value")  # Should not raise

    @patch('platform_sdk.db.redis.redis.Redis')
    def test_set_when_connected(self, mock_redis_class):
        mock_client = MagicMock()
        mock_redis_class.return_value = mock_client

        manager = RedisManager({})
        manager.connect()
        manager.set("key", "value")

        mock_client.set.assert_called_once_with("key", "value")

    @patch('platform_sdk.db.redis.redis.Redis')
    def test_set_with_ttl(self, mock_redis_class):
        mock_client = MagicMock()
        mock_redis_class.return_value = mock_client

        manager = RedisManager({})
        manager.connect()
        manager.set("key", "value", ttl=3600)

        mock_client.setex.assert_called_once_with("key", 3600, "value")

    @patch('platform_sdk.db.redis.redis.Redis')
    def test_disconnect(self, mock_redis_class):
        mock_client = MagicMock()
        mock_redis_class.return_value = mock_client

        manager = RedisManager({})
        manager.connect()
        manager.disconnect()

        assert manager.connected is False
        mock_client.close.assert_called_once()

    def test_disconnect_when_not_connected(self):
        manager = RedisManager()
        manager.disconnect()  # Should not raise

    @patch.dict(os.environ, {"PLATFORM_REDIS_USERNAME": "project-user",
                            "PLATFORM_REDIS_KEY_PREFIX": "project:"}, clear=True)
    @patch('platform_sdk.db.redis.redis.Redis')
    def test_acl_environment(self, mock_redis_class):
        manager = RedisManager()
        manager.connect()
        mock_redis_class.assert_called_once_with(
            host="localhost", port=6379, password=None,
            username="project-user", decode_responses=True,
        )
        assert manager.prefixed("key") == "project:key"

    @patch.dict(os.environ, {"PLATFORM_REDIS_USERNAME": "env-user",
                            "PLATFORM_REDIS_KEY_PREFIX": "env:"}, clear=True)
    @patch('platform_sdk.db.redis.redis.Redis')
    def test_acl_config_overrides_environment_without_mutation(self, mock_redis_class):
        config = {"host": "redis", "username": "project-user", "password": "secret",
                  "key_prefix": "project:", "db": 0}
        manager = RedisManager(config)
        manager.connect()
        mock_redis_class.assert_called_once_with(
            host="redis", username="project-user", password="secret", db=0,
            decode_responses=True,
        )
        assert config["key_prefix"] == "project:"
        assert manager.prefixed("key") == "project:key"

    @pytest.mark.parametrize("key", ["key", "project:key"])
    @patch('platform_sdk.db.redis.redis.Redis')
    def test_operations_prefix_once(self, mock_redis_class, key):
        manager = RedisManager({"username": "project-user", "key_prefix": "project:"})
        manager.connect()
        client = mock_redis_class.return_value
        manager.set(key, "value")
        manager.set(key, "value", ttl=60)
        manager.get(key)
        manager.delete(key)
        client.set.assert_called_once_with("project:key", "value")
        client.setex.assert_called_once_with("project:key", 60, "value")
        client.get.assert_called_once_with("project:key")
        client.delete.assert_called_once_with("project:key")
        assert manager.prefixed(manager.prefixed(key)) == "project:key"

    @patch.dict(os.environ, {"PLATFORM_REDIS_KEY_PREFIX": "env:"}, clear=True)
    def test_explicit_empty_prefix_preserves_legacy_keys(self):
        manager = RedisManager({"key_prefix": ""})
        assert manager.prefixed("key") == "key"

    def test_delete_when_not_connected(self):
        assert RedisManager().delete("key") is None

    @patch('platform_sdk.db.redis.redis.Redis')
    def test_bytes_keys_prefixed_once(self, mock_redis_class):
        manager = RedisManager({"key_prefix": "project:"})
        assert manager.prefixed(b"key") == b"project:key"
        assert manager.prefixed(b"project:key") == b"project:key"

    @patch.dict(os.environ, {"PLATFORM_REDIS_URL": "rediss://redis.internal:6380/0",
                            "PLATFORM_REDIS_USERNAME": "project-user",
                            "PLATFORM_REDIS_PASSWORD": "secret",
                            "PLATFORM_REDIS_KEY_PREFIX": "project:"}, clear=True)
    @patch('platform_sdk.db.redis.redis.Redis')
    def test_tls_url_from_environment(self, mock_redis_class):
        manager = RedisManager()
        manager.connect()
        mock_redis_class.from_url.assert_called_once_with(
            "rediss://redis.internal:6380/0", password="secret",
            username="project-user", decode_responses=True,
        )
        mock_redis_class.assert_not_called()
        assert manager.connected is True
        manager.set("k", "v")
        mock_redis_class.from_url.return_value.set.assert_called_once_with("project:k", "v")

    @patch.dict(os.environ, {"PLATFORM_REDIS_TLS": "true", "PLATFORM_REDIS_DB": "2",
                            "PLATFORM_REDIS_USERNAME": "project-user"}, clear=True)
    @patch('platform_sdk.db.redis.redis.Redis')
    def test_tls_flag_and_db_from_environment(self, mock_redis_class):
        RedisManager().connect()
        mock_redis_class.assert_called_once_with(
            host="localhost", port=6379, password=None, db=2, ssl=True,
            username="project-user", decode_responses=True,
        )

    def test_url_tls_parsing_real_client(self):
        # No server needed: redis-py builds an SSL connection pool from rediss:// lazily.
        manager = RedisManager({"url": "rediss://redis.internal:6380/0",
                                "username": "project-user", "password": "secret"})
        with patch('platform_sdk.db.redis.redis.Redis.ping'):
            manager.connect()
        kwargs = manager.client.connection_pool.connection_kwargs
        assert manager.client.connection_pool.connection_class.__name__ == "SSLConnection"
        assert kwargs["username"] == "project-user"
        assert kwargs["host"] == "redis.internal"
        assert kwargs["port"] == 6380

    @patch('platform_sdk.db.redis.Sentinel')
    def test_sentinel_from_config(self, mock_sentinel_cls):
        mock_sentinel = MagicMock()
        mock_master = MagicMock()
        mock_sentinel_cls.return_value = mock_sentinel
        mock_sentinel.master_for.return_value = mock_master

        manager = RedisManager({
            "sentinels": [{"host": "s0", "port": 26379}, {"host": "s1", "port": 26379}],
            "master_name": "mymaster",
            "sentinel_username": "plat-sentinel",
            "sentinel_password": "sent-pw",
            "username": "plat_a",
            "password": "pw",
            "db": 0,
            "key_prefix": "plat:a:",
        })
        assert manager.mode == "sentinel"
        manager.connect()
        mock_sentinel_cls.assert_called_once_with(
            [("s0", 26379), ("s1", 26379)],
            sentinel_kwargs={"username": "plat-sentinel", "password": "sent-pw"},
            socket_timeout=5,
        )
        mock_sentinel.master_for.assert_called_once_with(
            "mymaster",
            decode_responses=True,
            username="plat_a",
            password="pw",
            db=0,
        )
        mock_master.ping.assert_called_once()
        assert manager.connected is True

    @patch('platform_sdk.db.redis.Sentinel')
    def test_sentinel_string_parsing(self, mock_sentinel_cls):
        mock_sentinel = MagicMock()
        mock_sentinel_cls.return_value = mock_sentinel
        mock_sentinel.master_for.return_value = MagicMock()

        manager = RedisManager({"sentinels": "s0:26379,s1", "username": "u", "password": "p"})
        manager.connect()
        mock_sentinel_cls.assert_called_once_with(
            [("s0", 26379), ("s1", 26379)],
            sentinel_kwargs=None,
            socket_timeout=5,
        )
        mock_sentinel.master_for.assert_called_once_with(
            "mymaster", decode_responses=True, username="u", password="p",
        )

    @patch.dict(os.environ, {
        "PLATFORM_REDIS_SENTINELS": "a:26379,b:26379",
        "PLATFORM_REDIS_SENTINEL_MASTER": "mymaster",
        "PLATFORM_REDIS_SENTINEL_USERNAME": "plat-sentinel",
        "PLATFORM_REDIS_SENTINEL_PASSWORD": "sent-pw",
    }, clear=True)
    @patch('platform_sdk.db.redis.Sentinel')
    def test_sentinel_from_env(self, mock_sentinel_cls):
        mock_sentinel = MagicMock()
        mock_sentinel_cls.return_value = mock_sentinel
        mock_sentinel.master_for.return_value = MagicMock()
        manager = RedisManager()
        assert manager.mode == "sentinel"
        manager.connect()
        mock_sentinel_cls.assert_called_once_with(
            [("a", 26379), ("b", 26379)],
            sentinel_kwargs={"username": "plat-sentinel", "password": "sent-pw"},
            socket_timeout=5,
        )
        # host/port from env defaults must not be passed to master_for in sentinel mode.
        kwargs = mock_sentinel.master_for.call_args
        assert kwargs[0][0] == "mymaster"
        assert "host" not in kwargs[1]
        assert "port" not in kwargs[1]

    @patch('platform_sdk.db.redis.redis.Redis')
    def test_standalone_unchanged_without_sentinels(self, mock_redis_class):
        RedisManager({"host": "redis", "port": 6379, "password": "p"}).connect()
        mock_redis_class.assert_called_once_with(
            host="redis", port=6379, password="p", username=None, decode_responses=True,
        )
