import { AlertChannel } from './AlertChannel';
import { AlertMonitor } from './AlertMonitor';
import { AlertSlo } from './AlertSlo';
import { AlertSilence } from './AlertSilence';
import { AlertEscalationPolicy } from './AlertEscalationPolicy';
import { AlertOncallSchedule } from './AlertOncallSchedule';
import { AlertIncident } from './AlertIncident';
import { AlertDelivery } from './AlertDelivery';

/** Alerting and on-call entities (#43), registered in config/database.ts. */
export const ALERTING_ENTITIES = [
  AlertChannel, AlertMonitor, AlertSlo, AlertSilence, AlertEscalationPolicy, AlertOncallSchedule, AlertIncident, AlertDelivery,
];
