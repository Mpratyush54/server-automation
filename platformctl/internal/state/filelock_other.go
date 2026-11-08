//go:build !unix

package state

// withFileLock is a no-op off Unix; production provision runs on Linux.
func withFileLock(fn func() error) error { return fn() }
