package components

import (
	"bytes"
	"strings"
	"testing"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"
)

func fixedDatastoreCfg(profile string) *config.Config {
	return &config.Config{
		Profile:                profile,
		InstallMonitoring:      true,
		PostgresPassword:       "pg-pass-fixed",
		MongoPassword:          "mongo-pass-fixed",
		RedisPassword:          "redis-pass-fixed",
		MinioAccessKey:         "minioaccess",
		MinioSecretKey:         "miniosecret",
		JWTSecret:              "jwt",
		SecretsEncryptionKey:   "sek",
		WebhookSecret:          "hook",
		TelemetryRetentionDays: "30",
		PlatformName:           "Platform",
		Domain:                 "example.test",
		AdminEmail:             "a@example.test",
	}
}

func TestMongoReplicaSetKey(t *testing.T) {
	k1 := mongoReplicaSetKey("pass-a")
	k2 := mongoReplicaSetKey("pass-a")
	k3 := mongoReplicaSetKey("pass-b")
	if len(k1) != 64 {
		t.Fatalf("length %d", len(k1))
	}
	for _, c := range k1 {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) {
			t.Fatalf("non-hex %q", k1)
		}
	}
	if k1 != k2 {
		t.Fatal("not stable")
	}
	if k1 == k3 {
		t.Fatal("same key for different passwords")
	}
}

func TestMongoHostsAndURI(t *testing.T) {
	nonHA := fixedDatastoreCfg(config.ProfileFull)
	if got := MongoHosts(nonHA); got != "mongodb.databases:27017" {
		t.Fatalf("non-ha hosts: %s", got)
	}
	wantURI := "mongodb://root:mongo-pass-fixed@mongodb.databases:27017/platform?authSource=admin"
	if got := mongoURI(nonHA); got != wantURI {
		t.Fatalf("non-ha uri:\n got %s\nwant %s", got, wantURI)
	}
	ha := fixedDatastoreCfg(config.ProfileHA)
	wantHosts := "mongodb-0.mongodb-headless.databases.svc.cluster.local:27017,mongodb-1.mongodb-headless.databases.svc.cluster.local:27017,mongodb-2.mongodb-headless.databases.svc.cluster.local:27017"
	if got := MongoHosts(ha); got != wantHosts {
		t.Fatalf("ha hosts: %s", got)
	}
	gotURI := mongoURI(ha)
	if !strings.Contains(gotURI, wantHosts) || !strings.Contains(gotURI, "replicaSet=rs0") || !strings.Contains(gotURI, "authSource=admin") {
		t.Fatalf("ha uri: %s", gotURI)
	}
}

func TestMongoHAValues(t *testing.T) {
	r := mongodbRelease(fixedDatastoreCfg(config.ProfileHA))
	v := r.Values
	if v["architecture"] != "replicaset" || v["replicaCount"] != MongoReplicaCount || v["replicaSetName"] != MongoReplicaSetName {
		t.Fatalf("replica set fields: %#v", v)
	}
	if arb := v["arbiter"].(map[string]any); arb["enabled"] != false {
		t.Fatal("arbiter must be off")
	}
	if _, ok := v["updateStrategy"]; ok {
		t.Fatal("Recreate must not be set on ha")
	}
	g := v["global"].(map[string]any)
	if g["defaultStorageClass"] != "longhorn" {
		t.Fatalf("storage class: %v", g["defaultStorageClass"])
	}
	auth := v["auth"].(map[string]string)
	if auth["replicaSetKey"] != mongoReplicaSetKey("mongo-pass-fixed") {
		t.Fatalf("replicaSetKey missing/wrong under auth: %#v", auth)
	}
	if !strings.Contains(r.Restarts, "mongodb-0..2") {
		t.Fatalf("restarts: %s", r.Restarts)
	}
}

func TestRedisHAValuesAndArgs(t *testing.T) {
	r := redisRelease(fixedDatastoreCfg(config.ProfileHA))
	v := r.Values
	if v["architecture"] != "replication" {
		t.Fatal(v["architecture"])
	}
	sent := v["sentinel"].(map[string]any)
	if sent["enabled"] != true || sent["masterSet"] != RedisSentinelMaster || sent["quorum"] != 2 {
		t.Fatalf("sentinel: %#v", sent)
	}
	rep := v["replica"].(map[string]any)
	if rep["replicaCount"] != RedisNodeCount {
		t.Fatalf("replicaCount: %v", rep["replicaCount"])
	}
	for _, a := range r.Args {
		if strings.Contains(a, "replica.replicaCount=1") || strings.Contains(a, "master.persistence.size=5Gi") {
			t.Fatalf("ha must drop standalone args: %v", r.Args)
		}
	}
	if len(r.Args) != 0 {
		t.Fatalf("ha redis args should be empty, got %v", r.Args)
	}
	if RedisSentinelHosts() != "redis-node-0.redis-headless.databases.svc.cluster.local:26379,redis-node-1.redis-headless.databases.svc.cluster.local:26379,redis-node-2.redis-headless.databases.svc.cluster.local:26379" {
		t.Fatal(RedisSentinelHosts())
	}
}

func TestMinioHAValuesAndArgs(t *testing.T) {
	cfg := fixedDatastoreCfg(config.ProfileHA)
	v := minioInstallValues(cfg)
	if v["mode"] != "distributed" {
		t.Fatal(v["mode"])
	}
	sts := v["statefulset"].(map[string]any)
	if sts["replicaCount"] != MinioDrives || sts["drivesPerNode"] != 1 || sts["zones"] != 1 {
		t.Fatalf("statefulset: %#v", sts)
	}
	if MinioDrives != 4 {
		t.Fatal(MinioDrives)
	}
	if p, _ := v["persistence"].(map[string]any); p["storageClass"] != LonghornMinioStorageClass || LonghornMinioStorageClass != "longhorn-minio" {
		t.Fatalf("ha minio drives must use %s, got %#v", LonghornMinioStorageClass, v["persistence"])
	}
	if v["podAntiAffinityPreset"] != "soft" {
		t.Fatalf("ha minio pods must spread across nodes (soft anti-affinity), got %#v", v["podAntiAffinityPreset"])
	}
	nonHA := minioInstallValues(fixedDatastoreCfg(config.ProfileFull))
	if _, ok := nonHA["mode"]; ok {
		t.Fatal("non-ha minio must not set mode")
	}
	if _, ok := nonHA["persistence"]; ok {
		t.Fatal("non-ha minio must keep the default StorageClass")
	}
}

func TestPlatformEnvHAKeys(t *testing.T) {
	full := platformEnvValues(fixedDatastoreCfg(config.ProfileFull))
	if _, ok := full["REDIS_SENTINEL_HOSTS"]; ok {
		t.Fatal("full must not have sentinel keys")
	}
	if _, ok := full["REDIS_SENTINEL_MASTER"]; ok {
		t.Fatal("full must not have sentinel master")
	}
	if full["REDIS_HOST"] != "redis-master.databases" {
		t.Fatal(full["REDIS_HOST"])
	}
	ha := platformEnvValues(fixedDatastoreCfg(config.ProfileHA))
	if ha["REDIS_SENTINEL_HOSTS"] != RedisSentinelHosts() || ha["REDIS_SENTINEL_MASTER"] != RedisSentinelMaster {
		t.Fatalf("%v / %v", ha["REDIS_SENTINEL_HOSTS"], ha["REDIS_SENTINEL_MASTER"])
	}
	if ha["REDIS_HOST"] != "redis-master.databases" {
		t.Fatal("compat REDIS_HOST must remain")
	}
}

func TestNonHAFingerprintsUnchanged(t *testing.T) {
	// Golden fingerprints computed from pre-change mongodbRelease/redisRelease
	// with fixedDatastoreCfg passwords (InstallMonitoring true).
	want := map[string]struct{ mongo, redis string }{
		"minimal":  {"8d0d0a26864fa9c4", "cdcc5f1fde013ab8"},
		"standard": {"8d0d0a26864fa9c4", "cdcc5f1fde013ab8"},
		"full":     {"f5be99e6cae9f1f6", "2590bf845f717beb"},
		"":         {"8d0d0a26864fa9c4", "cdcc5f1fde013ab8"},
	}
	for profile, fp := range want {
		cfg := fixedDatastoreCfg(profile)
		if got := mongodbRelease(cfg).Fingerprint(); got != fp.mongo {
			t.Errorf("profile %q mongo fingerprint %s want %s", profile, got, fp.mongo)
		}
		if got := redisRelease(cfg).Fingerprint(); got != fp.redis {
			t.Errorf("profile %q redis fingerprint %s want %s", profile, got, fp.redis)
		}
		if _, ok := mongodbRelease(cfg).Values["architecture"]; ok {
			t.Errorf("non-ha mongo architecture set for %q", profile)
		}
		args := redisRelease(cfg).Args
		if len(args) != 4 || args[1] != "master.persistence.size=5Gi" || args[3] != "replica.replicaCount=1" {
			t.Errorf("non-ha redis args changed for %q: %v", profile, args)
		}
	}
}

func TestCheckHAMigration(t *testing.T) {
	var calls []string
	old := kubeObjectExists
	t.Cleanup(func() { kubeObjectExists = old })
	kubeObjectExists = func(ns, kind, name string) (bool, error) {
		calls = append(calls, ns+"/"+kind+"/"+name)
		return false, nil
	}
	if err := checkHAMigration(fixedDatastoreCfg(config.ProfileFull), "mongodb"); err != nil {
		t.Fatal(err)
	}
	if len(calls) != 0 {
		t.Fatalf("non-ha must not call kubeObjectExists: %v", calls)
	}

	kubeObjectExists = func(ns, kind, name string) (bool, error) {
		calls = append(calls, ns+"/"+kind+"/"+name)
		return true, nil
	}
	calls = nil
	for _, c := range []string{"mongodb", "redis", "minio"} {
		err := checkHAMigration(fixedDatastoreCfg(config.ProfileHA), c)
		if err == nil || !strings.Contains(err.Error(), "docs/operations/ha.md#migrating-an-existing-single-node-install") {
			t.Fatalf("%s: want migration doc error, got %v", c, err)
		}
	}
	if len(calls) != 3 {
		t.Fatalf("calls: %v", calls)
	}

	kubeObjectExists = func(ns, kind, name string) (bool, error) { return false, nil }
	for _, c := range []string{"mongodb", "redis", "minio"} {
		if err := checkHAMigration(fixedDatastoreCfg(config.ProfileHA), c); err != nil {
			t.Fatalf("absent object: %v", err)
		}
	}
}

func TestParseMongoHelloAndSentinelMaster(t *testing.T) {
	primary, hosts, setName, err := parseMongoHello(`{"primary":"mongodb-0.mongodb-headless.databases.svc.cluster.local:27017","hosts":["mongodb-0.mongodb-headless.databases.svc.cluster.local:27017","mongodb-1.mongodb-headless.databases.svc.cluster.local:27017","mongodb-2.mongodb-headless.databases.svc.cluster.local:27017"],"setName":"rs0"}`)
	if err != nil || primary == "" || len(hosts) != 3 || setName != "rs0" {
		t.Fatalf("%v %v %v %v", primary, hosts, setName, err)
	}
	if _, _, _, err := parseMongoHello("not-json"); err == nil {
		t.Fatal("accepted bad json")
	}
	master, err := parseSentinelMaster("10.0.0.5\n6379\n")
	if err != nil || master != "10.0.0.5:6379" {
		t.Fatalf("%q %v", master, err)
	}
	if _, err := parseSentinelMaster("only-one-line"); err == nil {
		t.Fatal("accepted single line")
	}
}

func TestWriteHADatastoreStatus(t *testing.T) {
	var buf bytes.Buffer
	writeHADatastoreStatus(&buf, "MongoDB replica set rs0: primary h, members 3/3", "Redis Sentinel mymaster: master 10.0.0.1:6379", "MinIO distributed: 4/4 pods ready")
	got := buf.String()
	for _, want := range []string{"MongoDB replica set rs0", "Redis Sentinel mymaster", "MinIO distributed: 4/4"} {
		if !strings.Contains(got, want) {
			t.Fatalf("missing %q in %s", want, got)
		}
	}
}
