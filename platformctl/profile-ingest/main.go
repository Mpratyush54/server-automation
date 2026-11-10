// Command profile-ingest is the profile ingest proxy deployed in front of the
// collector's Pyroscope receiver (full telemetry profile). See
// internal/profileproxy for the label rules.
package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/profileproxy"
)

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func main() {
	logger := log.New(os.Stderr, "profile-ingest: ", log.LstdFlags)
	upstream, err := url.Parse(env("UPSTREAM_URL", "http://alloy.monitoring.svc:9999"))
	if err != nil || (upstream.Scheme != "http" && upstream.Scheme != "https") || upstream.Host == "" {
		logger.Fatalf("invalid UPSTREAM_URL")
	}
	srv := &http.Server{
		Addr:              env("LISTEN_ADDR", ":8080"),
		Handler:           profileproxy.Handler(upstream, logger),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       60 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       120 * time.Second,
		MaxHeaderBytes:    64 << 10,
	}
	health := &http.Server{
		Addr: env("HEALTH_ADDR", ":8081"),
		Handler: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusOK)
		}),
		ReadHeaderTimeout: 5 * time.Second,
	}
	go func() {
		if err := health.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Fatalf("health: %v", err)
		}
	}()
	go func() {
		ch := make(chan os.Signal, 1)
		signal.Notify(ch, syscall.SIGTERM, os.Interrupt)
		<-ch
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		_ = health.Shutdown(ctx)
		_ = srv.Shutdown(ctx)
	}()
	logger.Printf("listening on %s, upstream %s", srv.Addr, upstream.Redacted())
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		logger.Fatalf("serve: %v", err)
	}
}
