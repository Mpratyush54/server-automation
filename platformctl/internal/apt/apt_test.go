package apt

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// offlineStubs replaces apt-get and dpkg with shell functions. INSTALLED
// lists installed packages; SIM_OUT is the simulation output and SIM_FAIL
// makes the simulation fail.
const offlineStubs = `
apt-get() {
  printf '%s\n' "$*" >> "$APT_LOG"
  local a
  for a; do case "$a" in Dir::Etc::SourceList=*) cat "${a#*=}" >> "$APT_LOG.sources" ;; esac; done
  case " $* " in
    *" -s "*)
      if [ -n "${SIM_FAIL:-}" ]; then echo "E: Unable to locate package $SIM_FAIL"; return 100; fi
      printf '%b' "${SIM_OUT:-}" ;;
  esac
}
dpkg() { echo amd64; }
dpkg-query() {
  case " ${INSTALLED:-} " in *" $3 "*) echo "install ok installed" ;; *) return 1 ;; esac
}
`

func TestOfflinePackagesScript(t *testing.T) {
	bash, err := exec.LookPath("bash")
	if err != nil {
		t.Skip("bash unavailable")
	}
	for _, tc := range []struct {
		name, release, installed, simOut, simFail string
		wantErr                                   string
		wantInstall                               string // "" = no install
	}{
		{name: "fresh jammy node", release: "22.04", installed: "util-linux curl openssl",
			simOut:      `Inst libisns0 (1 local)\nInst open-iscsi (2 local)\n`,
			wantInstall: "install -y -qq open-iscsi nfs-common dmsetup unattended-upgrades fail2ban chrony nftables"},
		{name: "noble", release: "24.04", wantInstall: "install -y -qq " + OfflinePackages},
		{name: "already installed", release: "22.04", installed: OfflinePackages},
		{name: "unresolvable", release: "22.04", simFail: "libbar", wantErr: "Unable to locate package libbar"},
		{name: "removal refused", release: "22.04", simOut: `Inst chrony (4 local)\nRemv systemd [249]\nRemv ntp [1]\n`,
			wantErr: "would remove systemd ntp"},
		{name: "chrony replaces timesyncd", release: "22.04", simOut: `Remv systemd-timesyncd [249]\nInst chrony (4 local)\n`,
			wantInstall: "install -y -qq " + OfflinePackages},
		{name: "unsupported release", release: "26.04", wantErr: "no packages for ubuntu 26.04 (amd64)"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := filepath.ToSlash(t.TempDir())
			for _, release := range []string{"22.04", "24.04"} {
				dir := filepath.Join(root, "packages", "ubuntu-"+release, "amd64")
				if err := os.MkdirAll(dir, 0o755); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(dir, "Packages"), []byte("Package: open-iscsi\n"), 0o644); err != nil {
					t.Fatal(err)
				}
			}
			osRelease := filepath.Join(root, "os-release")
			if err := os.WriteFile(osRelease, []byte("ID=ubuntu\nVERSION_ID="+tc.release+"\n"), 0o644); err != nil {
				t.Fatal(err)
			}
			log := filepath.Join(root, "apt.log")
			cmd := exec.Command(bash, "-c", offlineStubs+OfflinePackagesScript)
			cmd.Env = append(os.Environ(),
				"PACKAGE_ROOT="+root+"/packages", "OFFLINE_PACKAGES="+OfflinePackages,
				"OS_RELEASE="+filepath.ToSlash(osRelease), "APT_LOG="+filepath.ToSlash(log),
				"INSTALLED="+tc.installed, "SIM_OUT="+tc.simOut, "SIM_FAIL="+tc.simFail)
			out, err := cmd.CombinedOutput()
			if tc.wantErr != "" {
				if err == nil || !strings.Contains(string(out), tc.wantErr) {
					t.Fatalf("want error %q, got %v: %s", tc.wantErr, err, out)
				}
			} else if err != nil {
				t.Fatalf("%v: %s", err, out)
			}
			data, _ := os.ReadFile(log)
			var install string
			for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
				if line == "" {
					continue
				}
				// Only the bundle's repository: never the system sources or lists.
				if !strings.Contains(line, "Dir::Etc::SourceList=") || !strings.Contains(line, "Dir::Etc::SourceParts=") ||
					!strings.Contains(line, "Dir::State::Lists=") {
					t.Fatalf("apt call may use the system sources: %q", line)
				}
				if strings.Contains(line, " install -y ") {
					install = line
				}
			}
			if sources, _ := os.ReadFile(log + ".sources"); len(data) > 0 {
				want := "deb [trusted=yes] file:" + root + "/packages/ubuntu-" + tc.release + "/amd64 ./\n"
				for _, l := range strings.SplitAfter(string(sources), "\n") {
					if l != "" && l != want {
						t.Fatalf("sources.list line %q, want %q", l, want)
					}
				}
				if len(sources) == 0 {
					t.Fatal("no sources.list written")
				}
			}
			if tc.wantInstall == "" {
				if install != "" {
					t.Fatalf("unexpected install: %s", install)
				}
				return
			}
			if !strings.HasSuffix(install, tc.wantInstall) {
				t.Fatalf("install = %q, want suffix %q", install, tc.wantInstall)
			}
		})
	}
}

// The bundle must carry the dependency closure of exactly the packages an
// offline join installs.
func TestBundleScriptPackageList(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "..", "scripts", "build-bundle.sh"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), `OFFLINE_PACKAGES="`+OfflinePackages+`"`) {
		t.Fatalf("scripts/build-bundle.sh must set OFFLINE_PACKAGES=%q", OfflinePackages)
	}
}
