import os
from setuptools import setup, find_packages

setup(
    name="mpratyush54-sdk",
    version="1.0.1",
    description="Platform Python SDK",
    packages=find_packages(include=['platform_sdk', 'platform_sdk.*']),
    install_requires=[
        "psycopg2-binary>=2.9.0",
        "pymongo>=4.5.0",
        "redis>=5.0.0",
    ],
    extras_require={
        "telemetry": [
            "opentelemetry-distro>=0.50b0,<1", "opentelemetry-exporter-otlp-proto-http>=1.29,<2",
            "opentelemetry-instrumentation-requests>=0.50b0,<1",
            "opentelemetry-instrumentation-flask>=0.50b0,<1",
            "opentelemetry-instrumentation-fastapi>=0.50b0,<1",
            "opentelemetry-instrumentation-django>=0.50b0,<1",
            "opentelemetry-instrumentation-psycopg>=0.50b0,<1",
            "opentelemetry-instrumentation-psycopg2>=0.50b0,<1",
            "opentelemetry-instrumentation-pymongo>=0.50b0,<1",
            "opentelemetry-instrumentation-redis>=0.50b0,<1",
        ],
        "profiling": ["pyroscope-io>=0.8,<1", "pyroscope-otel>=0.4,<1"],
    },
    author="Platform Team",
    url="https://github.com/Mpratyush54/server-automation",
    long_description=open("README.md").read() if os.path.exists("README.md") else "",
    long_description_content_type="text/markdown",
    python_requires=">=3.10",
    classifiers=[
        "Programming Language :: Python :: 3",
        "License :: OSI Approved :: MIT License",
        "Operating System :: OS Independent",
    ],
)
