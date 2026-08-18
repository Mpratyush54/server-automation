package state

import (
	"fmt"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const DefaultPath = "/etc/platform/.bootstrap_state"
const DefaultLockPath = "/etc/platform/.provision.lock"

var (
	mu       sync.Mutex
	path     = DefaultPath
	lockPath = DefaultLockPath
	lockFile *os.File
)

func SetPath(p string) {
	mu.Lock()
	defer mu.Unlock()
	path = p
}

func SetLockPath(p string) {
	mu.Lock()
	defer mu.Unlock()
	lockPath = p
}

func readLockMeta(f *os.File) (string, error) {
	_, _ = f.Seek(0, 0)
	buf := make([]byte, 512)
	n, err := f.Read(buf)
	if err != nil && n == 0 {
		return "", err
	}
	return strings.TrimSpace(string(buf[:n])), nil
}

func loadMap() map[string]string {
	out := map[string]string{}
	data, err := os.ReadFile(path)
	if err != nil {
		return out
	}
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || !strings.Contains(line, "=") {
			continue
		}
		parts := strings.SplitN(line, "=", 2)
		out[parts[0]] = parts[1]
	}
	return out
}

func saveMap(m map[string]string) error {
	if err := os.MkdirAll("/etc/platform", 0755); err != nil {
		return err
	}
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var b strings.Builder
	for _, k := range keys {
		b.WriteString(k)
		b.WriteByte('=')
		b.WriteString(m[k])
		b.WriteByte('\n')
	}
	return os.WriteFile(path, []byte(b.String()), 0644)
}

func IsDone(step string) bool {
	mu.Lock()
	defer mu.Unlock()
	return loadMap()[step] == "done"
}

func MarkDone(step string) error {
	mu.Lock()
	defer mu.Unlock()
	m := loadMap()
	m[step] = "done"
	return saveMap(m)
}

func MarkInProgress(step string) error {
	mu.Lock()
	defer mu.Unlock()
	m := loadMap()
	if m[step] == "done" {
		return nil
	}
	m[step] = "in_progress"
	return saveMap(m)
}

func Clear(step string) error {
	mu.Lock()
	defer mu.Unlock()
	m := loadMap()
	delete(m, step)
	return saveMap(m)
}

func DoneSteps() []string {
	mu.Lock()
	defer mu.Unlock()
	m := loadMap()
	var out []string
	for k, v := range m {
		if v == "done" {
			out = append(out, k)
		}
	}
	sort.Strings(out)
	return out
}

func StatusLine() string {
	mu.Lock()
	defer mu.Unlock()
	m := loadMap()
	var done, progress []string
	for k, v := range m {
		switch v {
		case "done":
			done = append(done, k)
		case "in_progress":
			progress = append(progress, k)
		}
	}
	if len(done) == 0 && len(progress) == 0 {
		return "no prior progress"
	}
	msg := fmt.Sprintf("%d step(s) done", len(done))
	if len(progress) > 0 {
		sort.Strings(progress)
		msg += fmt.Sprintf(", resuming: %s", strings.Join(progress, ", "))
	}
	return msg
}

// LockInfo reads provision-lock metadata without acquiring the lock.
// Empty string means no lock file (or unreadable). Safe for `platformctl status`.
func LockInfo() (string, error) {
	data, err := os.ReadFile(lockPath)
	if err != nil {
		if os.IsNotExist(err) {
			return "", nil
		}
		return "", err
	}
	return strings.TrimSpace(string(data)), nil
}

func AlivePID(pid int) bool {
	if pid <= 0 {
		return false
	}
	p, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	return p.Signal(syscall.Signal(0)) == nil
}

func ParsePIDFromLock(meta string) int {
	for _, part := range strings.Fields(meta) {
		if strings.HasPrefix(part, "pid=") {
			n, _ := strconv.Atoi(strings.TrimPrefix(part, "pid="))
			return n
		}
	}
	return 0
}

func writeLockMeta(f *os.File, owner string) {
	meta := fmt.Sprintf("pid=%d started=%s owner=%s\n", os.Getpid(), time.Now().UTC().Format(time.RFC3339), owner)
	_ = f.Truncate(0)
	_, _ = f.Seek(0, 0)
	_, _ = f.WriteString(meta)
	_ = f.Sync()
}
