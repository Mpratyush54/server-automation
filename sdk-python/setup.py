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
