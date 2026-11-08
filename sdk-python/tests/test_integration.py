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
    @patch('platform_sdk.db.redis.redis.Redis')
    def test_redis_api_credentials(self, mock_redis, mock_request, mock_heartbeat, monkeypatch):
        monkeypatch.setenv("PLATFORM_REDIS_USERNAME", "env-user")
        monkeypatch.setenv("PLATFORM_REDIS_KEY_PREFIX", "env:")
        mock_request.side_effect = [{"id": "registration"}, {"redis": {
            "host": "redis.internal", "port": 6379, "username": "project-user",
            "password": "project-password", "keyPrefix": "project:", "db": 0,
        }}]
        client = PlatformClient()
        client.init(project_name="project", platform_url="http://localhost:3000",
                    environment_name="production", sdk_token="sdk_test_token", databases=["redis"])
        mock_request.assert_called_with("GET", "/api/sdk/db-credentials", params={
            "projectId": "project", "dbTypes": "redis", "environment": "production",
        })
        mock_redis.assert_called_once_with(
            host="redis.internal", port=6379, username="project-user",
            password="project-password", db=0, decode_responses=True,
        )
        client.db["redis"].set("ping", "1")
        mock_redis.return_value.set.assert_called_once_with("project:ping", "1")
        client.shutdown()

    @pytest.mark.parametrize("response", [None, {}])
    @patch('platform_sdk.PlatformClient._start_heartbeat')
    @patch('platform_sdk.PlatformClient._request')
    @patch('platform_sdk.db.redis.redis.Redis')
    def test_redis_credentials_unavailable_uses_environment(
            self, mock_redis, mock_request, mock_heartbeat, response, monkeypatch):
        monkeypatch.setenv("PLATFORM_REDIS_USERNAME", "env-user")
        monkeypatch.setenv("PLATFORM_REDIS_KEY_PREFIX", "env:")
        mock_request.side_effect = [{}, response]
        client = PlatformClient()
        client.init(project_name="project", platform_url="http://localhost:3000", databases=["redis"])
        assert mock_redis.call_args.kwargs["username"] == "env-user"
        assert client.db["redis"].prefixed("key") == "env:key"
        client.shutdown()

    @patch('platform_sdk.PlatformClient._start_heartbeat')
    @patch('platform_sdk.PlatformClient._request')
    @patch('platform_sdk.db.redis.redis.Redis')
    def test_redis_provisioning_error_does_not_connect(self, mock_redis, mock_request, mock_heartbeat):
        mock_request.side_effect = [{}, {"redis": {"status": "error", "error": "unavailable"}}]
        client = PlatformClient()
        client.init(project_name="project", platform_url="http://localhost:3000", databases=["redis"])
        assert client.initialized
        mock_redis.assert_not_called()

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
            mock_log.assert_called_with("POST", "/api/sdk/logs", {"logs": [{
                "projectId": "test",
                "environment": "development",
                "serviceName": "test",
                "hostname": client.options["hostname"],
                "level": "INFO",
                "message": "Service started",
                "metadata": {},
            }]})
