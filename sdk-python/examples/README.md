# Python SDK examples

```bash
pip install mpratyush54-sdk
# or from repo: pip install -e ./sdk-python

export PLATFORM_URL=https://api.YOUR_IP.sslip.io
export PROJECT_NAME=my-project
export ENVIRONMENT_NAME=development

python examples/01_basic.py
```

For lab TLS hosts you may need to relax verification in your HTTP client; this SDK uses `urllib` with a short timeout and silently logs failures.
