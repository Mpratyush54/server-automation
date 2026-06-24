import psycopg2
from psycopg2 import pool
import logging

logger = logging.getLogger('caps')


class PostgresManager:
    def __init__(self, config: dict = None):
        self.config = config or {
            "host": os.environ.get("CAPS_PG_HOST", "localhost"),
            "port": int(os.environ.get("CAPS_PG_PORT", "5432")),
            "user": os.environ.get("CAPS_PG_USER", "caps"),
            "password": os.environ.get("CAPS_PG_PASSWORD", "caps"),
            "database": os.environ.get("CAPS_PG_DB", "caps_platform"),
        }
        import os as _os
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
        logger.info("[caps] PostgreSQL connected")

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
            logger.info("[caps] PostgreSQL disconnected")
