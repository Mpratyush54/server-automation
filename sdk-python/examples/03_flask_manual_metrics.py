"""
Flask example with manual request timing logged to Platform.

  pip install flask mpratyush54-sdk
  PLATFORM_URL=… PROJECT_NAME=… python examples/03_flask_manual_metrics.py
"""
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from flask import Flask, g, request
from platform_sdk import PlatformClient

client = PlatformClient()
client.init(
    project_name=os.environ.get("PROJECT_NAME", "sdk-examples"),
    platform_url=os.environ.get("PLATFORM_URL", "http://localhost:3000").rstrip("/"),
    environment_name=os.environ.get("ENVIRONMENT_NAME", "development"),
)

app = Flask(__name__)


@app.before_request
def _start_timer():
    g._t0 = time.perf_counter()


@app.after_request
def _log_timing(resp):
    ms = int((time.perf_counter() - getattr(g, "_t0", time.perf_counter())) * 1000)
    client.log(
        "INFO",
        "http_request",
        {
            "route": request.path,
            "method": request.method,
            "status": resp.status_code,
            "durationMs": ms,
        },
    )
    return resp


@app.get("/health")
def health():
    return {"ok": True, "sdk": "python"}


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "5100")))
