# Python SDK examples

```bash
pip install mpratyush54-sdk
# or from repo: pip install -e ./sdk-python

export PLATFORM_URL=https://api.YOUR_IP.sslip.io
export PLATFORM_SDK_TOKEN=sdk_live_...   # Project -> Tokens; sent as Authorization: Bearer
export PROJECT_NAME=my-project
export ENVIRONMENT_NAME=development

python examples/01_basic.py
```

For lab TLS hosts with a private CA, trust the CA (for example `export SSL_CERT_FILE=/path/to/platform-ca.pem`) instead of disabling verification. This SDK uses `urllib` with a short timeout and logs failures.
