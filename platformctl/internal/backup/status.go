package backup

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// MetricsDir is read by node-exporter's textfile collector (configured in the
// monitoring values), so backup metrics reach Prometheus without a resident
// exporter and even while the API is down.
var MetricsDir = "/var/lib/platform/metrics"

// WriteMetricsFile atomically replaces the textfile for one operation.
func WriteMetricsFile(dir, kind string, s Status) error {
	if kind != "backup" && kind != "restore-test" {
		return fmt.Errorf("invalid backup operation")
	}
	if e := os.MkdirAll(dir, 0755); e != nil {
		return e
	}
	final := filepath.Join(dir, "platform_backup_"+strings.ReplaceAll(kind, "-", "_")+".prom")
	tmp, e := os.CreateTemp(dir, ".platform_backup_*.tmp")
	if e != nil {
		return e
	}
	defer os.Remove(tmp.Name())
	if _, e = tmp.WriteString(Metrics(kind, s)); e != nil {
		tmp.Close()
		return e
	}
	if e = tmp.Chmod(0644); e != nil {
		tmp.Close()
		return e
	}
	if e = tmp.Close(); e != nil {
		return e
	}
	return os.Rename(tmp.Name(), final)
}

type Status struct {
	ID                   string    `json:"id"`
	Success              bool      `json:"success"`
	FinishedAt           time.Time `json:"finishedAt"`
	DurationSeconds      float64   `json:"durationSeconds"`
	Bytes                int64     `json:"bytes"`
	LastSuccessTimestamp int64     `json:"lastSuccessTimestamp"`
}

func Metrics(kind string, s Status) string {
	success := 0
	if s.Success {
		success = 1
	}
	return fmt.Sprintf("platform_backup_success{operation=%q} %d\nplatform_backup_completed_timestamp_seconds{operation=%q} %d\nplatform_backup_last_success_timestamp_seconds{operation=%q} %d\nplatform_backup_size_bytes{operation=%q} %d\nplatform_backup_duration_seconds{operation=%q} %g\n", kind, success, kind, s.FinishedAt.Unix(), kind, s.LastSuccessTimestamp, kind, s.Bytes, kind, s.DurationSeconds)
}

// PublishStatus exposes non-secret state to the API via a ConfigMap. Existing
// portal notifications are inserted with the API pod's DB identity. Neither
// stage sends keys, bucket credentials, SQL errors or object names to users.
func PublishStatus(kind, id string, start time.Time, m Manifest, result error) error {
	s := Status{ID: id, Success: result == nil, FinishedAt: time.Now().UTC(), DurationSeconds: time.Since(start).Seconds()}
	if s.Success {
		s.LastSuccessTimestamp = s.FinishedAt.Unix()
	} else {
		cmd := exec.Command("kubectl", "-n", "platform", "get", "configmap", "platform-backup-"+kind, "-o", "jsonpath={.data.status\\.json}")
		if b, e := cmd.Output(); e == nil {
			var previous Status
			if json.Unmarshal(b, &previous) == nil {
				s.LastSuccessTimestamp = previous.LastSuccessTimestamp
			}
		}
	}
	for _, a := range m.Artifacts {
		s.Bytes += a.Bytes
	}
	// The metrics file is independent of the cluster API: write it first.
	metricsErr := WriteMetricsFile(MetricsDir, kind, s)
	b, e := json.Marshal(s)
	if e != nil {
		return e
	}
	cm := map[string]any{"apiVersion": "v1", "kind": "ConfigMap", "metadata": map[string]string{"name": "platform-backup-" + kind, "namespace": "platform"}, "data": map[string]string{"status.json": string(b), "metrics": Metrics(kind, s)}}
	data, e := json.Marshal(cm)
	if e != nil {
		return e
	}
	cmd := exec.Command("kubectl", "apply", "-f", "-")
	cmd.Stdin = strings.NewReader(string(data))
	if e = cmd.Run(); e != nil && metricsErr == nil {
		metricsErr = fmt.Errorf("status ConfigMap: %w", e)
	}
	if kind != "restore-test" && result == nil {
		return metricsErr
	}
	title := "Backup failed"
	message := "The backup failed. Inspect the platform-backup job logs."
	level := "error"
	if kind == "restore-test" {
		title = "Backup restore test failed"
		message = "The scratch database restore test failed. Inspect the restore-test logs."
		if result == nil {
			title = "Backup restore test passed"
			message = "The Postgres scratch database restore and sanity queries passed."
			level = "success"
		}
	}
	payload, _ := json.Marshal(map[string]string{"title": title, "body": message, "kind": level})
	script := `const {Client}=require('pg');const p=JSON.parse(process.argv[1]);const c=new Client({host:process.env.POSTGRES_HOST,port:Number(process.env.POSTGRES_PORT||5432),user:process.env.POSTGRES_USER,password:process.env.POSTGRES_PASSWORD,database:process.env.POSTGRES_DB});(async()=>{await c.connect();await c.query('INSERT INTO notifications (id,user_id,title,body,kind) SELECT gen_random_uuid(),id,$1,$2,$3 FROM users WHERE role::text IN (\'admin\',\'devops\')',[p.title,p.body,p.kind]);await c.end()})().catch(()=>process.exit(1));`
	cmd = exec.Command("kubectl", "-n", "platform", "exec", "deployment/platform-api", "--", "node", "-e", script, string(payload))
	if e = cmd.Run(); e != nil {
		return fmt.Errorf("portal notification: %w", e)
	}
	return metricsErr
}
