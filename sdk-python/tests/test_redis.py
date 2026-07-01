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
        assert manager.config == config
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
