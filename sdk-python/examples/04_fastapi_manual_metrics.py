"""
FastAPI example with ASGI middleware timing + Platform logs.

  pip install fastapi uvicorn mpratyush54-sdk
  PLATFORM_URL=… PROJECT_NAME=… uvicorn examples.04_fastapi_manual_metrics:app --port 5101
"""
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from fastapi import FastAPI, Request
from platform_sdk import PlatformClient

client = PlatformClient()
client.init(
    project_name=os.environ.get("PROJECT_NAME", "sdk-examples"),
    platform_url=os.environ.get("PLATFORM_URL", "http://localhost:3000").rstrip("/"),
    environment_name=os.environ.get("ENVIRONMENT_NAME", "development"),
)

app = FastAPI(title="platform-sdk-python-example")


@app.middleware("http")
async def timing_middleware(request: Request, call_next):
    t0 = time.perf_counter()
    response = await call_next(request)
    ms = int((time.perf_counter() - t0) * 1000)
    client.log(
        "INFO",
        "http_request",
        {
            "route": request.url.path,
            "method": request.method,
            "status": response.status_code,
            "durationMs": ms,
        },
    )
    return response


@app.get("/health")
def health():
    return {"ok": True, "sdk": "python"}
