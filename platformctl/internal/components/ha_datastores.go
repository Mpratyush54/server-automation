package components

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os/exec"
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

// PrintHADatastoreStatus prints Mongo/Redis/MinIO HA status; failures are warnings only.
func PrintHADatastoreStatus(w io.Writer) {
	var mongoLine, redisLine, minioLine string
	var warnings []string

	if out, err := shell.Output("kubectl", "-n", "databases", "exec", "mongodb-0", "-c", "mongodb", "--",
		"mongosh", "--quiet", "--eval", "JSON.stringify(db.hello())"); err != nil {
		warnings = append(warnings, color.YellowString("⚠ MongoDB replica set status unavailable: %v", err))
	} else if primary, hosts, setName, err := parseMongoHello(out); err != nil {
		warnings = append(warnings, color.YellowString("⚠ MongoDB replica set status unavailable: %v", err))
	} else {
		if setName == "" {
			setName = MongoReplicaSetName
		}
		mongoLine = fmt.Sprintf("MongoDB replica set %s: primary %s, members %d/%d", setName, primary, len(hosts), MongoReplicaCount)
	}

	sentinelEval := `pw() { local v="${!1:-}" f="${1}_FILE"; if [ -z "$v" ] && [ -n "${!f:-}" ]; then v=$(cat "${!f}"); fi; printf "%s" "$v"; }; export REDISCLI_AUTH="$(pw REDIS_PASSWORD)"; redis-cli -p 26379 SENTINEL get-master-addr-by-name mymaster`
	if out, err := shell.Output("kubectl", "-n", "databases", "exec", "redis-node-0", "-c", "sentinel", "--",
		"bash", "-ec", sentinelEval); err != nil {
		warnings = append(warnings, color.YellowString("⚠ Redis Sentinel status unavailable: %v", err))
	} else if master, err := parseSentinelMaster(out); err != nil {
		warnings = append(warnings, color.YellowString("⚠ Redis Sentinel status unavailable: %v", err))
	} else {
		redisLine = fmt.Sprintf("Redis Sentinel %s: master %s", RedisSentinelMaster, master)
	}

	if out, err := shell.Output("kubectl", "-n", "storage", "get", "sts", "minio",
		"-o", "jsonpath={.status.readyReplicas}/{.spec.replicas}"); err != nil {
		warnings = append(warnings, color.YellowString("⚠ MinIO distributed status unavailable: %v", err))
	} else {
		minioLine = fmt.Sprintf("MinIO distributed: %s pods ready", strings.TrimSpace(out))
	}

	writeHADatastoreStatus(w, mongoLine, redisLine, minioLine, warnings...)
}
