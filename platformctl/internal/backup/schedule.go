package backup

import _ "embed"

// AlertsYAML is a PrometheusRule for kube-prometheus-stack (release label
// "kube-prometheus"); it is applied by `backup schedule` only when the
// monitoring CRDs exist, so minimal installs stay unaffected.
//
//go:embed alerts.yaml
var AlertsYAML string

// Opt-in: no additional controller, operator, or always-running service. This
// host maintenance job needs root to snapshot k3s and read installer credentials.
const ScheduleYAML = `apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: platform-backup-low
value: -1000
globalDefault: false
description: Low priority platform maintenance
---
apiVersion: batch/v1
kind: CronJob
metadata:
  name: platform-backup-nightly
  namespace: platform
spec:
  schedule: "15 2 * * *"
  timeZone: Etc/UTC
  concurrencyPolicy: Forbid
  startingDeadlineSeconds: 3600
  successfulJobsHistoryLimit: 1
  failedJobsHistoryLimit: 3
  jobTemplate:
    spec:
      backoffLimit: 0
      activeDeadlineSeconds: 14400
      template:
        spec:
          hostPID: true
          nodeSelector:
            node-role.kubernetes.io/control-plane: "true"
          priorityClassName: platform-backup-low
          restartPolicy: Never
          automountServiceAccountToken: false
          containers:
            - name: backup
              image: ubuntu:24.04
              securityContext:
                privileged: true
                runAsUser: 0
              command: ["nsenter", "-t", "1", "-m", "-u", "-i", "-n", "--root", "--wd", "--", "nice", "-n", "19", "ionice", "-c", "3", "/usr/local/bin/platformctl", "backup", "--all"]
              resources:
                requests:
                  cpu: 50m
                  memory: 64Mi
                limits:
                  cpu: "1"
                  memory: 512Mi
`
