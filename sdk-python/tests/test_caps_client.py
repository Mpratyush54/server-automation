import pytest
from unittest.mock import patch, MagicMock, mock_open
import json
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from caps_sdk import CapsClient


class TestCapsClient:
    def setup_method(self):
        self.client = CapsClient()

    def test_init_defaults(self):
        assert self.client.initialized is False
        assert self.client.options == {}
        assert self.client._db_connections == {}

    @patch('caps_sdk.CapsClient._request')
    @patch('caps_sdk.CapsClient._start_heartbeat')
    def test_init_sets_options(self, mock_heartbeat, mock_request):
        mock_request.return_value = {"id": "reg-1"}

        self.client.init(
            project_name="test-project",
            platform_url="http://localhost:3000",
        )

        assert self.client.initialized is True
        assert self.client.options["project_name"] == "test-project"
        assert self.client.options["platform_url"] == "http://localhost:3000"
        assert self.client.options["environment_name"] == "development"
        assert self.client.options["version"] == "1.0.0"
        assert self.client.options["branch"] == "main"

    @patch('caps_sdk.CapsClient._request')
    @patch('caps_sdk.CapsClient._start_heartbeat')
    def test_init_custom_options(self, mock_heartbeat, mock_request):
        mock_request.return_value = {}

        self.client.init(
            project_name="my-app",
            platform_url="https://caps.example.com/",
            environment_name="production",
            version="2.0.0",
            branch="develop",
        )

        assert self.client.options["environment_name"] == "production"
        assert self.client.options["version"] == "2.0.0"
        assert self.client.options["branch"] == "develop"
        assert self.client.options["platform_url"] == "https://caps.example.com"

    @patch('caps_sdk.CapsClient._request')
    @patch('caps_sdk.CapsClient._start_heartbeat')
    def test_init_calls_register(self, mock_heartbeat, mock_request):
        mock_request.return_value = {"id": "reg-1"}

        self.client.init(
            project_name="test-project",
            platform_url="http://localhost:3000",
        )

        mock_request.assert_called_with("POST", "/api/sdk/register", {
            "projectName": "test-project",
            "environmentName": "development",
            "serviceName": "test-project",
            "version": "1.0.0",
            "branch": "main",
            "commitSha": None,
            "namespace": None,
            "hostname": self.client.options["hostname"],
            "dbTypes": [],
        })

    def test_request_returns_response(self):
        with patch('caps_sdk.urlopen') as mock_urlopen:
            mock_response = MagicMock()
            mock_response.read.return_value = json.dumps({"key": "value"}).encode()
            mock_urlopen.return_value.__enter__ = lambda s: mock_response
            mock_urlopen.return_value.__exit__ = MagicMock(return_value=False)

            self.client.options = {"platform_url": "http://localhost:3000"}
            result = self.client._request("GET", "/api/test")
            assert result == {"key": "value"}

    def test_request_returns_none_on_error(self):
        from urllib.error import URLError
        with patch('caps_sdk.urlopen') as mock_urlopen:
            mock_urlopen.side_effect = URLError("Connection refused")

            self.client.options = {"platform_url": "http://localhost:3000"}
            result = self.client._request("GET", "/api/test")
            assert result is None

    def test_config_returns_value(self):
        self.client.options = {"project_name": "test"}
        with patch.object(self.client, '_request', return_value={"KEY": "val"}):
            assert self.client.config("KEY") == "val"

    def test_config_returns_none_for_missing_key(self):
        self.client.options = {"project_name": "test"}
        with patch.object(self.client, '_request', return_value={"KEY": "val"}):
            assert self.client.config("MISSING") is None

    def test_log_calls_request(self):
        self.client.options = {
            "project_name": "test",
            "environment_name": "dev",
        }
        with patch.object(self.client, '_request') as mock_request:
            self.client.log("INFO", "Test message", {"extra": "data"})
            mock_request.assert_called_once_with("POST", "/api/logs/ingest", {
                "projectId": "test",
                "environmentId": "dev",
                "serviceName": "test",
                "level": "INFO",
                "message": "Test message",
                "metadata": {"extra": "data"},
            })

    def test_log_without_metadata(self):
        self.client.options = {
            "project_name": "test",
            "environment_name": "dev",
        }
        with patch.object(self.client, '_request') as mock_request:
            self.client.log("ERROR", "Error occurred")
            mock_request.assert_called_once_with("POST", "/api/logs/ingest", {
                "projectId": "test",
                "environmentId": "dev",
                "serviceName": "test",
                "level": "ERROR",
                "message": "Error occurred",
                "metadata": {},
            })

    def test_db_property(self):
        assert self.client.db == {}

    def test_shutdown_disconnects_all_dbs(self):
        mock_pg = MagicMock()
        mock_mongo = MagicMock()
        mock_redis = MagicMock()
        self.client._db_connections = {
            "postgres": mock_pg,
            "mongo": mock_mongo,
            "redis": mock_redis,
        }

        self.client.shutdown()

        mock_pg.disconnect.assert_called_once()
        mock_mongo.disconnect.assert_called_once()
        mock_redis.disconnect.assert_called_once()

    def test_shutdown_handles_disconnect_errors(self):
        mock_db = MagicMock()
        mock_db.disconnect.side_effect = Exception("Disconnect failed")
        self.client._db_connections = {"postgres": mock_db}

        self.client.shutdown()  # Should not raise


class TestCapsClientSingleton:
    def test_singleton_exists(self):
        from caps_sdk import caps
        assert isinstance(caps, CapsClient)
