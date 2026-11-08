import pytest
from unittest.mock import patch, MagicMock
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from platform_sdk.db.redis import RedisManager


class TestRedisManager:
    def test_init_with_config(self):
        config = {"host": "localhost", "port": 6379, "password": None}
        manager = RedisManager(config)
        assert manager.config == {**config, "username": os.environ.get("PLATFORM_REDIS_USERNAME")}
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
