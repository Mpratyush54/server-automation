import os
from setuptools import setup, find_packages

setup(
    name="platform-sdk-python",
    version="1.0.0",
    description="CAPS Platform Python SDK",
    packages=find_packages(),
    install_requires=[
        "psycopg2-binary>=2.9.0",
        "pymongo>=4.5.0",
        "redis>=5.0.0",
    ],
    python_requires=">=3.10",
)
