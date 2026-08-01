/**
 * Lightweight Angular-flavored SPA (no full CLI) that hits the Node SDK API.
 * Served on :4200 with /api proxied to the node-api (:4100).
 */
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const path = require('path');

const PORT = Number(process.env.ANGULAR_PORT || process.env.PORT || 4200);
const API = process.env.API_URL || 'http://127.0.0.1:4100';

const app = express();
// Keep /api and /health prefixes when forwarding (Express mount would otherwise strip them).
app.use(createProxyMiddleware({
  target: API,
  changeOrigin: true,
  pathFilter: ['/api', '/health'],
}));
app.use(express.static(path.join(__dirname, 'public')));

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`[angular-web] http://127.0.0.1:${PORT} → API ${API}`));
