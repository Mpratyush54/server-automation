"""Exercise project Redis credentials; the Redis ACL enforces key isolation."""
import os
import sys
from uuid import uuid4

from redis.exceptions import NoPermissionError

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from platform_sdk import PlatformClient


def main() -> None:
    client = PlatformClient()
    client.init(
        project_name=os.environ["PROJECT_NAME"],
        platform_url=os.environ["PLATFORM_URL"],
        sdk_token=os.environ["PLATFORM_SDK_TOKEN"],
        environment_name=os.environ.get("ENVIRONMENT_NAME", "development"),
        databases=["redis"],
    )
    try:
        r = client.db.get("redis")
        if not r or not r.connected:
            raise RuntimeError("Project Redis connection failed")
        if not r.config.get("username") or r.config["username"] == "default" or not r.key_prefix:
            raise RuntimeError("Expected project Redis ACL credentials")
        key = "sdk-acl-example:" + uuid4().hex
        try:
            r.set(key, "ok", ttl=60)
            assert r.get(key) == "ok"
            assert r.client.get(r.prefixed(key)) == "ok"
            # A read outside the project prefix must be refused by the server ACL.
            outside_key = "sdk-acl-outside:" + uuid4().hex
            if outside_key.startswith(r.key_prefix):
                outside_key = "_" + outside_key
            try:
                r.client.get(outside_key)
            except NoPermissionError:
                pass
            else:
                raise RuntimeError("Redis ACL did not restrict reads to the project prefix")
            print("Project Redis ACL connection and prefixed read/write succeeded")
        finally:
            r.delete(key)
    finally:
        client.shutdown()


if __name__ == "__main__":
    main()
