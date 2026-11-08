import pytest
from unittest.mock import patch, MagicMock
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from platform_sdk.db.postgres import PostgresManager


class TestPostgresManager:
    def test_init_with_config(self):
        config = {
            "host": "localhost",
            "port": 5432,
            "user": "test",
            "password": "test",
            "database": "test_db",
        }
        manager = PostgresManager(config)
        assert manager.config == config
        assert manager.connected is False

    def test_init_with_empty_config(self):
        manager = PostgresManager({})
        assert manager.connected is False

    @patch('platform_sdk.db.postgres.pool.ThreadedConnectionPool')
    def test_connect_success(self, mock_pool_class):
        mock_pool = MagicMock()
        mock_conn = MagicMock()
        mock_pool.getconn.return_value = mock_conn
        mock_pool_class.return_value = mock_pool

        manager = PostgresManager({"host": "localhost", "port": 5432, "password": "pw"})
        manager.connect()

        assert manager.connected is True
        mock_pool.getconn.assert_called_once()
        # Regression (F06): the probe connection must be returned to the pool OPEN.
        mock_conn.close.assert_not_called()
        mock_conn.cursor.return_value.__enter__.return_value.execute.assert_called_once_with("SELECT 1")
        mock_pool.putconn.assert_called_once_with(mock_conn)

    @patch('platform_sdk.db.postgres.pool.ThreadedConnectionPool')
    def test_connect_does_not_pass_pool_size_to_psycopg2(self, mock_pool_class):
        manager = PostgresManager({"host": "h", "password": "pw", "pool_size": 3})
        manager.connect()
        _, kwargs = mock_pool_class.call_args
        assert kwargs["maxconn"] == 3
        assert "pool_size" not in kwargs

    @patch('platform_sdk.db.postgres.pool.ThreadedConnectionPool')
    def test_connect_probe_failure_closes_pool(self, mock_pool_class):
        mock_pool = MagicMock()
        mock_conn = MagicMock()
        mock_conn.cursor.side_effect = Exception("server closed the connection")
        mock_pool.getconn.return_value = mock_conn
        mock_pool_class.return_value = mock_pool

        manager = PostgresManager({"host": "h", "password": "pw"})
        with pytest.raises(Exception, match="server closed"):
            manager.connect()
        assert manager.connected is False
        assert manager._pool is None
        mock_pool.closeall.assert_called_once()

    @patch('platform_sdk.db.postgres.pool.ThreadedConnectionPool')
    def test_connect_fails_closed_without_password(self, mock_pool_class, monkeypatch):
        monkeypatch.delenv("PLATFORM_PG_PASSWORD", raising=False)
        manager = PostgresManager()
        assert manager.config["password"] is None
        with pytest.raises(RuntimeError, match="credentials missing"):
            manager.connect()
        mock_pool_class.assert_not_called()
        assert manager.connected is False

    @patch('platform_sdk.db.postgres.pool.ThreadedConnectionPool')
    def test_connect_failure(self, mock_pool_class):
        mock_pool_class.side_effect = Exception("Connection refused")

        manager = PostgresManager({"host": "localhost", "password": "pw"})
        with pytest.raises(Exception, match="Connection refused"):
            manager.connect()

        assert manager.connected is False

    def test_execute_without_connection(self):
        manager = PostgresManager({})
        with pytest.raises(RuntimeError, match="PostgreSQL not connected"):
            manager.execute("SELECT 1")

    @patch('platform_sdk.db.postgres.pool.ThreadedConnectionPool')
    def test_execute_query(self, mock_pool_class):
        mock_pool = MagicMock()
        mock_conn = MagicMock()
        mock_cursor = MagicMock()
        mock_cursor.__enter__ = MagicMock(return_value=mock_cursor)
        mock_cursor.__exit__ = MagicMock(return_value=False)
        mock_cursor.description = [("id",)]
        mock_cursor.fetchall.return_value = [(1,), (2,)]
        mock_conn.cursor.return_value = mock_cursor
        mock_pool.getconn.return_value = mock_conn
        mock_pool_class.return_value = mock_pool

        manager = PostgresManager({})
        manager._pool = mock_pool
        manager.connected = True

        result = manager.execute("SELECT id FROM users")
        assert result == [(1,), (2,)]

    @patch('platform_sdk.db.postgres.pool.ThreadedConnectionPool')
    def test_execute_mutation(self, mock_pool_class):
        mock_pool = MagicMock()
        mock_conn = MagicMock()
        mock_cursor = MagicMock()
        mock_cursor.__enter__ = MagicMock(return_value=mock_cursor)
        mock_cursor.__exit__ = MagicMock(return_value=False)
        mock_cursor.description = None
        mock_conn.cursor.return_value = mock_cursor
        mock_pool.getconn.return_value = mock_conn
        mock_pool_class.return_value = mock_pool

        manager = PostgresManager({})
        manager._pool = mock_pool
        manager.connected = True

        result = manager.execute("INSERT INTO users (name) VALUES (%s)", ("test",))
        assert result == []
        mock_conn.commit.assert_called_once()

    @patch('platform_sdk.db.postgres.pool.ThreadedConnectionPool')
    def test_disconnect(self, mock_pool_class):
        mock_pool = MagicMock()
        mock_pool_class.return_value = mock_pool

        manager = PostgresManager({})
        manager._pool = mock_pool
        manager.connected = True

        manager.disconnect()

        assert manager.connected is False
        mock_pool.closeall.assert_called_once()

    def test_disconnect_when_not_connected(self):
        manager = PostgresManager({})
        manager.disconnect()  # Should not raise
