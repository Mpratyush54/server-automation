package state

import (
	"os"
	"strings"
	"sync"
)

const DefaultPath = "/etc/platform/.bootstrap_state"

var (
	mu   sync.Mutex
	path = DefaultPath
)

func SetPath(p string) {
	mu.Lock()
	defer mu.Unlock()
	path = p
}

func IsDone(step string) bool {
	mu.Lock()
	defer mu.Unlock()
	data, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	for _, line := range strings.Split(string(data), "\n") {
		if strings.TrimSpace(line) == step+"=done" {
			return true
		}
	}
	return false
}

func MarkDone(step string) error {
	mu.Lock()
	defer mu.Unlock()
	if err := os.MkdirAll("/etc/platform", 0755); err != nil {
		return err
	}
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = f.WriteString(step + "=done\n")
	return err
}

func Clear(step string) error {
	mu.Lock()
	defer mu.Unlock()
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	var keep []string
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || line == step+"=done" {
			continue
		}
		keep = append(keep, line)
	}
	return os.WriteFile(path, []byte(strings.Join(keep, "\n")+"\n"), 0644)
}
