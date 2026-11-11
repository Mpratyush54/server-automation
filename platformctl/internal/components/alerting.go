package components

// alertingRBACManifest grants the platform API what full-profile alerting (#43)
// needs in the monitoring namespace: per-project PrometheusRule and
// AlertmanagerConfig objects (routing alerts by the `project` label back to
// the API receiver) and the receiver's bearer-token Secret. Channel secrets
// (Slack, PagerDuty, ...) stay encrypted in the API database and are never
// written to Alertmanager. It also lets the API update Loki's runtime overrides
// ConfigMap (loki-runtime) with per-project logs retention (#47); nothing else
// in the namespace is writable. Applied by InstallTelemetry (full profile only),
// so standard/minimal installs are unchanged.
const alertingRBACManifest = "alerting-rbac.yaml"
