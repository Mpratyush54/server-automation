/* ═══════════════════════════════════════════════════════════════════════════
   Platform PLATFORM — LANDING PAGE APP.JS
   Three.js 3D hero + all interactive behaviours
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

// ─── 1. THREE.JS 3D HERO SCENE ─────────────────────────────────────────────
(function initThreeScene() {
  const canvas = document.getElementById('heroCanvas');
  if (!canvas || typeof THREE === 'undefined') return;

  const W = () => canvas.clientWidth;
  const H = () => canvas.clientHeight;

  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(W(), H());
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, W() / H(), 0.1, 1000);
  camera.position.set(0, 0, 22);

  // ── Floating particle nodes ──────────────────────────────────────────────
  const NODE_COUNT = 90;
  const nodePositions = [];
  const nodeSpeeds    = [];
  const nodePhases    = [];
  const nodeGeo = new THREE.BufferGeometry();
  const posArr  = new Float32Array(NODE_COUNT * 3);
  const colArr  = new Float32Array(NODE_COUNT * 3);

  const palette = [
    new THREE.Color(0x7c3aed),  // violet
    new THREE.Color(0x2563eb),  // blue
    new THREE.Color(0x10b981),  // emerald
    new THREE.Color(0xa78bfa),  // purple-light
    new THREE.Color(0x60a5fa),  // blue-light
  ];

  for (let i = 0; i < NODE_COUNT; i++) {
    const spread = 18;
    const x = (Math.random() - 0.5) * spread * 2;
    const y = (Math.random() - 0.5) * spread;
    const z = (Math.random() - 0.5) * 8 - 4;

    nodePositions.push([x, y, z]);
    nodeSpeeds.push((Math.random() * 0.3 + 0.1));
    nodePhases.push(Math.random() * Math.PI * 2);

    posArr[i * 3]     = x;
    posArr[i * 3 + 1] = y;
    posArr[i * 3 + 2] = z;

    const c = palette[Math.floor(Math.random() * palette.length)];
    colArr[i * 3]     = c.r;
    colArr[i * 3 + 1] = c.g;
    colArr[i * 3 + 2] = c.b;
  }

  nodeGeo.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
  nodeGeo.setAttribute('color', new THREE.BufferAttribute(colArr, 3));

  const nodeMat = new THREE.PointsMaterial({
    size: 0.22,
    vertexColors: true,
    transparent: true,
    opacity: 0.75,
    sizeAttenuation: true,
  });
  const nodeCloud = new THREE.Points(nodeGeo, nodeMat);
  scene.add(nodeCloud);

  // ── Connection lines ─────────────────────────────────────────────────────
  const LINE_THRESHOLD = 6.5;
  const lineGeo = new THREE.BufferGeometry();
  const maxLines = NODE_COUNT * NODE_COUNT;
  const linePosArr = new Float32Array(maxLines * 6);
  const lineColArr = new Float32Array(maxLines * 6);
  lineGeo.setAttribute('position', new THREE.BufferAttribute(linePosArr, 3));
  lineGeo.setAttribute('color',    new THREE.BufferAttribute(lineColArr, 3));

  const lineMat = new THREE.LineSegments(lineGeo, new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.18,
  }));
  scene.add(lineMat);

  // ── Ambient rotating torus knot ──────────────────────────────────────────
  const torusGeo = new THREE.TorusKnotGeometry(4.2, 0.08, 160, 12, 3, 5);
  const torusMat = new THREE.MeshBasicMaterial({
    color: 0x7c3aed,
    transparent: true,
    opacity: 0.06,
    wireframe: true,
  });
  const torus = new THREE.Mesh(torusGeo, torusMat);
  torus.position.set(8, 2, -6);
  scene.add(torus);

  // ── Second decorative ring ───────────────────────────────────────────────
  const ring2Geo = new THREE.TorusGeometry(5, 0.04, 16, 80);
  const ring2Mat = new THREE.MeshBasicMaterial({
    color: 0x2563eb,
    transparent: true,
    opacity: 0.05,
    wireframe: true,
  });
  const ring2 = new THREE.Mesh(ring2Geo, ring2Mat);
  ring2.position.set(-9, -2, -5);
  ring2.rotation.x = 0.8;
  scene.add(ring2);

  // ── Mouse parallax ───────────────────────────────────────────────────────
  let mouseX = 0, mouseY = 0;
  let targetX = 0, targetY = 0;
  document.addEventListener('mousemove', (e) => {
    mouseX = (e.clientX / window.innerWidth  - 0.5) * 2;
    mouseY = (e.clientY / window.innerHeight - 0.5) * 2;
  });

  // ── Resize ───────────────────────────────────────────────────────────────
  const onResize = () => {
    renderer.setSize(W(), H());
    camera.aspect = W() / H();
    camera.updateProjectionMatrix();
  };
  window.addEventListener('resize', onResize);

  // ── Animation loop ───────────────────────────────────────────────────────
  let lineCount = 0;
  let frame = 0;

  const animate = () => {
    requestAnimationFrame(animate);
    frame++;

    // Smooth mouse follow
    targetX += (mouseX - targetX) * 0.04;
    targetY += (mouseY - targetY) * 0.04;

    // Rotate decorative geometry
    torus.rotation.x += 0.003;
    torus.rotation.y += 0.004;
    ring2.rotation.z += 0.002;
    ring2.rotation.y += 0.003;

    // Camera sway
    camera.position.x += (targetX * 2 - camera.position.x) * 0.03;
    camera.position.y += (-targetY * 1.5 - camera.position.y) * 0.03;
    camera.lookAt(0, 0, 0);

    const t = frame * 0.008;
    const positions = nodeGeo.attributes.position.array;

    for (let i = 0; i < NODE_COUNT; i++) {
      const [bx, by, bz] = nodePositions[i];
      const ph = nodePhases[i];
      const sp = nodeSpeeds[i];
      positions[i * 3]     = bx + Math.sin(t * sp + ph) * 0.4;
      positions[i * 3 + 1] = by + Math.cos(t * sp * 0.7 + ph) * 0.3;
      positions[i * 3 + 2] = bz;
    }
    nodeGeo.attributes.position.needsUpdate = true;

    // Rebuild connection lines every 3 frames
    if (frame % 3 === 0) {
      lineCount = 0;
      for (let a = 0; a < NODE_COUNT; a++) {
        for (let b = a + 1; b < NODE_COUNT; b++) {
          const ax = positions[a * 3], ay = positions[a * 3 + 1], az = positions[a * 3 + 2];
          const bx2 = positions[b * 3], by2 = positions[b * 3 + 1], bz2 = positions[b * 3 + 2];
          const dx = ax - bx2, dy = ay - by2, dz = az - bz2;
          const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

          if (dist < LINE_THRESHOLD && lineCount < maxLines - 2) {
            const alpha = 1 - dist / LINE_THRESHOLD;
            const idx = lineCount * 6;
            linePosArr[idx]     = ax;  linePosArr[idx + 1] = ay;  linePosArr[idx + 2] = az;
            linePosArr[idx + 3] = bx2; linePosArr[idx + 4] = by2; linePosArr[idx + 5] = bz2;

            const ca = colArr.slice(a * 3, a * 3 + 3);
            lineColArr[idx]     = ca[0] * alpha; lineColArr[idx + 1] = ca[1] * alpha; lineColArr[idx + 2] = ca[2] * alpha;
            lineColArr[idx + 3] = ca[0] * alpha; lineColArr[idx + 4] = ca[1] * alpha; lineColArr[idx + 5] = ca[2] * alpha;
            lineCount++;
          }
        }
      }
      lineGeo.attributes.position.needsUpdate = true;
      lineGeo.attributes.color.needsUpdate = true;
      lineGeo.setDrawRange(0, lineCount * 2);
    }

    renderer.render(scene, camera);
  };
  animate();
})();

// ─── 2. TYPEWRITER ──────────────────────────────────────────────────────────
(function initTypewriter() {
  const el = document.getElementById('typedText');
  if (!el) return;

  const words = [
    'Platform Engineers',
    'Developers',
    'DevOps Teams',
    'Your Company',
    'Modern Stacks',
  ];

  let wIdx = 0, cIdx = 0, deleting = false;
  let delay = 120;

  const tick = () => {
    const word = words[wIdx];
    el.textContent = deleting ? word.slice(0, cIdx--) : word.slice(0, cIdx++);

    if (!deleting && cIdx > word.length) {
      deleting = true;
      delay = 1800;
    } else if (deleting && cIdx < 0) {
      deleting = false;
      wIdx = (wIdx + 1) % words.length;
      cIdx = 0;
      delay = 400;
    } else {
      delay = deleting ? 60 : 110;
    }

    setTimeout(tick, delay);
  };
  setTimeout(tick, 1200);
})();

// ─── 3. COUNTER ANIMATION ───────────────────────────────────────────────────
(function initCounters() {
  const counters = [
    { id: 'stat1', target: 2847291, suffix: '',   decimals: 0 },
    { id: 'stat2', target: 342,     suffix: '+',  decimals: 0 },
    { id: 'stat3', target: 99.9,    suffix: '%',  decimals: 1 },
  ];

  const easeOut = (t) => 1 - Math.pow(1 - t, 4);
  const duration = 2200;

  const animateCounter = (el, target, suffix, decimals) => {
    const start = performance.now();
    const update = (now) => {
      const pct = Math.min((now - start) / duration, 1);
      const val = target * easeOut(pct);
      el.textContent = (decimals > 0 ? val.toFixed(decimals) : Math.floor(val).toLocaleString()) + suffix;
      if (pct < 1) requestAnimationFrame(update);
    };
    requestAnimationFrame(update);
  };

  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      counters.forEach(({ id, target, suffix, decimals }) => {
        const el = document.getElementById(id);
        if (el) animateCounter(el, target, suffix, decimals);
      });
      observer.disconnect();
    });
  }, { threshold: 0.5 });

  const statsEl = document.querySelector('.hero-stats');
  if (statsEl) observer.observe(statsEl);
})();

// ─── 4. NAVBAR SCROLL ───────────────────────────────────────────────────────
(function initNavbar() {
  const navbar = document.getElementById('navbar');
  if (!navbar) return;

  const onScroll = () => {
    if (window.scrollY > 50) navbar.classList.add('scrolled');
    else navbar.classList.remove('scrolled');
  };
  window.addEventListener('scroll', onScroll, { passive: true });

  // Mobile hamburger
  const btn  = document.getElementById('hamburger');
  const menu = document.getElementById('mobileMenu');
  if (btn && menu) {
    btn.addEventListener('click', () => {
      const open = menu.classList.toggle('open');
      btn.setAttribute('aria-expanded', String(open));
      menu.setAttribute('aria-hidden', String(!open));
    });
    // Close on link click
    menu.querySelectorAll('a').forEach((a) => {
      a.addEventListener('click', () => {
        menu.classList.remove('open');
        btn.setAttribute('aria-expanded', 'false');
        menu.setAttribute('aria-hidden', 'true');
      });
    });
  }
})();

// ─── 5. SCROLL REVEAL ───────────────────────────────────────────────────────
(function initReveal() {
  const targets = document.querySelectorAll(
    '.feature-card, .sdk-card, .pricing-card, .arch-layer, .section-header, .trust-logo'
  );

  targets.forEach((el) => el.classList.add('reveal'));

  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.1, rootMargin: '0px 0px -40px 0px' });

  targets.forEach((el) => observer.observe(el));
})();

// ─── 6. COPY BUTTONS ────────────────────────────────────────────────────────
(function initCopyButtons() {
  document.querySelectorAll('.copy-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const targetId = btn.dataset.copy;
      const codeEl = targetId ? document.getElementById(targetId) : null;
      const text = codeEl ? codeEl.textContent : '';
      if (!text) return;

      try {
        await navigator.clipboard.writeText(text.trim());
        const orig = btn.textContent;
        btn.textContent = '✓';
        btn.classList.add('copied');
        setTimeout(() => {
          btn.textContent = orig;
          btn.classList.remove('copied');
        }, 1800);
      } catch (_) {
        // fallback
        const ta = document.createElement('textarea');
        ta.value = text.trim();
        ta.style.cssText = 'position:fixed;opacity:0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
    });
  });
})();

// ─── 7. DOCUMENTATION ENGINE ─────────────────────────────────────────────────
const DOCS = {
  quickstart: `
<h1>Quick Start</h1>
<p class="docs-subtitle">Deploy the Platform and have your first project tracked in under 10 minutes.</p>

<div class="docs-alert info">ℹ️ <strong>Prerequisites:</strong> A Linux server (Ubuntu 20.04+) with at least 4 vCPUs / 8 GB RAM, a public IP, and SSH access. Docker must be installed.</div>

<h2>Step 1 — Clone and Configure</h2>
<pre><code>git clone https://github.com/Mpratyush54/platform-platform.git
cd platform-platform/platform-bootstrap
cp .env.example .env
# Edit .env — set DOMAIN, POSTGRES_PASSWORD, etc.</code></pre>

<h2>Step 2 — Run the Bootstrap Script</h2>
<p>The bootstrap script installs K3s, Helm, cert-manager, all services, and seeds the initial admin user. It is fully idempotent — safe to re-run.</p>
<pre><code>chmod +x bootstrap.sh
sudo ./bootstrap.sh 2>&1 | tee bootstrap.log</code></pre>
<p>Expected duration: <strong>8–15 minutes</strong> depending on internet speed. The script will print a ✅ for each completed phase.</p>

<h2>Step 3 — Access the Portal</h2>
<pre><code>https://YOUR_IP.sslip.io          # Platform Portal (Angular)
https://grafana.YOUR_IP.sslip.io  # Grafana (SSO)
https://minio.YOUR_IP.sslip.io    # MinIO Console (SSO)</code></pre>

<h2>Step 4 — Login</h2>
<pre><code>POST /api/auth/login
Content-Type: application/json
{ "email": "devops@platform.io" }

# Returns JWT token valid 24h</code></pre>

<div class="docs-alert tip">💡 Demo users are seeded automatically: <code>admin@dev.io</code>, <code>devops@platform.io</code>, <code>john@dev.io</code>, <code>sarah@dev.io</code></div>

<h2>Step 5 — Create Your First Project</h2>
<pre><code>POST /api/projects
Authorization: Bearer &lt;token&gt;
Content-Type: application/json

{
  "name": "my-app",
  "stack": "nodejs",
  "description": "My first Platform project"
}

# 201 Created → { "id": "uuid", "name": "my-app", ... }
# Side effect: 3 environments created automatically
#   - development, staging, production</code></pre>

<h2>Step 6 — Generate an SDK Token</h2>
<pre><code>POST /api/projects/:projectId/tokens
Authorization: Bearer &lt;token&gt;
Content-Type: application/json

{ "name": "production-token" }

# 201 Created → { "token": "sdk_live_...", ... }
# ⚠️  Token shown ONCE — save it immediately!</code></pre>

<h2>Step 7 — Instrument Your App</h2>
<pre><code>npm install @mpratyush54/sdk-node

import { createCapsClient } from '@mpratyush54/sdk-node'

const platform = createCapsClient({
  apiBase: 'https://YOUR_IP.sslip.io',
  token: 'sdk_live_...',
  projectId: 'my-app',
  environment: 'production'
})

app.use(platform.metrics.middleware())
platform.logger.info('App started', { port: 3000 })</code></pre>
`,

  auth: `
<h1>Authentication</h1>
<p class="docs-subtitle">Platform uses stateless JWT for user auth and a dedicated SDK token system for service-to-service communication.</p>

<h2>User Authentication (JWT)</h2>
<h3>Login</h3>
<div class="endpoint-block">
  <span class="method-badge method-post">POST</span>
  <span class="endpoint-path">/api/auth/login</span>
  <h4>Request Body</h4>
  <pre><code>{ "email": "user@example.com" }</code></pre>
  <h4>Response 200</h4>
  <pre><code>{
  "token": "eyJhbGci...",
  "user": {
    "id": "uuid",
    "email": "user@example.com",
    "name": "John Dev",
    "role": "developer",
    "roleId": null,
    "isActive": true,
    "lastLogin": "2026-07-01T10:17:47.200Z"
  }
}</code></pre>
</div>
<div class="docs-alert warn">⚠️ No password is required — Platform uses passwordless email-based auth. Restrict access at the network level.</div>

<h3>Using the JWT Token</h3>
<p>Pass the token as a Bearer in every authenticated request:</p>
<pre><code>Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...</code></pre>
<p>Tokens expire after <strong>24 hours</strong>. The payload includes: <code>id</code>, <code>email</code>, <code>name</code>, <code>role</code>.</p>

<h2>SDK Token Authentication</h2>
<p>SDK tokens are used by instrumented services to send logs, metrics, heartbeats, and bug reports. They are separate from user JWT tokens.</p>
<h3>Token Format</h3>
<pre><code>sdk_live_a1b2c3d4e5f6789abcdef01234567890   # Production token
sdk_test_a1b2c3d4e5f6789abcdef01234567890   # Test token</code></pre>
<p>Pass in the <code>Authorization</code> header:</p>
<pre><code>Authorization: Bearer sdk_live_...</code></pre>

<h3>Token Lifecycle</h3>
<ul>
  <li>Created via <code>POST /api/projects/:id/tokens</code> — returned plaintext ONCE</li>
  <li>Listed via <code>GET /api/projects/:id/tokens</code> — value masked (<code>sdk_live_1234...5678</code>)</li>
  <li>Revoked via <code>DELETE /api/projects/:id/tokens/:tokenId</code></li>
</ul>

<h2>OIDC / OAuth2 (for Admin Tools SSO)</h2>
<p>Platform exposes a standards-compliant OpenID Connect provider used to gate Portainer, Grafana, MinIO, and ArgoCD behind a single login.</p>
<table>
  <thead><tr><th>Endpoint</th><th>Description</th></tr></thead>
  <tbody>
    <tr><td><code>GET /api/oauth/.well-known/openid-configuration</code></td><td>Discovery document</td></tr>
    <tr><td><code>GET /api/oauth/jwks</code></td><td>RSA-2048 public key (RS256)</td></tr>
    <tr><td><code>GET /api/oauth/authorize</code></td><td>Authorization endpoint (redirects to portal login)</td></tr>
    <tr><td><code>POST /api/oauth/token</code></td><td>Token exchange — returns access_token + id_token</td></tr>
    <tr><td><code>GET /api/oauth/userinfo</code></td><td>Returns user profile from access token</td></tr>
  </tbody>
</table>

<h2>Error Responses</h2>
<table>
  <thead><tr><th>Status</th><th>Body</th><th>Cause</th></tr></thead>
  <tbody>
    <tr><td>401</td><td><code>{ "error": "Unauthorized: Missing token" }</code></td><td>No Authorization header</td></tr>
    <tr><td>401</td><td><code>{ "error": "Unauthorized: Invalid or expired token" }</code></td><td>Bad / expired JWT</td></tr>
    <tr><td>401</td><td><code>{ "error": "Unauthorized: User not found" }</code></td><td>User deleted after token issued</td></tr>
    <tr><td>403</td><td><code>{ "error": "Forbidden: Insufficient permissions" }</code></td><td>Wrong role for route</td></tr>
  </tbody>
</table>
`,

  roles: `
<h1>Roles &amp; Permissions</h1>
<p class="docs-subtitle">Platform has a two-tier authorization system: built-in role presets and fine-grained custom roles with explicit permission arrays.</p>

<h2>Built-in Roles</h2>
<table>
  <thead><tr><th>Role</th><th>Level</th><th>Key Capabilities</th></tr></thead>
  <tbody>
    <tr><td><code>admin</code></td><td>Superuser</td><td>All permissions</td></tr>
    <tr><td><code>devops</code></td><td>Operations</td><td>Full platform management — deploys, databases, secrets, users, cluster</td></tr>
    <tr><td><code>tech_lead</code></td><td>Engineering Lead</td><td>Projects, deployments, configs, secrets (no delete), alerts, logs</td></tr>
    <tr><td><code>developer</code></td><td>Engineer</td><td>Trigger deploys, read configs, send SDK telemetry</td></tr>
    <tr><td><code>viewer</code></td><td>Read-only</td><td>View projects, deployments, logs, metrics</td></tr>
  </tbody>
</table>

<h2>Custom Roles</h2>
<p>Create custom roles with explicit permission arrays via the API:</p>
<pre><code>POST /api/roles
Authorization: Bearer &lt;token&gt;   (users.create permission required)

{
  "name": "ci-bot",
  "description": "CI/CD automation account",
  "permissions": [
    "deployments.trigger",
    "deployments.read",
    "logs.read",
    "metrics.read"
  ]
}</code></pre>

<h2>All Available Permissions</h2>
<table>
  <thead><tr><th>Category</th><th>Permission Key</th></tr></thead>
  <tbody>
    <tr><td>Users</td><td><code>users.list</code> <code>users.create</code> <code>users.update</code> <code>users.delete</code> <code>users.assign-role</code> <code>users.read-profile</code></td></tr>
    <tr><td>Projects</td><td><code>projects.list</code> <code>projects.create</code> <code>projects.update</code> <code>projects.delete</code> <code>projects.read</code></td></tr>
    <tr><td>Deployments</td><td><code>deployments.trigger</code> <code>deployments.terminate</code> <code>deployments.restart</code> <code>deployments.scale</code> <code>deployments.read</code> <code>deployments.rollback</code></td></tr>
    <tr><td>Secrets</td><td><code>secrets.list</code> <code>secrets.reveal</code> <code>secrets.create</code> <code>secrets.delete</code> <code>secrets.export</code> <code>secrets.import</code> <code>secrets.rollback</code></td></tr>
    <tr><td>Databases</td><td><code>databases.provision</code> <code>databases.backup</code> <code>databases.restore</code> <code>databases.read</code> <code>databases.create-connection</code> <code>databases.delete-connection</code></td></tr>
    <tr><td>Config</td><td><code>config.read</code> <code>config.update</code> <code>config.delete</code> <code>config.manage-feature-flags</code></td></tr>
    <tr><td>Alerts</td><td><code>alerts.list</code> <code>alerts.create</code> <code>alerts.update</code> <code>alerts.delete</code></td></tr>
    <tr><td>Logs &amp; Metrics</td><td><code>logs.read</code> <code>logs.search</code> <code>metrics.read</code> <code>metrics.read-rpm</code></td></tr>
    <tr><td>SDK</td><td><code>sdk.send-logs</code> <code>sdk.send-metrics</code> <code>sdk.send-bug-reports</code></td></tr>
    <tr><td>Settings</td><td><code>settings.smtp.read</code> <code>settings.smtp.manage</code> <code>settings.storage.read</code> <code>settings.storage.manage</code></td></tr>
    <tr><td>Cluster</td><td><code>cluster.read</code> <code>cluster.manage</code> <code>cluster.pods.read</code> <code>cluster.pods.delete</code></td></tr>
  </tbody>
</table>
`,

  projects: `
<h1>Projects API</h1>
<p class="docs-subtitle">Projects are the primary organizational unit in Platform. Each project gets its own environments, secrets namespace, SDK tokens, and deployments.</p>

<h3><span class="method-badge method-get">GET</span><span class="endpoint-path">/api/projects</span></h3>
<p>List all active projects. Returns soft-deleted projects excluded by default.</p>
<div class="docs-alert info">Requires any valid JWT. Returns only projects visible to the authenticated user.</div>

<h3><span class="method-badge method-post">POST</span><span class="endpoint-path">/api/projects</span></h3>
<p>Create a new project. Roles: <strong>devops</strong>, <strong>tech_lead</strong>.</p>
<pre><code>{
  "name": "my-service",          // required, unique, max 100 chars
  "stack": "nodejs",             // required: nodejs | angular | python | static
  "description": "string",       // optional
  "repositoryUrl": "https://...",// optional
  "domain": "app.example.com",   // optional
  "clickupListId": "abc123"      // optional
}</code></pre>
<p><strong>Side effect:</strong> Automatically creates 3 Environments: <code>development</code>, <code>staging</code>, <code>production</code>.</p>
<p>Returns <code>201</code> with the full Project entity including <code>id</code>.</p>

<h3><span class="method-badge method-get">GET</span><span class="endpoint-path">/api/projects/:id</span></h3>
<p>Get a single project by UUID. Returns <code>404</code> if not found or soft-deleted.</p>

<h3><span class="method-badge method-put">PUT</span><span class="endpoint-path">/api/projects/:id</span></h3>
<p>Update a project. Roles: <strong>devops</strong>, <strong>tech_lead</strong>. Partial updates supported.</p>

<h3><span class="method-badge method-delete">DELETE</span><span class="endpoint-path">/api/projects/:id</span></h3>
<p>Soft-delete a project. Roles: <strong>devops</strong> only. Sets <code>deletedAt</code> timestamp and <code>isActive = false</code>. Does not remove the database record.</p>

<h2>SDK Tokens</h2>
<h3><span class="method-badge method-post">POST</span><span class="endpoint-path">/api/projects/:projectId/tokens</span></h3>
<pre><code>{ "name": "production-server-1" }</code></pre>
<div class="docs-alert warn">⚠️ The <code>token</code> field in the response is shown only once. Store it securely — retrieval is impossible after this response.</div>

<h3><span class="method-badge method-delete">DELETE</span><span class="endpoint-path">/api/projects/:projectId/tokens/:tokenId</span></h3>
<p>Permanently revokes a token. All SDK calls using this token will immediately return <code>401</code>.</p>
`,

  databases: `
<h1>Databases API</h1>
<p class="docs-subtitle">Platform provisions isolated PostgreSQL databases per project/environment. Each database gets unique credentials stored only once.</p>

<h2>Provision a Database</h2>
<h3><span class="method-badge method-post">POST</span><span class="endpoint-path">/api/projects/:projectId/databases/provision</span></h3>
<p>Roles: <strong>devops</strong> only.</p>
<pre><code>{ "environment": "development" }   // or staging | production</code></pre>
<pre><code>// 201 Created
{
  "dbName": "platform_myapp_development",
  "username": "platform_myapp_development_user",
  "password": "9EQWMy...8mr",          // shown ONCE
  "host": "postgresql.databases",
  "port": 5432,
  "connectionString": "postgresql://user:pass@host:5432/dbname",
  "message": "Database provisioned. Save these credentials — the password will not be shown again."
}</code></pre>
<div class="docs-alert danger">🔴 The <code>password</code> is returned ONCE and never stored in plaintext. Save it in your secrets manager immediately.</div>

<h2>Database Backups</h2>
<h3><span class="method-badge method-post">POST</span><span class="endpoint-path">/api/projects/:projectId/databases/backup</span></h3>
<p>Triggers an async <code>pg_dump</code> to MinIO (S3-compatible storage). Roles: <strong>devops</strong> only.</p>
<pre><code>{ "environment": "production", "dbName": "platform_myapp_production" }</code></pre>
<pre><code>// 202 Accepted (async)
{ "backupId": "uuid", "status": "in_progress", "message": "Backup started." }</code></pre>

<h3><span class="method-badge method-get">GET</span><span class="endpoint-path">/api/projects/:projectId/databases/backups</span></h3>
<p>List all backup records for a project with status, file size, and checksum.</p>

<h3><span class="method-badge method-post">POST</span><span class="endpoint-path">/api/projects/:projectId/databases/backups/:backupId/restore</span></h3>
<p>Restore a completed backup to the target database. Roles: <strong>devops</strong> only.</p>
<div class="docs-alert warn">⚠️ Restore is destructive — all existing data in the target database is overwritten.</div>

<h2>Backup Status Values</h2>
<table>
  <thead><tr><th>Status</th><th>Meaning</th></tr></thead>
  <tbody>
    <tr><td><code>pending</code></td><td>Job queued</td></tr>
    <tr><td><code>in_progress</code></td><td>pg_dump / upload running</td></tr>
    <tr><td><code>completed</code></td><td>Uploaded to MinIO, checksum verified</td></tr>
    <tr><td><code>failed</code></td><td>Error in pg_dump or S3 upload — see <code>errorMessage</code></td></tr>
    <tr><td><code>restoring</code></td><td>pg_restore running</td></tr>
  </tbody>
</table>
`,

  secrets: `
<h1>Secrets API</h1>
<p class="docs-subtitle">Encrypted key-value store using AES-256-GCM. All values are encrypted at rest; the encryption key never leaves the server.</p>

<h2>Create a Secret</h2>
<h3><span class="method-badge method-post">POST</span><span class="endpoint-path">/api/projects/:projectId/secrets</span></h3>
<p>Permission: <code>secrets.create</code></p>
<pre><code>{
  "key": "DATABASE_URL",
  "value": "postgresql://...",
  "environmentId": "development"   // optional — omit for global
}</code></pre>

<h2>Reveal a Secret Value</h2>
<h3><span class="method-badge method-post">POST</span><span class="endpoint-path">/api/projects/:projectId/secrets/reveal</span></h3>
<p>Permission: <code>secrets.reveal</code>. Decrypts and returns the plaintext value. Every reveal is logged in the audit trail.</p>
<pre><code>{ "key": "DATABASE_URL", "environmentId": "development" }</code></pre>
<pre><code>// 200 OK
{ "key": "DATABASE_URL", "value": "postgresql://..." }</code></pre>

<h2>List Secrets</h2>
<h3><span class="method-badge method-get">GET</span><span class="endpoint-path">/api/projects/:projectId/secrets</span></h3>
<p>Permission: <code>secrets.list</code>. Returns metadata only — <code>encryptedValue</code> is never returned in listings.</p>

<h2>Delete a Secret</h2>
<h3><span class="method-badge method-delete">DELETE</span><span class="endpoint-path">/api/projects/:projectId/secrets/:secretId</span></h3>
<p>Permission: <code>secrets.delete</code>. Marks the secret as inactive (soft-delete).</p>

<h2>Version History &amp; Rollback</h2>
<h3><span class="method-badge method-get">GET</span><span class="endpoint-path">/api/projects/:projectId/secrets/:secretId/versions</span></h3>
<p>Permission: <code>secrets.list</code>. Returns all historical versions of a secret.</p>
<h3><span class="method-badge method-post">POST</span><span class="endpoint-path">/api/projects/:projectId/secrets/:secretId/rollback/:version</span></h3>
<p>Permission: <code>secrets.rollback</code>. Restores a previous version as the current value.</p>

<h2>Bulk Import / Export</h2>
<h3><span class="method-badge method-post">POST</span><span class="endpoint-path">/api/projects/:projectId/secrets/bulk</span></h3>
<p>Permission: <code>secrets.import</code>. Accepts an array of <code>{ key, value, environmentId }</code> objects.</p>
<h3><span class="method-badge method-get">GET</span><span class="endpoint-path">/api/projects/:projectId/secrets/export/:environmentId</span></h3>
<p>Permission: <code>secrets.export</code>. Returns a <code>.env</code>-format file download.</p>

<div class="docs-alert danger">🔴 Ensure <code>SECRETS_ENCRYPTION_KEY</code> is set on the server. If missing, all secret operations return <code>500 { "error": "SECRETS_ENCRYPTION_KEY not configured" }</code></div>
`,

  deployments: `
<h1>Deployments API</h1>
<p class="docs-subtitle">Trigger, monitor, rollback, and terminate Kubernetes deployments from Platform.</p>

<h2>Trigger a Deployment</h2>
<h3><span class="method-badge method-post">POST</span><span class="endpoint-path">/api/deploy</span></h3>
<p>Roles: <strong>devops</strong>, <strong>tech_lead</strong>, <strong>developer</strong></p>
<pre><code>{
  "projectId": "uuid",           // required
  "environmentId": "uuid",       // required (or use environmentName: "preview")
  "version": "1.2.0",            // optional, default: "1.0.0"
  "branch": "main",              // optional
  "commitSha": "abc1234",        // optional
  "imageTag": "my-app:1.2.0",    // optional
  "metadata": {}                 // optional extra data
}</code></pre>
<p>Returns <code>201</code> immediately with a <code>pending</code> Deployment. Actual Kubernetes deploy runs asynchronously (delayed 1s to allow response).</p>

<h2>Rollback</h2>
<h3><span class="method-badge method-post">POST</span><span class="endpoint-path">/api/rollback</span></h3>
<p>Roles: <strong>devops</strong>, <strong>tech_lead</strong>. Rolls back to a prior Deployment version.</p>
<pre><code>{ "deploymentId": "uuid", "previousVersion": "1.1.0" }</code></pre>

<h2>Deployment Operations</h2>
<table>
  <thead><tr><th>Operation</th><th>Endpoint</th><th>Roles</th></tr></thead>
  <tbody>
    <tr><td>List by project</td><td><code>GET /api/deployments/:projectId</code></td><td>Any auth</td></tr>
    <tr><td>Restart pods</td><td><code>POST /api/deployments/:id/restart</code></td><td>devops only</td></tr>
    <tr><td>Scale replicas</td><td><code>PATCH /api/deployments/:id/scale</code></td><td>devops only</td></tr>
    <tr><td>Terminate</td><td><code>POST /api/deployments/:id/terminate</code></td><td>devops, tech_lead, developer</td></tr>
  </tbody>
</table>

<h2>Status Lifecycle</h2>
<pre><code>pending → building → deploying → deployed
                               ↘ failed
                    rolled_back ←──────
                    terminated  ←──────
                    expired     (preview envs only)</code></pre>
`,

  'sdk-node': `
<h1>Node.js SDK</h1>
<p class="docs-subtitle">Zero-overhead telemetry for Express, Fastify, and NestJS applications.</p>

<h2>Installation</h2>
<pre><code>npm install @mpratyush54/sdk-node</code></pre>

<h2>Initialization</h2>
<pre><code>import { createCapsClient } from '@mpratyush54/sdk-node'

const platform = createCapsClient({
  apiBase:     'https://platform.your-domain.io',
  token:       'sdk_live_...',
  projectId:   'my-app',           // project name or UUID
  environment: 'production',
  version:     '1.2.0',            // optional
  branch:      'main',             // optional
})</code></pre>

<h2>Metrics Middleware</h2>
<pre><code>// Express — attach before your routes
app.use(platform.metrics.middleware())

// Per-request captures:
//   route       → normalized path (/users/:id not /users/123)
//   method      → GET, POST, etc.
//   statusCode  → response status
//   durationMs  → hrtime precision
//   memDelta    → heap delta in bytes</code></pre>

<p>Metrics are buffered in-memory and flushed every <strong>5 seconds</strong> (or when buffer reaches 100 entries). Failed flushes re-queue up to 500 entries.</p>

<h2>Structured Logger</h2>
<pre><code>platform.logger.info('User created', { userId: '123', plan: 'pro' })
platform.logger.warn('Rate limit approaching', { remaining: 10 })
platform.logger.error('Payment failed', { orderId: '456', code: 'CARD_DECLINED' })</code></pre>
<p>Logs are sent to <code>POST /api/sdk/logs</code> with <code>level</code>, <code>message</code>, and structured <code>fields</code>.</p>

<h2>Heartbeat</h2>
<p>Sent automatically every <strong>30 seconds</strong> with CPU %, memory MB, heap MB, uptime, and request counters. Powers the service health dashboard.</p>

<h2>Config Sync</h2>
<pre><code>const config = await platform.config.get()
// Returns key-value pairs from GET /api/sdk/config for this project+env</code></pre>

<h2>Stop</h2>
<pre><code>// Flush remaining metrics and stop the heartbeat interval
await platform.stop()</code></pre>
`,

  'sdk-react': `
<h1>React SDK</h1>
<p class="docs-subtitle">Automatic HTTP latency tracking and an instant bug-reporter widget for React apps.</p>

<h2>Installation</h2>
<pre><code>npm install @mpratyush54/sdk-react</code></pre>

<h2>Setup: CapsProvider</h2>
<pre><code>import { CapsProvider } from '@mpratyush54/sdk-react'

const platformConfig = {
  apiBase:     'https://platform.your-domain.io',
  token:       'sdk_live_...',
  projectId:   'bc145854-...',
  environment: 'production'
}

// Wrap your app root
&lt;CapsProvider config={platformConfig}&gt;
  &lt;App /&gt;
&lt;/CapsProvider&gt;</code></pre>

<h2>useCaps Hook</h2>
<pre><code>import { useCaps } from '@mpratyush54/sdk-react'

function MyComponent() {
  const { api } = useCaps()
  // api is an Axios instance — all calls are auto-timed
  // Duration + status automatically sent to /api/sdk/api-metrics
  const data = await api.get('/api/users')
}</code></pre>

<h2>BugReporterWidget</h2>
<pre><code>import { BugReporterWidget } from '@mpratyush54/sdk-react'

// Add anywhere — renders a floating 🐛 button
&lt;BugReporterWidget config={platformConfig} /&gt;</code></pre>

<p>When submitted, the widget captures:</p>
<ul>
  <li>User-provided description and category</li>
  <li>Last N <code>console.log / warn / error</code> entries (hooked at SDK init)</li>
  <li>Network timeline of recent <code>fetch</code> calls</li>
  <li>Full-page base64 screenshot via <code>html2canvas</code></li>
  <li>Browser info (userAgent, URL, viewport, online status)</li>
</ul>
`,

  'sdk-python': `
<h1>Python SDK</h1>
<p class="docs-subtitle">Django, Flask, and FastAPI compatible telemetry with zero configuration overhead.</p>

<h2>Installation</h2>
<pre><code>pip install platform-sdk-python</code></pre>

<h2>Setup</h2>
<pre><code>from platform_sdk import CapsClient

platform = CapsClient(
    api_base='https://platform.your-domain.io',
    token='sdk_live_...',
    project_id='my-python-app',
    environment='production'
)</code></pre>

<h2>Django Middleware</h2>
<pre><code># settings.py
MIDDLEWARE = [
    'platform_sdk.django.CapsMiddleware',
    ...
]

Platform_CONFIG = {
    'api_base': 'https://platform.your-domain.io',
    'token': 'sdk_live_...',
    'project_id': 'my-django-app',
}</code></pre>

<h2>Flask Integration</h2>
<pre><code>from platform_sdk.flask import init_platform
init_platform(app, platform)</code></pre>

<h2>Structured Logging</h2>
<pre><code>platform.logger.info('Order processed', order_id='123', amount=99.99)
platform.logger.error('Payment failed', code='CARD_DECLINED')</code></pre>
`,

  'sdk-metrics': `
<h1>API Metrics Reference</h1>
<p class="docs-subtitle">Understand what's collected, how it's aggregated, and how to query it.</p>

<h2>What's Collected (per request)</h2>
<table>
  <thead><tr><th>Field</th><th>Type</th><th>Description</th></tr></thead>
  <tbody>
    <tr><td><code>route</code></td><td>string</td><td>Normalized path — IDs replaced with <code>:id</code></td></tr>
    <tr><td><code>method</code></td><td>string</td><td>HTTP verb (GET, POST, etc.)</td></tr>
    <tr><td><code>statusCode</code></td><td>number</td><td>HTTP response status code</td></tr>
    <tr><td><code>durationMs</code></td><td>number</td><td>Request duration in milliseconds (hrtime precision)</td></tr>
    <tr><td><code>memoryDeltaBytes</code></td><td>number</td><td>Heap memory delta between request start and finish</td></tr>
    <tr><td><code>environment</code></td><td>string</td><td>The environment name (production, staging, etc.)</td></tr>
    <tr><td><code>timestamp</code></td><td>ISO string</td><td>When the request completed</td></tr>
  </tbody>
</table>

<h2>Path Normalization</h2>
<pre><code>// Raw paths become normalized routes:
GET /users/12345         → /users/:id
GET /orders/abc-def-123  → /orders/:id
GET /users?page=2        → /users  (query strings stripped)
GET /api/v1/projects/    → /api/v1/projects  (trailing slash stripped)</code></pre>

<h2>Aggregation (GET /api/sdk/api-metrics)</h2>
<pre><code>// Query parameters:
//   projectId  — required (name or UUID)
//   from       — ISO date (optional)
//   to         — ISO date (optional)

// Response per route/method:
{
  "metrics": [
    {
      "route": "/api/users/:id",
      "method": "GET",
      "count": 8421,
      "avgDuration": 23,
      "p50": 18,
      "p95": 67,
      "p99": 142,
      "errors4xx": 12,
      "errors5xx": 1,
      "lastSeen": "2026-07-01T10:17:54Z"
    }
  ]
}</code></pre>

<h2>Data Retention</h2>
<p>Raw metric documents expire after <strong>30 days</strong> via MongoDB TTL index. Aggregate queries use <code>$group</code> with percentile approximation over all retained data.</p>
`,

  bootstrap: `
<h1>Bootstrap &amp; Infrastructure</h1>
<p class="docs-subtitle">The Platform bootstrap script is a single-file idempotent installer for the entire platform stack on any Linux server.</p>

<h2>What the Bootstrap Script Installs</h2>
<table>
  <thead><tr><th>Phase</th><th>Component</th></tr></thead>
  <tbody>
    <tr><td>1</td><td>System dependencies (curl, git, Docker)</td></tr>
    <tr><td>2</td><td>K3s (lightweight Kubernetes)</td></tr>
    <tr><td>3</td><td>Helm 3</td></tr>
    <tr><td>4</td><td>ingress-nginx (LoadBalancer)</td></tr>
    <tr><td>5</td><td>cert-manager + ClusterIssuer (Let's Encrypt)</td></tr>
    <tr><td>6</td><td>PostgreSQL (Bitnami Helm)</td></tr>
    <tr><td>7</td><td>MongoDB (Bitnami Helm)</td></tr>
    <tr><td>8</td><td>Redis (Bitnami Helm)</td></tr>
    <tr><td>9</td><td>MinIO (object storage)</td></tr>
    <tr><td>10</td><td>Grafana + Prometheus + Loki + Promtail</td></tr>
    <tr><td>11</td><td>ArgoCD</td></tr>
    <tr><td>12</td><td>Portainer (--no-setup-token)</td></tr>
    <tr><td>13</td><td>oauth2-proxy (SSO gateway for admin tools)</td></tr>
    <tr><td>14</td><td>Platform API + Portal (built locally via Docker)</td></tr>
    <tr><td>15</td><td>Database seeding + admin user creation</td></tr>
  </tbody>
</table>

<h2>Idempotency</h2>
<p>Each phase writes a marker file to <code>/etc/platform/done/</code>. Re-running the script skips already-completed phases. To force a re-run of a phase, delete the marker file:</p>
<pre><code>rm /etc/platform/done/postgresql
sudo ./bootstrap.sh   # replays only postgresql phase</code></pre>

<h2>Bootstrap API</h2>
<h3><span class="method-badge method-get">GET</span><span class="endpoint-path">/api/bootstrap/status</span></h3>
<p>Returns K8s cluster health, all namespace pod counts, and platform service reachability.</p>
<h3><span class="method-badge method-get">GET</span><span class="endpoint-path">/api/bootstrap/pods</span></h3>
<p>Lists all pods across all namespaces. Roles: <strong>devops</strong> only.</p>
`,

  monitoring: `
<h1>Monitoring &amp; Observability</h1>
<p class="docs-subtitle">Platform ships a pre-configured Grafana + Prometheus + Loki stack. Zero additional setup required.</p>

<h2>Access URLs</h2>
<pre><code>Grafana:    https://grafana.YOUR_IP.sslip.io   (SSO)
Prometheus: Internal only (prometheus.monitoring:9090)
Loki:       Internal only (loki.monitoring:3100)</code></pre>

<h2>What's Monitored</h2>
<ul>
  <li><strong>Node metrics</strong> — CPU, memory, disk via node-exporter</li>
  <li><strong>K8s metrics</strong> — Pod status, container restarts, resource limits via kube-state-metrics</li>
  <li><strong>Application logs</strong> — All pod stdout/stderr collected by Promtail → Loki</li>
  <li><strong>SDK metrics</strong> — API latency, error rates, memory deltas from your apps</li>
  <li><strong>Service health</strong> — SDK heartbeats stored as MetricsRaw documents in MongoDB</li>
</ul>

<h2>Log Querying</h2>
<h3><span class="method-badge method-get">GET</span><span class="endpoint-path">/api/logs/search</span></h3>
<pre><code>// Query parameters:
//   projectId  — filter by project
//   level      — INFO | WARN | ERROR | DEBUG
//   from / to  — ISO date range
//   q          — full-text search in message field</code></pre>
`,

  errors: `
<h1>Error Reference</h1>
<p class="docs-subtitle">Complete reference for all HTTP error codes and response bodies returned by the Platform API.</p>

<h2>Standard Error Body</h2>
<pre><code>{ "error": "Human-readable error message" }

// For permission errors, includes required permissions:
{ "error": "Forbidden: Insufficient permissions", "required": ["secrets.reveal"] }

// 404 fallback for unknown routes:
{ "error": "Route not found: GET /api/unknown" }</code></pre>

<h2>Status Code Reference</h2>
<table>
  <thead><tr><th>Code</th><th>Meaning</th><th>Example Cause</th></tr></thead>
  <tbody>
    <tr><td>200</td><td>OK</td><td>Successful read/update</td></tr>
    <tr><td>201</td><td>Created</td><td>New resource created</td></tr>
    <tr><td>202</td><td>Accepted</td><td>Async job started (backup, restore)</td></tr>
    <tr><td>400</td><td>Bad Request</td><td>Missing required fields, validation error</td></tr>
    <tr><td>401</td><td>Unauthorized</td><td>Missing/invalid/expired token</td></tr>
    <tr><td>403</td><td>Forbidden</td><td>Authenticated but wrong role/permission</td></tr>
    <tr><td>404</td><td>Not Found</td><td>Resource or route does not exist</td></tr>
    <tr><td>409</td><td>Conflict</td><td>Duplicate email, duplicate role name, duplicate project name</td></tr>
    <tr><td>500</td><td>Internal Server Error</td><td>Missing env var, unexpected exception</td></tr>
  </tbody>
</table>

<h2>Common Error Messages</h2>
<table>
  <thead><tr><th>Error</th><th>HTTP</th></tr></thead>
  <tbody>
    <tr><td><code>Unauthorized: Missing token</code></td><td>401</td></tr>
    <tr><td><code>Unauthorized: Invalid or expired token</code></td><td>401</td></tr>
    <tr><td><code>Unauthorized: User not found</code></td><td>401</td></tr>
    <tr><td><code>Unauthorized: Missing SDK token</code></td><td>401</td></tr>
    <tr><td><code>Unauthorized: Invalid or revoked SDK token</code></td><td>401</td></tr>
    <tr><td><code>Forbidden: Insufficient permissions</code></td><td>403</td></tr>
    <tr><td><code>Project not found</code></td><td>404</td></tr>
    <tr><td><code>Secret not found</code></td><td>404</td></tr>
    <tr><td><code>SECRETS_ENCRYPTION_KEY not configured</code></td><td>500</td></tr>
  </tbody>
</table>
`,
};

(function initDocs() {
  const content = document.getElementById('docsContent');
  const buttons = document.querySelectorAll('.docs-nav-btn');
  if (!content || !buttons.length) return;

  const load = (key) => {
    const html = DOCS[key];
    if (!html) return;
    content.style.opacity = '0';
    setTimeout(() => {
      content.innerHTML = html;
      content.style.opacity = '1';
    }, 140);

    buttons.forEach((b) => {
      b.classList.toggle('active', b.dataset.doc === key);
    });
  };

  buttons.forEach((btn) => {
    btn.addEventListener('click', () => load(btn.dataset.doc));
  });

  // Load default
  load('quickstart');
})();

// ─── 8. SMOOTH ANCHOR SCROLLING (for hash links in docs) ────────────────────
document.querySelectorAll('a[href^="#"]').forEach((link) => {
  link.addEventListener('click', (e) => {
    const id = link.getAttribute('href').slice(1);
    const target = document.getElementById(id);
    if (!target) return;
    e.preventDefault();
    const offset = 80;
    const top = target.getBoundingClientRect().top + window.scrollY - offset;
    window.scrollTo({ top, behavior: 'smooth' });
  });
});

// ─── 9. ACTIVE NAV SECTION HIGHLIGHTING ─────────────────────────────────────
(function initActiveNav() {
  const sections = document.querySelectorAll('section[id], footer[id]');
  const navLinks = document.querySelectorAll('.nav-links a');

  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        navLinks.forEach((a) => {
          const href = a.getAttribute('href');
          a.style.color = href === '#' + entry.target.id ? '#a78bfa' : '';
        });
      }
    });
  }, { threshold: 0.3 });

  sections.forEach((s) => observer.observe(s));
})();

// ─── 10. PERFORMANCE MARK ────────────────────────────────────────────────────
if (window.performance && window.performance.mark) {
  window.performance.mark('platform-landing-loaded');
}
