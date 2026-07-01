import pytest
from unittest.mock import patch, MagicMock
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from platform_sdk import PlatformClient


class TestPlatformClientIntegration:
    """Integration-style tests that test multiple components together."""

    @patch('platform_sdk.PlatformClient._start_heartbeat')
    @patch('platform_sdk.PlatformClient._request')
    def test_full_init_and_shutdown_flow(self, mock_request, mock_heartbeat):
        mock_request.return_value = {"id": "reg-1", "projectName": "test"}

        client = PlatformClient()
        client.init(
            project_name="integration-test",
            platform_url="http://localhost:3000",
            environment_name="staging",
            version="1.0.0",
        )

        assert client.initialized is True
        assert client.options["project_name"] == "integration-test"
        assert client.options["environment_name"] == "staging"

        # Verify registration was called
        mock_request.assert_called_with("POST", "/api/sdk/register", {
            "projectName": "integration-test",
            "environmentName": "staging",
            "serviceName": "integration-test",
            "version": "1.0.0",
            "branch": "main",
            "commitSha": None,
            "namespace": None,
            "hostname": client.options["hostname"],
            "dbTypes": [],
        })

        client.shutdown()

    @patch('platform_sdk.PlatformClient._start_heartbeat')
    @patch('platform_sdk.PlatformClient._request')
    def test_config_after_init(self, mock_request, mock_heartbeat):
        mock_request.return_value = {}

        client = PlatformClient()
        client.init(
            project_name="test",
            platform_url="http://localhost:3000",
        )

        # Mock config endpoint
        with patch.object(client, '_request') as mock_config:
            mock_config.return_value = {"DB_HOST": "localhost", "FEATURE_X": "true"}
            result = client.config("DB_HOST")
            assert result == "localhost"

    @patch('platform_sdk.PlatformClient._start_heartbeat')
    @patch('platform_sdk.PlatformClient._request')
    def test_logging_after_init(self, mock_request, mock_heartbeat):
        mock_request.return_value = {}

        client = PlatformClient()
        client.init(
            project_name="test",
            platform_url="http://localhost:3000",
        )

        with patch.object(client, '_request') as mock_log:
            client.log("INFO", "Service started")
            mock_log.assert_called_with("POST", "/api/logs/ingest", {
                "projectId": "test",
                "environmentId": "development",
                "serviceName": "test",
                "level": "INFO",
                "message": "Service started",
                "metadata": {},
            })
