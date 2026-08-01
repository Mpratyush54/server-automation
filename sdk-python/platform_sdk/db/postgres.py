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
            "password": _os.environ.get("PLATFORM_PG_PASSWORD", "platform"),
            "database": _os.environ.get("PLATFORM_PG_DB", "platform"),
        }
        self._pool = None
        self.connected = False

    def connect(self):
        self._pool = pool.ThreadedConnectionPool(
            minconn=1, maxconn=self.config.get("pool_size", 10), **self.config
        )
        conn = self._pool.getconn()
        conn.close()
        self._pool.putconn(conn)
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
