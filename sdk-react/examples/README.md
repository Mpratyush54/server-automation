# React SDK examples

These are **copy-paste** components (not a standalone Vite app). Wire them into your React or Next.js project after:

```bash
npm install @mpratyush54/sdk-react
```

Env (Vite example):

```env
VITE_PLATFORM_URL=https://api.YOUR_IP.sslip.io
VITE_PLATFORM_BROWSER_TOKEN=sdk_live_...
VITE_PLATFORM_PROJECT_ID=<project-uuid-or-name>
```

Use a **browser** SDK token (Project → SDK Tokens → kind *Browser*). `VITE_*` and
`NEXT_PUBLIC_*` values are bundled into public JavaScript, so never put a server token there.

See [`../../examples/sdk-apps/react-web`](../../examples/sdk-apps/react-web) for a runnable containerized demo.
