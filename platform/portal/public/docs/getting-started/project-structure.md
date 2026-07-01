# Project Structure

Platform is a monorepo containing the backend API, admin dashboard, four SDKs, a cluster bootstrap tool, and documentation.

<div class="docs-file-tree">
  <ul>
    <li>
      <svg class="icon folder" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/></svg>
      <span class="name">platform/</span>
    </li>
    <ul>
      <li>
        <svg class="icon folder" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/></svg>
        <span class="name">api/</span>
        <span class="desc">Express + TypeORM backend</span>
      </li>
      <ul>
        <li>
          <svg class="icon folder" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/></svg>
          <span class="name">config/</span>
          <span class="desc">Database, permissions, settings</span>
        </li>
        <li>
          <svg class="icon folder" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/></svg>
          <span class="name">entities/</span>
          <span class="desc">TypeORM postgres entities</span>
        </li>
        <li>
          <svg class="icon folder" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/></svg>
          <span class="name">schemas/</span>
          <span class="desc">Mongoose metric models</span>
        </li>
        <li>
          <svg class="icon file" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/></svg>
          <span class="name">server.ts</span>
          <span class="desc">API Entry point</span>
        </li>
      </ul>
      <li>
        <svg class="icon folder" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/></svg>
        <span class="name">portal/</span>
        <span class="desc">Angular 19 Admin Dashboard</span>
      </li>
      <li>
        <svg class="icon folder" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/></svg>
        <span class="name">sdk-node/</span>
        <span class="desc">@mpratyush54/sdk-node</span>
      </li>
      <li>
        <svg class="icon folder" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/></svg>
        <span class="name">sdk-python/</span>
        <span class="desc">platform-sdk-python</span>
      </li>
      <li>
        <svg class="icon folder" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/></svg>
        <span class="name">sdk-react/</span>
        <span class="desc">@mpratyush54/sdk-react</span>
      </li>
      <li>
        <svg class="icon folder" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/></svg>
        <span class="name">platform-bootstrap/</span>
        <span class="desc">k3s cluster setup tools</span>
      </li>
    </ul>
  </ul>
</div>

## Directory Relationships

| Directory | Depends On | Purpose |
|---|---|---|
| `api` | PostgreSQL, MongoDB, Redis | Central backend — all SDKs and the portal communicate with the API |
| `portal` | `api` (via REST) | Admin dashboard for managing projects, deployments, and secrets |
| `sdk-node` | `api` (via REST) | Instrument Node.js services with metrics, logs, and bug reports |
| `sdk-python` | `api` (via REST) | Instrument Python services with metrics, logs, and bug reports |
| `sdk-react` | `api` (via REST) | Instrument React frontends with error boundaries and bug reporting |
| `sdk-angular` | `api` (via REST) | Instrument Angular frontends with HTTP interceptors and error handlers |
| `platform-bootstrap` | `api`, `portal` | Deploys the full stack onto a k3s cluster |

## Key Files

| File | Purpose |
|---|---|
| `api/src/server.ts` | Express app bootstrap — registers middleware, routes, and starts the HTTP server |
| `api/src/config/permissions.ts` | Role-based permission matrix — defines what each role can access |
| `api/src/lib/preview-decay.ts` | Scheduler that automatically cleans up stale preview environments |
| `portal/src/app/pages/` | All UI views — each page maps to a route in the Angular router |
| `platform-bootstrap/bootstrap.sh` | Single script that provisions a production-ready k3s cluster |
