import { Router } from 'express';
import * as k8s from '@kubernetes/client-node';
import { expressAuthenticate, expressRequireRole } from '../middleware/auth';
import { UserRole } from '../entities/User';
import { loadKubeConfig } from '../lib/kube-config';
import { parseLicenseStatus } from '../lib/license-status';

const router = Router();

export async function readLicenseConfigMap(): Promise<string | null> {
  const kc = new k8s.KubeConfig();
  loadKubeConfig(kc);
  try {
    const cm = await kc.makeApiClient(k8s.CoreV1Api).readNamespacedConfigMap({ namespace: 'platform', name: 'platform-license-status' });
    return cm.data?.['status.json'] ?? null;
  } catch {
    return null;
  }
}

export const deps = { read: readLicenseConfigMap };

router.get('/license', expressAuthenticate, expressRequireRole([UserRole.ADMIN]), async (_req, res) => {
  res.set('Cache-Control', 'no-store');
  return res.json(parseLicenseStatus(await deps.read()));
});

export default router;
