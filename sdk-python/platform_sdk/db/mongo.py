import pymongo
import logging

logger = logging.getLogger('platform')


class MongoManager:
    def __init__(self, config: dict = None):
        import os as _os
        self.uri = (config or {}).get("uri") or _os.environ.get(
            "PLATFORM_MONGO_URI", "mongodb://localhost:27017/platform"
        )
        self.client = None
        self.connected = False

    def connect(self):
        self.client = pymongo.MongoClient(self.uri, serverSelectionTimeoutMS=5000)
        self.client.admin.command("ping")
        self.connected = True
        logger.info("[platform] MongoDB connected")

    @property
    def db(self):
        if self.client:
            return self.client.get_default_database()
        return None

    def disconnect(self):
        if self.client:
            self.client.close()
            self.connected = False
            logger.info("[platform] MongoDB disconnected")
