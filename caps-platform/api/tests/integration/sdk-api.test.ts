// Mock ESM modules before any imports
jest.mock('@kubernetes/client-node', () => ({
  KubeConfig: class {
    loadFromDefault() {}
    makeApiClient() {
      return {};
    }
  },
  CustomObjectsApi: class {}
}));

jest.mock('../../src/lib/k8s', () => ({
  checkK8sConnection: jest.fn().mockResolvedValue(true),
  getK8sNodes: jest.fn().mockResolvedValue([]),
  getK8sNamespaces: jest.fn().mockResolvedValue([]),
  getK8sPods: jest.fn().mockResolvedValue([]),
  getPodLogs: jest.fn().mockResolvedValue(''),
  deletePod: jest.fn().mockResolvedValue(true),
  updateArgoCDApp: jest.fn().mockResolvedValue(true),
}));

// MOCK DATABASE & MONGO CONNECTIONS
const mockProject = {
  id: 'p1111111-1111-1111-1111-111111111111',
  name: 'test-project',
  stack: 'nodejs'
};

const mockEnvironment = {
  id: 'e1111111-1111-1111-1111-111111111111',
  name: 'development',
  namespace: 'test-project-development',
  domain: 'test-project-development.example.com',
  projectId: 'p1111111-1111-1111-1111-111111111111'
};

const mockServiceRegistration = {
  id: 'r1111111-1111-1111-1111-111111111111',
  projectId: 'p1111111-1111-1111-1111-111111111111',
  environmentId: 'e1111111-1111-1111-1111-111111111111',
  serviceName: 'test-project',
};

const mockProjectRepository = {
  findOne: jest.fn().mockResolvedValue(mockProject),
  create: jest.fn().mockImplementation((data) => ({ id: 'p1111111-1111-1111-1111-111111111111', ...data })),
  save: jest.fn().mockImplementation((data) => Promise.resolve(data)),
};

const mockEnvironmentRepository = {
  findOne: jest.fn().mockResolvedValue(mockEnvironment),
  create: jest.fn().mockImplementation((data) => ({ id: 'e1111111-1111-1111-1111-111111111111', ...data })),
  save: jest.fn().mockImplementation((data) => Promise.resolve(data)),
};

const mockServiceRegistrationRepository = {
  findOne: jest.fn().mockResolvedValue(mockServiceRegistration),
  create: jest.fn().mockImplementation((data) => ({ id: 'r1111111-1111-1111-1111-111111111111', ...data })),
  save: jest.fn().mockImplementation((data) => Promise.resolve(data)),
  saveHeartbeat: jest.fn().mockResolvedValue(true),
};

const mockAuditLogRepository = {
  create: jest.fn().mockImplementation((data) => data),
  save: jest.fn().mockImplementation((data) => Promise.resolve(data)),
};

const mockSdkCredentialRepository = {
  findOne: jest.fn().mockResolvedValue({
    id: 'c1111111-1111-1111-1111-111111111111',
    token: 'caps_sdk_live_testtoken12345',
    projectId: 'p1111111-1111-1111-1111-111111111111',
    status: 'active'
  }),
};

const mockDbConnectionRepository = {
  findOne: jest.fn().mockResolvedValue(null),
  create: jest.fn().mockImplementation((data) => ({ id: 'db-conn-1', ...data })),
  save: jest.fn().mockImplementation((data) => Promise.resolve(data)),
};

const mockDataSource = {
  getRepository: jest.fn().mockImplementation((entity) => {
    const name = typeof entity === 'string' ? entity : entity.name;
    if (name === 'Project') return mockProjectRepository;
    if (name === 'Environment') return mockEnvironmentRepository;
    if (name === 'ServiceRegistration') return mockServiceRegistrationRepository;
    if (name === 'AuditLog') return mockAuditLogRepository;
    if (name === 'SdkCredential') return mockSdkCredentialRepository;
    if (name === 'DbConnection') return mockDbConnectionRepository;
    return {};
  }),
};

jest.mock('../../src/config/database', () => ({
  getDb: jest.fn().mockImplementation(() => Promise.resolve(mockDataSource)),
}));

jest.mock('../../src/config/mongoose', () => ({
  connectMongo: jest.fn().mockResolvedValue(true),
}));

jest.mock('../../src/lib/lokilog', () => ({
  forwardToLoki: jest.fn().mockResolvedValue(true),
}));

// Mock MongoDB Models
const mockInsertMany = jest.fn().mockResolvedValue([]);
const mockFindOneAndUpdate = jest.fn().mockResolvedValue({});
const mockCreate = jest.fn().mockResolvedValue({ _id: 'mock-id' });

jest.mock('../../src/schemas/Log', () => ({
  LogModel: {
    insertMany: (...args: any[]) => mockInsertMany(...args),
  }
}));

jest.mock('../../src/schemas/ApiMetric', () => ({
  ApiMetricModel: {
    insertMany: (...args: any[]) => mockInsertMany(...args),
  }
}));

jest.mock('../../src/schemas/BugReport', () => ({
  BugReportModel: {
    create: (...args: any[]) => mockCreate(...args),
  }
}));

jest.mock('../../src/schemas/ErrorDoc', () => ({
  ErrorDocModel: {
    findOneAndUpdate: (...args: any[]) => mockFindOneAndUpdate(...args),
  }
}));

jest.mock('../../src/schemas/SdkEvent', () => ({
  SdkEventModel: {
    create: (...args: any[]) => mockCreate(...args),
  }
}));

jest.mock('../../src/schemas/MetricsRaw', () => ({
  MetricsRawModel: {
    insertMany: (...args: any[]) => mockInsertMany(...args),
  }
}));

jest.mock('../../src/schemas/FeatureFlag', () => ({
  FeatureFlagModel: {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
  }
}));

import express from 'express';
import { Server } from 'http';
import apiRouter from '../../src/routes/api';
import { CapsClient } from '../../../../caps-sdk-node/src/client';

describe('SDK & API Integration Tests', () => {
  let app: express.Express;
  let server: Server;
  let port: number;
  let sdk: CapsClient;

  beforeAll((done) => {
    app = express();
    app.use(express.json());
    app.use('/api', apiRouter);

    // Boot real HTTP server on random port
    server = app.listen(0, () => {
      const address: any = server.address();
      port = address.port;
      done();
    });
  });

  afterAll((done) => {
    if (sdk) {
      sdk.shutdown().then(() => {
        server.close(done);
      });
    } else {
      server.close(done);
    }
  });

  beforeEach(() => {
    jest.clearAllMocks();
    sdk = new CapsClient();
  });

  it('should register SDK client, send logs, track metrics, and submit bug report via API', async () => {
    // 1. Initialize the actual Node SDK pointing to our live test server
    const platformUrl = `http://localhost:${port}`;
    const token = 'sdk-p1111111-1111-1111-1111-111111111111:dummy-secret';
    
    await sdk.init({
      projectName: 'test-project',
      environmentName: 'development',
      platformUrl,
      sdkToken: token,
      databases: [],
    });

    // Verify registration was triggered
    expect(mockProjectRepository.findOne).toHaveBeenCalledWith(expect.objectContaining({
      where: { name: 'test-project' }
    }));

    // 2. Test Logging Ingest
    sdk.logger.info('Hello integration test message from Node SDK');
    sdk.logger.error('Test error message for ErrorDoc collection', { errorType: 'TestException', stackHash: 'hash123' });
    
    // Manually trigger flush to avoid waiting for interval
    await (sdk.logger as any).flush();

    expect(mockInsertMany).toHaveBeenCalled();
    const loggedEntries = mockInsertMany.mock.calls[0][0];
    expect(loggedEntries[0].message).toContain('Hello integration test message');
    expect(loggedEntries[1].level).toBe('ERROR');

    // Verify ErrorDoc creation was triggered by ERROR log
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ errorType: 'TestException', stackHash: 'hash123' }),
      expect.any(Object),
      expect.any(Object)
    );

    // 3. Test API Metrics Ingest via Express Middleware
    const middleware = sdk.expressMiddleware();
    const req: any = { path: '/api/v1/users/12345', method: 'GET' };
    const res: any = {
      statusCode: 200,
      on: jest.fn().mockImplementation((event, callback) => {
        if (event === 'finish') {
          // Trigger finish immediately to simulate response finish
          callback();
        }
      })
    };
    const next = jest.fn();

    middleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.on).toHaveBeenCalledWith('finish', expect.any(Function));

    // Manually flush metrics buffer
    await (sdk.metrics as any).flush();

    expect(mockInsertMany).toHaveBeenCalledTimes(2); // Ingest logs then metrics
    const metricsEntries = mockInsertMany.mock.calls[1][0];
    expect(metricsEntries[0].route).toBe('/api/v1/users/:id'); // normalized route
    expect(metricsEntries[0].method).toBe('GET');

    // 4. Test Bug Reporting
    const bugReportPayload = {
      projectId: 'p1111111-1111-1111-1111-111111111111',
      environment: 'development',
      description: 'The app crashed on clicking login button',
      category: 'UI Bug',
      consoleLogs: ['[ERROR] Failed to load resource'],
      browserInfo: { userAgent: 'Chrome' },
    };

    const resBug = await (sdk as any).http.post('/api/sdk/bug-report', bugReportPayload);
    expect(resBug.status).toBe(201);
    expect(resBug.data.id).toBe('mock-id');
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'p1111111-1111-1111-1111-111111111111',
      description: 'The app crashed on clicking login button'
    }));
  });
});
