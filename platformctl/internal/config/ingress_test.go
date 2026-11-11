package config

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestIngressIPLimitValidation(t *testing.T) {
	settings := []struct {
		key           string
		fallback, max int
	}{
		{"INGRESS_IP_RATE_LIMIT", 1000, 1000000},
		{"INGRESS_IP_BURST", 2000, 1000000},
		{"INGRESS_IP_CONNECTIONS", 2000, 65535},
	}
	for _, setting := range settings {
		t.Run(setting.key, func(t *testing.T) {
			for _, tc := range []struct {
				value   string
				want    int
				warning bool
			}{
				{"", setting.fallback, false},
				{"0", 0, false},
				{"1", 1, false},
				{fmt.Sprint(setting.max), setting.max, false},
				{" 1234 ", 1234, false},
				{"-1", setting.fallback, true},
				{"abc", setting.fallback, true},
				{"1.5", setting.fallback, true},
				{" ", setting.fallback, true},
				{fmt.Sprint(setting.max + 1), setting.fallback, true},
				{"9999999999999999999999999999999", setting.fallback, true},
			} {
				t.Run(tc.value, func(t *testing.T) {
					t.Setenv(setting.key, tc.value)
					log, err := os.CreateTemp(t.TempDir(), "warnings")
					if err != nil {
						t.Fatal(err)
					}
					defer log.Close()
					oldStderr := os.Stderr
					os.Stderr = log
					defer func() { os.Stderr = oldStderr }()
					got := getEnvIngressLimit(setting.key, setting.fallback, setting.max)
					if got != tc.want {
						t.Fatalf("got %d, want %d", got, tc.want)
					}
					output, err := os.ReadFile(log.Name())
					if err != nil {
						t.Fatal(err)
					}
					if tc.warning {
						if !strings.Contains(string(output), "warning: invalid "+setting.key) || !strings.Contains(string(output), fmt.Sprintf("using default %d", setting.fallback)) {
							t.Fatalf("missing fallback warning: %q", output)
						}
					} else if len(output) != 0 {
						t.Fatalf("unexpected warning: %q", output)
					}
				})
			}
		})
	}
}

func TestIngressIPLimitsSavedAndReloaded(t *testing.T) {
	for _, value := range []string{"0", "4321"} {
		t.Run(value, func(t *testing.T) {
			profileEnv(t, "")
			keys := []string{"INGRESS_IP_RATE_LIMIT", "INGRESS_IP_BURST", "INGRESS_IP_CONNECTIONS"}
			for _, key := range keys {
				t.Setenv(key, value)
			}
			c := Load()
			envFilePath = filepath.Join(t.TempDir(), ".env")
			if err := c.SaveEnvFile(envFilePath); err != nil {
				t.Fatal(err)
			}
			data, err := os.ReadFile(envFilePath)
			if err != nil {
				t.Fatal(err)
			}
			for _, key := range keys {
				if !strings.Contains(string(data), key+"="+value+"\n") {
					t.Fatalf("missing saved %s", key)
				}
				t.Setenv(key, "")
			}
			loaded := Load()
			if loaded.IngressIPRateLimit != c.IngressIPRateLimit || loaded.IngressIPBurst != c.IngressIPBurst || loaded.IngressIPConnections != c.IngressIPConnections {
				t.Fatal("ingress limits changed after save/reload")
			}
			// Process environment must override saved values, including zero.
			for _, key := range keys {
				t.Setenv(key, "0")
			}
			overridden := Load()
			if overridden.IngressIPRateLimit != 0 || overridden.IngressIPBurst != 0 || overridden.IngressIPConnections != 0 {
				t.Fatal("environment overrides ignored")
			}
		})
	}
}
