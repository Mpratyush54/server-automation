package components

import (
	"os"
	"path/filepath"
	"testing"
)

func TestUpgradeResolverDoesNotMutateAndQuotesImages(t *testing.T) {
	script := digestTestTools + `API='ghcr.io/test/platform-api:1.2.3'
PORTAL='ghcr.io/test/platform-portal:1.2.3'
` + upgradeResolveScript() + `[[ $rolls == 0 ]] || exit 90
[[ ! -s "$MIG_FILE" ]] || exit 91
`
	if out, e := runJobShell(t, script); e != nil {
		t.Fatalf("%v: %s", e, out)
	}
	script = digestTestTools + `API='ghcr.io/test/api:1.2.3'
PORTAL='ghcr.io/test/portal:1.2.3'
DIGEST=invalid
ALLOW_LOCAL_IMAGES=true
` + upgradeResolveScript()
	if out, e := runJobShell(t, script); e != nil {
		t.Fatalf("local fallback: %v: %s", e, out)
	}
}

func TestLocalUpgradeRestoreStreamsPasswordAndQuotedDump(t *testing.T) {
	dump := filepath.Join(t.TempDir(), "platform ' dollar $ dump.dump")
	if e := os.WriteFile(dump, []byte("archive-fixture"), 0600); e != nil {
		t.Fatal(e)
	}
	script := `kubectl(){
 if [[ "$*" == *" get pod "* ]]; then printf postgresql-0; return; fi
 [[ "$*" == *"pg_restore -w -U postgres -d template1 --clean --if-exists --create --exit-on-error"* ]] || return 91
 [[ "$*" != *"fixture-password"* ]] || return 92
 local password body
 IFS= read -r password
 body="$(cat)"
 [[ "$password" == 'fixture-password' && "$body" == 'archive-fixture' ]] || return 93
}
DUMP=` + shellQuote(filepath.ToSlash(dump)) + `
PGPW=fixture-password
` + upgradeRestoreScript
	if out, e := runJobShell(t, script); e != nil {
		t.Fatalf("%v: %s", e, out)
	}
}
