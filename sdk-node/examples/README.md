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

For TLS lab hosts you may need:

```bash
export NODE_TLS_REJECT_UNAUTHORIZED=0
```

See also the full demo stack under [`../../examples/sdk-apps`](../../examples/sdk-apps).
