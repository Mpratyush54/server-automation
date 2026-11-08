import psycopg2
from psycopg2 import pool
import logging

logger = logging.getLogger('platform')


class PostgresManager:
    def __init__(self, config: dict = None):
        import os as _os
        self.config = config or {
            "host": _os.environ.get("PLATFORM_PG_HOST", "localhost"),
            "port": int(_os.environ.get("PLATFORM_PG_PORT", "5432")),
            "user": _os.environ.get("PLATFORM_PG_USER", "platform"),
            # No default password: credentials must come from the environment or config.
            "password": _os.environ.get("PLATFORM_PG_PASSWORD"),
            "database": _os.environ.get("PLATFORM_PG_DB", "platform"),
        }
        self._pool = None
        self.connected = False

    def connect(self):
        if not self.config.get("password") and not self.config.get("dsn"):
            # Fail closed instead of silently trying a well-known password.
            raise RuntimeError(
                "[platform] PostgreSQL credentials missing: set PLATFORM_PG_PASSWORD "
                "or pass a config with a password"
            )
        conn_kwargs = {k: v for k, v in self.config.items() if k != "pool_size"}
        new_pool = pool.ThreadedConnectionPool(
            minconn=1, maxconn=self.config.get("pool_size", 10), **conn_kwargs
        )
        try:
            # Probe with a real query and return the (still open) connection to the pool.
            conn = new_pool.getconn()
            try:
                with conn.cursor() as cur:
                    cur.execute("SELECT 1")
                conn.rollback()
            finally:
                new_pool.putconn(conn)
        except Exception:
            new_pool.closeall()
            raise
        self._pool = new_pool
        self.connected = True
        logger.info("[platform] PostgreSQL connected")

    def execute(self, query: str, params: tuple = None) -> list:
        if not self._pool:
            raise RuntimeError("PostgreSQL not connected")
        conn = self._pool.getconn()
        try:
            with conn.cursor() as cur:
                cur.execute(query, params)
                if cur.description:
                    return cur.fetchall()
                conn.commit()
                return []
        finally:
            self._pool.putconn(conn)

    def disconnect(self):
        if self._pool:
            self._pool.closeall()
            self.connected = False
            logger.info("[platform] PostgreSQL disconnected")
