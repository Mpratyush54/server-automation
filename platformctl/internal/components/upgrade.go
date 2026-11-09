package components

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/shell"
)

// ResolveUpgradeImages uses the same authenticated resolver and local-image
// fallback as update, without migrating or mutating Deployments.
func ResolveUpgradeImages(cfg *config.Config) (string, string, error) {
	api := fmt.Sprintf("%s/platform-api:%s", cfg.ImageRegistry, cfg.ImageTag)
	portal := fmt.Sprintf("%s/platform-portal:%s", cfg.ImageRegistry, cfg.ImageTag)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	c := exec.CommandContext(ctx, "bash", "-c", upgradeResolveScript())
	c.Env = append(os.Environ(), "API="+api, "PORTAL="+portal, "REGISTRY_USERNAME=platformctl", "REGISTRY_PASSWORD="+cfg.GitHubToken, "ALLOW_LOCAL_IMAGES=false")
	if imagePresentLocally(api) && imagePresentLocally(portal) {
		c.Env = append(c.Env, "ALLOW_LOCAL_IMAGES=true")
	}
	var out bytes.Buffer
	c.Stdout = &out
	c.Stderr = os.Stderr
	e := c.Run()
	if e != nil {
		return "", "", e
	}
	lines := strings.Fields(out.String())
	if len(lines) != 2 {
		return "", "", fmt.Errorf("unexpected digest resolver output")
	}
	return lines[0], lines[1], nil
}

func upgradeResolveScript() string {
	return strings.Split(digestUpdateScript, "API=\"$(resolve_image")[0] + "resolve_image \"$API\"; printf '\\n'; resolve_image \"$PORTAL\"; printf '\\n'\n"
}

// RestoreUpgradeDatabase restores only the local pre-migration platform dump.
// The caller must explicitly obtain consent and quiesce API writers first.
func RestoreUpgradeDatabase(cfg *config.Config, dump string) error {
	return shell.RunBashEnv(upgradeRestoreScript, map[string]string{"DUMP": dump, "PGPW": cfg.PostgresPassword})
}

const upgradeRestoreScript = `set -euo pipefail
[[ -s "$DUMP" ]] || { echo 'recorded database dump is missing or empty' >&2; exit 1; }
PG_POD="$(kubectl -n databases get pod -l app.kubernetes.io/name=postgresql -o jsonpath='{.items[0].metadata.name}')"
[[ -n "$PG_POD" ]]
# Password and archive travel over stdin, never as command arguments.
{ printf '%s\n' "$PGPW"; cat "$DUMP"; } | kubectl -n databases exec -i "$PG_POD" -- bash -ec 'read -r PGPASSWORD; export PGPASSWORD; exec pg_restore -w -U postgres -d template1 --clean --if-exists --create --exit-on-error'
`
