package components

import (
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestInstallerVerifiesArchiveBeforeExtraction(t *testing.T) {
	script, err := os.ReadFile("../../install.sh")
	if err != nil {
		t.Fatal(err)
	}
	for _, valid := range []bool{true, false} {
		t.Run(fmt.Sprint(valid), func(t *testing.T) {
			dir := filepath.ToSlash(t.TempDir())
			expected := fmt.Sprintf("%x", sha256.Sum256([]byte("archive fixture")))
			if !valid {
				expected = strings.Repeat("0", 64)
			}
			prefix := "INSTALL_DIR=" + shellQuote(dir) + "\nPLATFORMCTL_INSTALL_DIR=$INSTALL_DIR\nMARKER=$INSTALL_DIR/extracted\nEXPECTED=" + shellQuote(expected) + "\n"
			out, err := runJobShell(t, prefix+checksumTestTools+string(script))
			if valid && err != nil {
				t.Fatalf("valid archive rejected: %v %s", err, out)
			}
			if !valid && err == nil {
				t.Fatal("corrupt archive accepted")
			}
			_, extracted := os.Stat(filepath.Join(dir, "extracted"))
			if !valid && !os.IsNotExist(extracted) {
				t.Fatal("archive extracted before integrity check")
			}
			if valid && extracted != nil {
				t.Fatal("valid archive was not extracted")
			}
		})
	}
}
func TestSDKScriptKeepsTokenInMemoryAndCleansTemps(t *testing.T) {
	source, err := os.ReadFile("../../../scripts/vps-deploy-sdk-apps.sh")
	if err != nil {
		t.Fatal(err)
	}
	script := string(source)
	if strings.Contains(script, "/tmp/sdk-token.json") {
		t.Fatal("SDK credential written to a shared file")
	}
	end := strings.Index(script, "echo \"==> Build images")
	if end < 0 {
		t.Fatal("script bootstrap boundary missing")
	}
	// Stop after authentication and token creation; no Docker or cluster operations.
	prefix := "ADMIN_PASSWORD=test-only\ncurl() { case \"$*\" in *auth/login*) printf '{\"token\":\"login-test\"}';; *projects/*/tokens*) printf '{\"token\":\"sdk-test-secret\"}';; *) printf '[{\"id\":\"project-test\",\"name\":\"sdk-demo-apps\"}]';; esac; }\n"
	out, err := runJobShell(t, prefix+script[:end]+"\n[[ $SDK_TOKEN == sdk-test-secret ]]\nprintf 'PRIVATE_TMP=%s\\n' \"$TMP\"\n")
	if err != nil {
		t.Fatalf("%v %s", err, out)
	}
	for _, line := range strings.Split(out, "\n") {
		if strings.HasPrefix(line, "PRIVATE_TMP=") {
			p := strings.TrimPrefix(line, "PRIVATE_TMP=")
			if _, err := os.Stat(p); !os.IsNotExist(err) {
				t.Fatal("temporary directory survived exit")
			}
		}
	}
	if strings.Contains(script, "/tmp/sdk-token.json") || strings.Contains(script, "open(\"/tmp/sdk-token.json\")") {
		t.Fatal("SDK credential written to a shared file")
	}
}

const checksumTestTools = `uname() { case "$1" in -s) echo Linux;; -m) echo x86_64;; esac; }
curl() {
 local dest="" url="" arg previous=""
 for arg in "$@"; do if [[ "$previous" == -o ]]; then dest="$arg"; fi; [[ "$arg" != https://* ]] || url="$arg"; previous="$arg"; done
 case "$url" in
  *api.github.com*) printf '{"tag_name": "v1.0.0"}';;
  */checksums.txt) printf "%s  platformctl_1.0.0_linux_amd64.tar.gz\n" "$EXPECTED" > "$dest";;
  *) printf "archive fixture" > "$dest";;
 esac
}
 tar() {
 local dest="${@: -1}"
 : > "$MARKER"
 printf "#!/bin/bash\nexit 0\n" > "$dest/platformctl"
}
`

func TestDownloaderCopiesShareIntegrityVerification(t *testing.T) {
	canonical, err := os.ReadFile("../../install.sh")
	if err != nil {
		t.Fatal(err)
	}
	fallback, err := os.ReadFile("../../../scripts/install.sh")
	if err != nil {
		t.Fatal(err)
	}
	if strings.ReplaceAll(string(canonical), "\r\n", "\n") != strings.ReplaceAll(string(fallback), "\r\n", "\n") {
		t.Fatal("fallback downloader diverged from verified release downloader")
	}
}
