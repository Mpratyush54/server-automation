// Package runner executes a dependency graph of install steps with bounded
// concurrency. It is deliberately generic: platformctl's provision builds the
// graph (cmd/root.go) and decides how each node runs.
package runner

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"
)

// Node is one step in the graph.
type Node struct {
	Name string
	// Deps must finish (or be skipped) before this node starts.
	Deps []string
	// Skip marks a disabled node; it counts as satisfied for dependants.
	Skip bool
	Run  func(ctx context.Context) error
}

// Status is a node's final outcome.
type Status string

const (
	StatusOK      Status = "ok"
	StatusFailed  Status = "failed"
	StatusSkipped Status = "skipped"
	// StatusBlocked: never started because a dependency failed or the run
	// stopped scheduling after an earlier failure.
	StatusBlocked Status = "blocked"
)

// Result is reported for every node.
type Result struct {
	Name     string
	Status   Status
	Err      error
	Duration time.Duration
}

// Options tunes a run.
type Options struct {
	// Concurrency caps simultaneously running nodes (minimum 1).
	Concurrency int
	OnStart     func(name string)
	OnFinish    func(r Result)
}

// Validate checks for unknown dependencies, duplicates and cycles.
func Validate(nodes []Node) error {
	idx := map[string]int{}
	for i, n := range nodes {
		if n.Name == "" {
			return errors.New("runner: node with empty name")
		}
		if _, dup := idx[n.Name]; dup {
			return fmt.Errorf("runner: duplicate node %q", n.Name)
		}
		idx[n.Name] = i
	}
	for _, n := range nodes {
		for _, d := range n.Deps {
			if _, ok := idx[d]; !ok {
				return fmt.Errorf("runner: %q depends on unknown node %q", n.Name, d)
			}
		}
	}
	// Kahn's algorithm for cycle detection.
	indeg := map[string]int{}
	users := map[string][]string{}
	for _, n := range nodes {
		indeg[n.Name] += 0
		for _, d := range n.Deps {
			indeg[n.Name]++
			users[d] = append(users[d], n.Name)
		}
	}
	var queue []string
	for name, d := range indeg {
		if d == 0 {
			queue = append(queue, name)
		}
	}
	seen := 0
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		seen++
		for _, u := range users[cur] {
			indeg[u]--
			if indeg[u] == 0 {
				queue = append(queue, u)
			}
		}
	}
	if seen != len(nodes) {
		var stuck []string
		for name, d := range indeg {
			if d > 0 {
				stuck = append(stuck, name)
			}
		}
		sort.Strings(stuck)
		return fmt.Errorf("runner: dependency cycle among %s", strings.Join(stuck, ", "))
	}
	return nil
}

// Run executes the graph. Ready nodes start in slice order (put long or
// critical-path steps first). After the first failure no new node starts, but
// running nodes finish. The returned error joins all node failures.
func Run(ctx context.Context, nodes []Node, opts Options) ([]Result, error) {
	if err := Validate(nodes); err != nil {
		return nil, err
	}
	if opts.Concurrency < 1 {
		opts.Concurrency = 1
	}

	results := make(map[string]Result, len(nodes))
	pending := make([]Node, 0, len(nodes))
	for _, n := range nodes {
		if n.Skip {
			results[n.Name] = Result{Name: n.Name, Status: StatusSkipped}
			if opts.OnFinish != nil {
				opts.OnFinish(results[n.Name])
			}
			continue
		}
		pending = append(pending, n)
	}

	type done struct{ r Result }
	finished := make(chan done)
	running := 0
	failed := false

	depState := func(n Node) (ready, blocked bool) {
		ready = true
		for _, d := range n.Deps {
			r, ok := results[d]
			switch {
			case !ok:
				ready = false
			case r.Status == StatusFailed || r.Status == StatusBlocked:
				return false, true
			}
		}
		return ready, false
	}

	var wg sync.WaitGroup
	for len(pending) > 0 || running > 0 {
		// Resolve blocked nodes and start ready ones, in order.
		next := pending[:0]
		for _, n := range pending {
			ready, blocked := depState(n)
			switch {
			case blocked || (failed && ready) || (ctx.Err() != nil && ready):
				r := Result{Name: n.Name, Status: StatusBlocked}
				results[n.Name] = r
				if opts.OnFinish != nil {
					opts.OnFinish(r)
				}
			case ready && running < opts.Concurrency:
				running++
				if opts.OnStart != nil {
					opts.OnStart(n.Name)
				}
				wg.Add(1)
				go func(n Node) {
					defer wg.Done()
					start := time.Now()
					err := n.Run(ctx)
					st := StatusOK
					if err != nil {
						st = StatusFailed
					}
					finished <- done{Result{Name: n.Name, Status: st, Err: err, Duration: time.Since(start)}}
				}(n)
			default:
				next = append(next, n)
			}
		}
		pending = next

		if running == 0 {
			if len(pending) > 0 {
				// Only possible if something is waiting on a node that will
				// never resolve; Validate prevents this, so treat as blocked.
				for _, n := range pending {
					results[n.Name] = Result{Name: n.Name, Status: StatusBlocked}
				}
				pending = nil
			}
			break
		}

		d := <-finished
		running--
		results[d.r.Name] = d.r
		if d.r.Status == StatusFailed {
			failed = true
		}
		if opts.OnFinish != nil {
			opts.OnFinish(d.r)
		}
	}
	wg.Wait()

	out := make([]Result, 0, len(nodes))
	var errs []error
	for _, n := range nodes {
		r := results[n.Name]
		out = append(out, r)
		if r.Status == StatusFailed {
			errs = append(errs, fmt.Errorf("%s: %w", r.Name, r.Err))
		}
	}
	if len(errs) == 0 && ctx.Err() != nil {
		for _, r := range out {
			if r.Status == StatusBlocked {
				return out, ctx.Err()
			}
		}
	}
	return out, errors.Join(errs...)
}
