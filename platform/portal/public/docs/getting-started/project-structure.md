# Project Structure

Platform is a monorepo containing the backend API, admin dashboard, four SDKs, a cluster bootstrap tool, and documentation.

```mermaid
graph TB
    Root["platform/"]
    API["api/<br/>Express + TypeORM + Mongoose"]
    Portal["portal/<br/>Angular 19 Dashboard"]
    SDKNode["sdk-node/<br/>@mpratyush54/sdk-node"]
    SDKPython["sdk-python/<br/>platform-sdk-python"]
    SDKReact["sdk-react/<br/>@mpratyush54/sdk-react"]
    SDKAngular["sdk-angular/<br/>@mpratyush54/sdk-angular"]
    Bootstrap["platform-bootstrap/<br/>k3s Cluster Setup"]
    Docs["docs/<br/>Documentation"]

    subgraph APIInternals["api/ internals"]
        Config["config/<br/>DB, permissions, routes"]
        Entities["entities/<br/>18 TypeORM entities"]
        Lib["lib/<br/>k8s, Loki, preview-decay"]
        Middleware["middleware/<br/>JWT, RBAC, audit"]
        Routes["routes/<br/>18 route handlers"]
        Schemas["schemas/<br/>Mongoose models"]
        Server["server.ts<br/>Entry point"]
    end

    Root --> API
    Root --> Portal
    Root --> SDKNode
    Root --> SDKPython
    Root --> SDKReact
    Root --> SDKAngular
    Root --> Bootstrap
    Root --> Docs

    API --> Config
    API --> Entities
    API --> Lib
    API --> Middleware
    API --> Routes
    API --> Schemas
    API --> Server
```

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
