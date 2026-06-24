import pymongo
import logging

logger = logging.getLogger('caps')


class MongoManager:
    def __init__(self, config: dict = None):
        import os as _os
        self.uri = (config or {}).get("uri") or _os.environ.get(
            "CAPS_MONGO_URI", "mongodb://localhost:27017/caps_platform"
        )
        self.client = None
        self.connected = False

    def connect(self):
        self.client = pymongo.MongoClient(self.uri, serverSelectionTimeoutMS=5000)
        self.client.admin.command("ping")
        self.connected = True
        logger.info("[caps] MongoDB connected")

    @property
    def db(self):
        if self.client:
            return self.client.get_default_database()
        return None

    def disconnect(self):
        if self.client:
            self.client.close()
            self.connected = False
            logger.info("[caps] MongoDB disconnected")
