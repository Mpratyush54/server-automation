package runner

import (
	"context"
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type recorder struct {
	mu    sync.Mutex
	order []string
}

func (r *recorder) add(s string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.order = append(r.order, s)
}

func (r *recorder) index(s string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	for i, v := range r.order {
		if v == s {
			return i
		}
	}
	return -1
}

func step(rec *recorder, name string, d time.Duration, err error) func(context.Context) error {
	return func(context.Context) error {
		rec.add("start:" + name)
		time.Sleep(d)
		rec.add("end:" + name)
		return err
	}
}

func TestDependenciesRespected(t *testing.T) {
	rec := &recorder{}
	nodes := []Node{
		{Name: "db", Run: step(rec, "db", 20*time.Millisecond, nil)},
		{Name: "cache", Run: step(rec, "cache", 5*time.Millisecond, nil)},
		{Name: "app", Deps: []string{"db", "cache"}, Run: step(rec, "app", 0, nil)},
		{Name: "routes", Deps: []string{"app"}, Run: step(rec, "routes", 0, nil)},
	}
	res, err := Run(context.Background(), nodes, Options{Concurrency: 4})
	if err != nil {
		t.Fatal(err)
	}
	if rec.index("start:app") < rec.index("end:db") || rec.index("start:app") < rec.index("end:cache") {
		t.Fatalf("app started before deps: %v", rec.order)
	}
	if rec.index("start:routes") < rec.index("end:app") {
		t.Fatalf("routes started before app: %v", rec.order)
	}
	for _, r := range res {
		if r.Status != StatusOK {
			t.Errorf("%s: %s", r.Name, r.Status)
		}
	}
}

func TestConcurrencyCap(t *testing.T) {
	var cur, peak int32
	run := func(context.Context) error {
		n := atomic.AddInt32(&cur, 1)
		for {
			p := atomic.LoadInt32(&peak)
			if n <= p || atomic.CompareAndSwapInt32(&peak, p, n) {
				break
			}
		}
		time.Sleep(10 * time.Millisecond)
		atomic.AddInt32(&cur, -1)
		return nil
	}
	var nodes []Node
	for _, n := range []string{"a", "b", "c", "d", "e", "f", "g", "h"} {
		nodes = append(nodes, Node{Name: n, Run: run})
	}
	if _, err := Run(context.Background(), nodes, Options{Concurrency: 3}); err != nil {
		t.Fatal(err)
	}
	if peak > 3 {
		t.Fatalf("peak concurrency %d > 3", peak)
	}
	if peak < 2 {
		t.Fatalf("expected parallelism, peak %d", peak)
	}
}

func TestSerialWhenConcurrencyOne(t *testing.T) {
	rec := &recorder{}
	nodes := []Node{
		{Name: "a", Run: step(rec, "a", 2*time.Millisecond, nil)},
		{Name: "b", Run: step(rec, "b", 0, nil)},
		{Name: "c", Run: step(rec, "c", 0, nil)},
	}
	if _, err := Run(context.Background(), nodes, Options{Concurrency: 1}); err != nil {
		t.Fatal(err)
	}
	want := "start:a,end:a,start:b,end:b,start:c,end:c"
	if got := strings.Join(rec.order, ","); got != want {
		t.Fatalf("serial order\n got %s\nwant %s", got, want)
	}
}

func TestFailureBlocksDependantsAndStopsScheduling(t *testing.T) {
	rec := &recorder{}
	boom := errors.New("boom")
	nodes := []Node{
		{Name: "slow", Run: step(rec, "slow", 30*time.Millisecond, nil)},
		{Name: "bad", Run: step(rec, "bad", 0, boom)},
		{Name: "child", Deps: []string{"bad"}, Run: step(rec, "child", 0, nil)},
		{Name: "after-slow", Deps: []string{"slow"}, Run: step(rec, "after-slow", 0, nil)},
	}
	res, err := Run(context.Background(), nodes, Options{Concurrency: 2})
	if !errors.Is(err, boom) {
		t.Fatalf("want boom, got %v", err)
	}
	got := map[string]Status{}
	for _, r := range res {
		got[r.Name] = r.Status
	}
	if got["slow"] != StatusOK {
		t.Errorf("running node must finish, got %s", got["slow"])
	}
	if got["bad"] != StatusFailed || got["child"] != StatusBlocked || got["after-slow"] != StatusBlocked {
		t.Errorf("unexpected statuses %v", got)
	}
	if rec.index("start:child") != -1 || rec.index("start:after-slow") != -1 {
		t.Errorf("no new node may start after a failure: %v", rec.order)
	}
}

func TestSkippedSatisfiesDeps(t *testing.T) {
	rec := &recorder{}
	nodes := []Node{
		{Name: "argocd", Skip: true, Run: step(rec, "argocd", 0, nil)},
		{Name: "auto-update", Deps: []string{"argocd"}, Run: step(rec, "auto-update", 0, nil)},
	}
	res, err := Run(context.Background(), nodes, Options{Concurrency: 2})
	if err != nil {
		t.Fatal(err)
	}
	if res[0].Status != StatusSkipped || res[1].Status != StatusOK {
		t.Fatalf("got %+v", res)
	}
	if rec.index("start:argocd") != -1 {
		t.Fatal("skipped node ran")
	}
}

func TestValidate(t *testing.T) {
	noop := func(context.Context) error { return nil }
	if err := Validate([]Node{{Name: "a", Deps: []string{"x"}, Run: noop}}); err == nil {
		t.Error("unknown dep not detected")
	}
	if err := Validate([]Node{{Name: "a", Run: noop}, {Name: "a", Run: noop}}); err == nil {
		t.Error("duplicate not detected")
	}
	cyc := []Node{{Name: "a", Deps: []string{"b"}, Run: noop}, {Name: "b", Deps: []string{"a"}, Run: noop}}
	if err := Validate(cyc); err == nil || !strings.Contains(err.Error(), "cycle") {
		t.Errorf("cycle not detected: %v", err)
	}
}

func TestContextCancelBlocksPending(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	nodes := []Node{
		{Name: "a", Run: func(context.Context) error { cancel(); return nil }},
		{Name: "b", Deps: []string{"a"}, Run: func(context.Context) error { t.Error("b ran after cancel"); return nil }},
	}
	_, err := Run(ctx, nodes, Options{Concurrency: 1})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("want context.Canceled, got %v", err)
	}
}
