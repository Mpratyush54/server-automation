import { Router } from 'express';
import { fetchRepoReleases, parseGitRemote } from '../lib/git-remote';

const router = Router();

router.get('/platform/version', async (_req, res) => {
  const defaultTag = 'latest';
  const current = process.env.PLATFORM_IMAGE_TAG || defaultTag;
  const repository = 'https://github.com/Mpratyush54/SERVER-automation';
  let latestRelease: any = null;
  let updateAvailable = false;
  try {
    const releases = await fetchRepoReleases(repository, 5);
    latestRelease = releases.find((r) => !r.prerelease) || releases[0] || null;
    if (latestRelease?.tag && current && current !== 'latest') {
      const a = String(latestRelease.tag).replace(/^v/, '');
      const b = String(current).replace(/^v/, '');
      updateAvailable = a !== b;
    } else if (latestRelease?.tag && current === 'latest') {
      updateAvailable = true;
    }
  } catch {
    // non-blocking — GitHub may be rate-limited without token
  }

  res.json({
    platformVersion: current,
    imageTag: current,
    apiVersion: '1.0.0',
    nodeEnv: process.env.NODE_ENV || 'development',
    repository,
    releases: `${repository}/releases`,
    latestRelease,
    updateAvailable,
    parsed: parseGitRemote(repository),
  });
});

export default router;
