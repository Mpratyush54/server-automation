import express from 'express';
import cors from 'cors';
import caps from '@mpratyush54/sdk-node';

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

async function startServer() {
  console.log("Initializing CAPS SDK...");
  
  // Disable certificate validation for dev environment if SSL is self-signed/testing
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

  try {
    await caps.init({
      projectName: 'demoproj',
      platformUrl: 'https://148.113.58.205.sslip.io',
      sdkToken: 'caps_sdk_live_1ec8b9aa2d594c2b974f4d346734a6f2',
      environmentName: 'development'
    });
    console.log("CAPS SDK initialized successfully.");
  } catch (err) {
    console.error("Failed to initialize CAPS SDK:", err);
  }

  // Mount CAPS Metrics Middleware to track endpoint durations and status codes
  app.use(caps.expressMiddleware());

  // Test endpoints
  app.get('/api/data', (req, res) => {
    caps.logger.info("Handling request on /api/data endpoint");
    
    // Retrieve configuration from CAPS Config Service if set, otherwise use fallback
    const welcomeMessage = caps.config('WELCOME_MESSAGE') || "Hello from CAPS Platform Backend!";
    
    res.json({
      message: welcomeMessage,
      timestamp: new Date().toISOString(),
      sdkStatus: "active",
      environment: "development"
    });
  });

  app.post('/api/log-test', (req, res) => {
    const { level, message } = req.body;
    if (level === 'error') {
      caps.logger.error(`Test error log: ${message}`, { errorType: 'DemoTestError', stackHash: 'demohash123' });
    } else {
      caps.logger.info(`Test info log: ${message}`);
    }
    res.json({ success: true, message: "Log submitted to CAPS" });
  });

  app.listen(port, () => {
    console.log(`Backend server listening at http://localhost:${port}`);
    caps.logger.info(`Backend server started on port ${port}`);
  });
}

startServer().catch(console.error);
