package components

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os/exec"
	"strconv"
	"strings"

	"github.com/fatih/color"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/shell"
)

// MongoDB replica-set constants (ha profile, #52).
const (
	MongoReplicaSetName = "rs0"
	MongoReplicaCount   = 3
)

// Redis Sentinel constants (ha profile, #52).
const (
	RedisSentinelMaster = "mymaster"
	RedisSentinelPort   = 26379
	RedisNodeCount      = 3
)

// MinIO distributed drive count (ha profile, #52).
const MinioDrives = 4

// mongoReplicaSetKey derives a deterministic 64-char hex keyfile from the Mongo
// root password so the replica set needs no extra Secret.
func mongoReplicaSetKey(password string) string {
	sum := sha256.Sum256([]byte("platform-mongo-replica-set-key-v1\x00" + password))
	return hex.EncodeToString(sum[:])
}

// MongoHosts returns the MongoDB connection host list for the profile.
func MongoHosts(cfg *config.Config) string {
	if cfg != nil && cfg.IsHA() {
		var hosts []string
		for i := 0; i < MongoReplicaCount; i++ {
			hosts = append(hosts, fmt.Sprintf("mongodb-%d.mongodb-headless.databases.svc.cluster.local:27017", i))
		}
		return strings.Join(hosts, ",")
	}
	return "mongodb.databases:27017"
}

// RedisSentinelHosts lists every Sentinel by its stable pod name. Listing the
// pods (not the load-balanced redis Service) lets the API reach each sentinel
// directly, e.g. to keep the discovery ACL user on all of them.
func RedisSentinelHosts() string {
	hosts := make([]string, 0, RedisNodeCount)
	for i := 0; i < RedisNodeCount; i++ {
		hosts = append(hosts, fmt.Sprintf("redis-node-%d.redis-headless.databases.svc.cluster.local:%d", i, RedisSentinelPort))
	}
	return strings.Join(hosts, ",")
}

// kubeObjectExists reports whether a namespaced object is present.
// Overridable in tests.
var kubeObjectExists = func(ns, kind, name string) (bool, error) {
	cmd := exec.Command("kubectl", "-n", ns, "get", kind, name, "-o", "name")
	out, err := cmd.CombinedOutput()
	if err != nil {
		msg := string(out) + err.Error()
		if strings.Contains(msg, "NotFound") || strings.Contains(msg, "not found") {
			return false, nil
		}
		return false, fmt.Errorf("kubectl get %s/%s -n %s: %w: %s", kind, name, ns, err, strings.TrimSpace(string(out)))
	}
	return true, nil
}

// checkHAMigration refuses an in-place switch from standalone datastores to HA topology.
func checkHAMigration(cfg *config.Config, component string) error {
	if cfg == nil || !cfg.IsHA() {
		return nil
	}
	var ns, kind, name, msg string
	switch component {
	case "mongodb":
		ns, kind, name = "databases", "deployment", "mongodb"
		msg = "MongoDB is installed as a single standalone instance; the ha profile runs a 3-member replica set on new volumes and cannot convert it in place. Migrate with a backup and restore: docs/operations/ha.md#migrating-an-existing-single-node-install"
	case "redis":
		ns, kind, name = "databases", "statefulset", "redis-master"
		msg = "Redis is installed as a single standalone instance; the ha profile runs Sentinel on new volumes and cannot convert it in place. Migrate with a backup and restore: docs/operations/ha.md#migrating-an-existing-single-node-install"
	case "minio":
		ns, kind, name = "storage", "deployment", "minio"
		msg = "MinIO is installed as a single standalone instance; the ha profile runs distributed (4 drives) on new volumes and cannot convert it in place. Migrate with a backup and restore: docs/operations/ha.md#migrating-an-existing-single-node-install"
	default:
		return fmt.Errorf("unknown HA migration component %q", component)
	}
	exists, err := kubeObjectExists(ns, kind, name)
	if err != nil {
		return err
	}
	if exists {
		return fmt.Errorf("%s", msg)
	}
	return nil
}

// parseMongoHello extracts primary, hosts and set name from db.hello() JSON.
func parseMongoHello(out string) (primary string, hosts []string, setName string, err error) {
	out = strings.TrimSpace(out)
	if out == "" {
		return "", nil, "", fmt.Errorf("empty mongo hello output")
	}
	var doc struct {
		Primary string   `json:"primary"`
		Hosts   []string `json:"hosts"`
		SetName string   `json:"setName"`
	}
	if err := json.Unmarshal([]byte(out), &doc); err != nil {
		return "", nil, "", fmt.Errorf("parse mongo hello: %w", err)
	}
	return doc.Primary, doc.Hosts, doc.SetName, nil
}

// parseSentinelMaster parses SENTINEL get-master-addr-by-name output (host\nport).
func parseSentinelMaster(out string) (string, error) {
	lines := strings.Split(strings.TrimSpace(out), "\n")
	if len(lines) < 2 {
		return "", fmt.Errorf("sentinel master output needs host and port lines")
	}
	host, port := strings.TrimSpace(lines[0]), strings.TrimSpace(lines[1])
	if host == "" || port == "" {
		return "", fmt.Errorf("sentinel master host/port empty")
	}
	return host + ":" + port, nil
}

// writeHADatastoreStatus formats HA datastore status lines (pure).
func writeHADatastoreStatus(w io.Writer, mongoLine, redisLine, minioLine string, warn ...string) {
	if mongoLine != "" {
		fmt.Fprintf(w, "  %s\n", mongoLine)
	}
	if redisLine != "" {
		fmt.Fprintf(w, "  %s\n", redisLine)
	}
	if minioLine != "" {
		fmt.Fprintf(w, "  %s\n", minioLine)
	}
	for _, m := range warn {
		if m != "" {
			fmt.Fprintf(w, "  %s\n", m)
		}
	}
}

// parseReadyOfWant parses "<ready>/<want>" from a StatefulSet jsonpath; an
// empty ready count (no pod ready yet) is 0.
func parseReadyOfWant(out string) (ready, want int, err error) {
	r, w, ok := strings.Cut(strings.TrimSpace(out), "/")
	if !ok {
		return 0, 0, fmt.Errorf("unexpected StatefulSet status %q", strings.TrimSpace(out))
	}
	if strings.TrimSpace(r) != "" {
		if ready, err = strconv.Atoi(strings.TrimSpace(r)); err != nil {
			return 0, 0, fmt.Errorf("unexpected ready count %q", r)
		}
	}
	if want, err = strconv.Atoi(strings.TrimSpace(w)); err != nil {
		return 0, 0, fmt.Errorf("unexpected replica count %q", w)
	}
	return ready, want, nil
}

// mongoStatusLine formats the MongoDB replica set line. ready and want are
// the StatefulSet's ready and desired pods (ready < 0: unknown). db.hello()
// lists the configured members whether or not they run, so it cannot tell
// how many are healthy; the ready pods can. An empty primary means the set
// accepts no writes. ok is false when the line must be shown as a problem.
func mongoStatusLine(setName, primary string, ready, want int) (line string, ok bool) {
	if setName == "" {
		setName = MongoReplicaSetName
	}
	members := fmt.Sprintf("%d/%d members ready", ready, want)
	if ready < 0 {
		members = "ready members unknown"
	}
	if strings.TrimSpace(primary) == "" {
		return fmt.Sprintf("✗ MongoDB replica set %s: NO PRIMARY (writes fail), %s", setName, members), false
	}
	if ready < 0 || ready < want {
		return fmt.Sprintf("⚠ MongoDB replica set %s: primary %s, %s", setName, primary, members), false
	}
	return fmt.Sprintf("MongoDB replica set %s: primary %s, %s", setName, primary, members), true
}

// PrintHADatastoreStatus prints Mongo/Redis/MinIO HA status; failures are warnings only.
func PrintHADatastoreStatus(w io.Writer, cfg *config.Config) {
	var mongoLine, redisLine, minioLine string
	var warnings []string

	ready, want := -1, MongoReplicaCount
	if out, err := shell.Output("kubectl", "-n", "databases", "get", "sts", "mongodb",
		"-o", "jsonpath={.status.readyReplicas}/{.spec.replicas}"); err == nil {
		if r, n, perr := parseReadyOfWant(out); perr == nil {
			ready, want = r, n
		}
	}
	if out, err := execFirstMember("mongodb", MongoReplicaCount, "mongodb", "mongosh", "--quiet", "--eval", "JSON.stringify(db.hello())"); err != nil {
		warnings = append(warnings, color.RedString("✗ MongoDB replica set status unavailable (%d/%d members ready): %v", max(ready, 0), want, err))
	} else if primary, _, setName, err := parseMongoHello(out); err != nil {
		warnings = append(warnings, color.YellowString("⚠ MongoDB replica set status unavailable: %v", err))
	} else {
		line, ok := mongoStatusLine(setName, primary, ready, want)
		switch {
		case ok:
			mongoLine = line
		case strings.HasPrefix(line, "✗"):
			mongoLine = color.RedString("%s", line)
		default:
			mongoLine = color.YellowString("%s", line)
		}
	}

	sentinelEval := `pw() { local v="${!1:-}" f="${1}_FILE"; if [ -z "$v" ] && [ -n "${!f:-}" ]; then v=$(cat "${!f}"); fi; printf "%s" "$v"; }; export REDISCLI_AUTH="$(pw REDIS_PASSWORD)"; redis-cli -p 26379 SENTINEL get-master-addr-by-name mymaster`
	if out, err := execFirstMember("redis-node", RedisNodeCount, "sentinel", "bash", "-ec", sentinelEval); err != nil {
		warnings = append(warnings, color.YellowString("⚠ Redis Sentinel status unavailable: %v", err))
	} else if master, err := parseSentinelMaster(out); err != nil {
		warnings = append(warnings, color.YellowString("⚠ Redis Sentinel status unavailable: %v", err))
	} else {
		redisLine = fmt.Sprintf("Redis Sentinel %s: master %s", RedisSentinelMaster, master)
	}

	if cfg.ObjectStorageExternal() {
		minioLine = "Object storage: external (" + cfg.ObjectStorage.Endpoint + ")"
	} else {
		out, err := shell.Output("kubectl", "-n", "storage", "get", "sts", "minio",
			"-o", "jsonpath={.status.readyReplicas}/{.spec.replicas}")
		line, warn := minioStatusLine(out, err)
		if warn != "" {
			warnings = append(warnings, color.YellowString("%s", warn))
		}
		minioLine = line
	}

	writeHADatastoreStatus(w, mongoLine, redisLine, minioLine, warnings...)
}

// execFirstMember runs a command in the first member (<prefix>-0..n-1) that
// answers. Status used to ask member 0 only and reported the replica set or
// Sentinel as unavailable whenever that one pod was down (3-node test).
// Overridable in tests.
var execFirstMember = func(prefix string, n int, container string, cmd ...string) (string, error) {
	var lastErr error
	for i := 0; i < n; i++ {
		args := append([]string{"-n", "databases", "exec", fmt.Sprintf("%s-%d", prefix, i), "-c", container, "--request-timeout=10s", "--"}, cmd...)
		out, err := shell.Output("kubectl", args...)
		if err == nil {
			return out, nil
		}
		lastErr = err
	}
	return "", lastErr
}

// minioStatusLine formats the MinIO line from `kubectl get sts minio`. A
// missing StatefulSet means the cluster uses external object storage: joined
// servers do not have the first server's OBJECT_STORAGE_* settings.
func minioStatusLine(out string, err error) (line, warn string) {
	if err != nil {
		if strings.Contains(out, "NotFound") || strings.Contains(err.Error(), "NotFound") {
			return "Object storage: no bundled MinIO in this cluster (external object storage)", ""
		}
		return "", fmt.Sprintf("⚠ MinIO distributed status unavailable: %v", err)
	}
	return fmt.Sprintf("MinIO distributed: %s pods ready", strings.TrimSpace(out)), ""
}
