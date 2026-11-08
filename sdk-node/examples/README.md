# Node SDK examples

Set credentials, then run any file with Node 18+:

```bash
export PLATFORM_URL=https://api.YOUR_IP.sslip.io
export PLATFORM_SDK_TOKEN=sdk_live_...
export PROJECT_NAME=my-project          # must exist in portal
export ENVIRONMENT_NAME=development

cd sdk-node && npm install && npm run build
node examples/01-express-basic.js
```

For lab hosts with a self-signed / private CA certificate, trust that CA instead of disabling TLS verification:

```bash
export NODE_EXTRA_CA_CERTS=/path/to/platform-ca.pem
```

Never set `NODE_TLS_REJECT_UNAUTHORIZED=0`: it disables certificate checks for the whole process and exposes your SDK token to man-in-the-middle attacks.

See also the full demo stack under [`../../examples/sdk-apps`](../../examples/sdk-apps).
