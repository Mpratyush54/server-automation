import pytest
from unittest.mock import patch, MagicMock
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from caps_sdk.db.mongo import MongoManager


class TestMongoManager:
    def test_init_with_config(self):
        manager = MongoManager({"uri": "mongodb://localhost:27017/test"})
        assert manager.uri == "mongodb://localhost:27017/test"
        assert manager.connected is False
        assert manager.client is None

    def test_init_without_config(self):
        manager = MongoManager()
        assert manager.uri == "mongodb://localhost:27017/caps_platform"

    @patch('caps_sdk.db.mongo.pymongo.MongoClient')
    def test_connect_success(self, mock_client_class):
        mock_client = MagicMock()
        mock_client_class.return_value = mock_client

        manager = MongoManager({"uri": "mongodb://localhost:27017/test"})
        manager.connect()

        assert manager.connected is True
        mock_client.admin.command.assert_called_once_with("ping")

    @patch('caps_sdk.db.mongo.pymongo.MongoClient')
    def test_connect_failure(self, mock_client_class):
        mock_client = MagicMock()
        mock_client.admin.command.side_effect = Exception("Connection refused")
        mock_client_class.return_value = mock_client

        manager = MongoManager({"uri": "mongodb://localhost:27017/test"})
        with pytest.raises(Exception, match="Connection refused"):
            manager.connect()

        assert manager.connected is False

    def test_db_property_when_not_connected(self):
        manager = MongoManager()
        assert manager.db is None

    @patch('caps_sdk.db.mongo.pymongo.MongoClient')
    def test_db_property_when_connected(self, mock_client_class):
        mock_client = MagicMock()
        mock_db = MagicMock()
        mock_client.get_default_database.return_value = mock_db
        mock_client_class.return_value = mock_client

        manager = MongoManager({"uri": "mongodb://localhost:27017/test"})
        manager.connect()

        assert manager.db == mock_db

    @patch('caps_sdk.db.mongo.pymongo.MongoClient')
    def test_disconnect(self, mock_client_class):
        mock_client = MagicMock()
        mock_client_class.return_value = mock_client

        manager = MongoManager({"uri": "mongodb://localhost:27017/test"})
        manager.connect()
        manager.disconnect()

        assert manager.connected is False
        mock_client.close.assert_called_once()

    def test_disconnect_when_not_connected(self):
        manager = MongoManager()
        manager.disconnect()  # Should not raise
