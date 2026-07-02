# @mpratyush54/sdk-node

The official Node.js SDK for the Platform. 

This SDK provides core backend integrations for your microservices, including auto-registration with the platform, metrics aggregation, structured logging, centralized configuration, and standardized database connections.

## Installation

```bash
npm install @mpratyush54/sdk-node
```

## Features

- **Service Registration:** Automatically registers your microservice with the Platform API on startup.
- **Metrics Aggregation:** Intercepts requests and records route metrics, execution times, and memory deltas.
- **Database Connections:** Pre-configured Mongoose, PostgreSQL, and Redis connection utilities.
- **Logging:** Structured logging that automatically ships to the platform.

## Usage

```javascript
import { PlatformSDK } from '@mpratyush54/sdk-node';

const sdk = new PlatformSDK({
  projectId: process.env.PLATFORM_PROJECT_ID,
  environment: process.env.NODE_ENV || 'development',
  apiUrl: 'http://platform-api:3000'
});

// Initialize connections and register service
await sdk.initialize();

// Database connections are available via the SDK instance
const { mongoose, pg, redis } = sdk.connections;
```
