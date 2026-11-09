package cmd

import (
	"encoding/json"
	"fmt"
	"strings"
)

// This script runs only inside PostgreSQL. Like backup's PWHELPER, it reads
// env/file credentials there; neither the host nor Go sees the password.
// InstallPlatform configures POSTGRES_DB=platform in the API environment.
const operationsSQL = `WITH active AS (
 SELECT type, status, updated_at FROM public.operations
 WHERE status IN ('pending','running','compensating')
)
SELECT json_build_object('count', (SELECT count(*) FROM active),
 'recent', COALESCE((SELECT json_agg(row_to_json(r)) FROM
 (SELECT type, status, updated_at AS "updatedAt" FROM active
 ORDER BY updated_at DESC LIMIT 5) r), '[]'::json));`

const operationsShell = `set -euo pipefail
pw() { local v="${!1:-}" f="${1}_FILE"; if [ -z "$v" ] && [ -n "${!f:-}" ]; then v=$(cat "${!f}"); fi; printf "%s" "$v"; }
export PGPASSWORD="$(pw POSTGRES_PASSWORD)"
exists=$(psql -X -w -U postgres -d platform -At -v ON_ERROR_STOP=1 -c "SELECT to_regclass('public.operations') IS NOT NULL")
case "$exists" in
 f) printf '%s\n' '{"count":0,"recent":[]}';;
 t) exec psql -X -w -U postgres -d platform -At -v ON_ERROR_STOP=1 -c "$1";;
 *) echo 'cannot determine operations table existence' >&2; exit 1;;
esac
`

func checkActiveOperations() error {
	pod, err := uk("-n", "databases", "get", "pods", "-l", "app.kubernetes.io/name=postgresql", "-o", "jsonpath={.items[0].metadata.name}")
	if err != nil {
		return fmt.Errorf("find PostgreSQL for active-operation check: %w", err)
	}
	if strings.TrimSpace(pod) == "" {
		return fmt.Errorf("no PostgreSQL pod for active-operation check")
	}
	raw, err := uk("-n", "databases", "exec", pod, "--", "bash", "-ec", operationsShell, "--", operationsSQL)
	if err != nil {
		return fmt.Errorf("query active operations: %w", err)
	}
	var result struct {
		Count  *int64                                     `json:"count"`
		Recent []struct{ Type, Status, UpdatedAt string } `json:"recent"`
	}
	if err := json.Unmarshal([]byte(raw), &result); err != nil {
		return fmt.Errorf("parse active operations: %w", err)
	}
	if result.Count == nil || *result.Count < 0 || (*result.Count > 0 && len(result.Recent) == 0) || (*result.Count == 0 && len(result.Recent) != 0) {
		return fmt.Errorf("invalid active operations result")
	}
	if *result.Count == 0 {
		return nil
	}
	var recent []string
	for _, op := range result.Recent {
		recent = append(recent, fmt.Sprintf("type=%s status=%s updatedAt=%s", op.Type, op.Status, op.UpdatedAt))
	}
	return fmt.Errorf("%d active operations; wait for completion before upgrading; newest: %s", *result.Count, strings.Join(recent, "; "))
}
