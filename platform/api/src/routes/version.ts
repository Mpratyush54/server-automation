import { Router } from 'express';
const router = Router();

router.get('/platform/version', (_req, res) => {
  const defaultTag = 'latest';
  res.json({
    platformVersion: process.env.PLATFORM_IMAGE_TAG || defaultTag,
    imageTag: process.env.PLATFORM_IMAGE_TAG || defaultTag,
    apiVersion: '1.0.0',
    nodeEnv: process.env.NODE_ENV || 'development',
    repository: 'https://github.com/Mpratyush54/SERVER-automation',
    releases: 'https://github.com/Mpratyush54/SERVER-automation/releases',
  });
});

export default router;
