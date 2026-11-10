/** Async preload: the application bootstrap MUST await ready before importing frameworks/drivers. */
import platform from './index';

export const ready = platform.init({
  projectName: process.env.PLATFORM_PROJECT_NAME || process.env.PROJECT_NAME || 'app',
  environmentName: process.env.PLATFORM_ENVIRONMENT || process.env.ENVIRONMENT_NAME || 'development',
  platformUrl: process.env.PLATFORM_URL || '',
  version: process.env.APP_VERSION,
  commitSha: process.env.GIT_SHA,
});
