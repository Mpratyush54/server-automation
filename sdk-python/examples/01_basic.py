"""Basic Platform Python SDK usage — init, log, config."""
import os
import sys

# Allow running against a local checkout without install
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from platform_sdk import PlatformClient

def main() -> None:
    url = os.environ.get("PLATFORM_URL", "http://localhost:3000").rstrip("/")
    name = os.environ.get("PROJECT_NAME", "sdk-examples")

    client = PlatformClient()
    client.init(
        project_name=name,
        platform_url=url,
        environment_name=os.environ.get("ENVIRONMENT_NAME", "development"),
        version=os.environ.get("APP_VERSION", "0.1.0"),
        branch=os.environ.get("GIT_BRANCH", "main"),
    )

    client.log("INFO", "python example started", {"project": name})
    value = client.config("FEATURE_X")
    print("FEATURE_X =", value)

    client.shutdown()
    print("done")


if __name__ == "__main__":
    main()
