"""Connect platform-managed databases via the Python SDK."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from platform_sdk import PlatformClient


def main() -> None:
    client = PlatformClient()
    client.init(
        project_name=os.environ.get("PROJECT_NAME", "sdk-examples"),
        platform_url=os.environ.get("PLATFORM_URL", "http://localhost:3000").rstrip("/"),
        environment_name=os.environ.get("ENVIRONMENT_NAME", "development"),
        databases=["postgres", "mongo", "redis"],
    )

    status = {k: getattr(v, "connected", False) for k, v in client.db.items()}
    print("db status:", status)

    if "postgres" in client.db and client.db["postgres"].connected:
        rows = client.db["postgres"].execute("SELECT 1 AS ok")
        print("postgres:", rows)

    if "redis" in client.db and client.db["redis"].connected:
        # RedisManager API mirrors set/get helpers when present
        r = client.db["redis"]
        if hasattr(r, "set"):
            r.set("sdk-examples:ping", "1")
            print("redis:", r.get("sdk-examples:ping") if hasattr(r, "get") else "set ok")

    client.shutdown()


if __name__ == "__main__":
    main()
