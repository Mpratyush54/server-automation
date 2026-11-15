package cmd

import (
	"io"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/components"
)

// statusHADatastores prints the replicated datastores and Longhorn volumes.
// The checks are read-only kubectl calls that work on every server, so joined
// servers show them too: when the first server is down, they are where an
// operator looks. Replaceable in tests.
var statusHADatastores = func(w io.Writer) {
	components.PrintHADatastoreStatus(w, cfg)
	components.PrintLonghornVolumeStatus(w)
}
