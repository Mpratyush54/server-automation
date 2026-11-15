package images

import (
	"context"
	"fmt"
	"regexp"
	"sort"
	"strings"
)

// Offline bundles and digest-pinned images.
//
// Some charts pin images by digest (ingress-nginx: controller and
// kube-webhook-certgen, as "repo:tag@sha256:..."). The bundle's image archives
// are made with `docker save`, which keeps tags but not registry digests, so
// after k3s imports them containerd knows "repo:tag" only, and a pod that asks
// for the digest reference finds nothing and tries the registry: on an offline
// node that is ImagePullBackOff, and the ingress-nginx admission Job blocks
// Helm. scripts/build-bundle.sh therefore saves each digest-pinned image under
// its tag (docker pulled and verified it by digest), and AliasDigestRefs adds
// the "repo@sha256:..." name once k3s has imported the archives: the same
// image record the kubelet's CRI creates after a registry pull, so the pinned
// reference resolves locally. The archives themselves are verified against the
// bundle's SHA256SUMS and its .sha256 before anything is imported.

// k8sNamespace is the containerd namespace the kubelet uses.
const k8sNamespace = "k8s.io"

var digestRe = regexp.MustCompile(`^sha256:[a-f0-9]{64}$`)

// DigestPinned returns the entries of List() pinned by digest.
func DigestPinned() []string {
	var out []string
	for _, img := range List() {
		if _, _, ok := DigestAlias(img); ok {
			out = append(out, img)
		}
	}
	return out
}

// DigestAlias splits a "repo:tag@sha256:<hex>" reference into the tag name the
// bundle stores the image under and the digest name pods resolve, both
// normalised as containerd names them ("nginx" -> "docker.io/library/nginx").
// ok is false for references without a tag or a sha256 digest.
func DigestAlias(ref string) (tagRef, digestRef string, ok bool) {
	name, digest, found := strings.Cut(strings.TrimSpace(ref), "@")
	if !found || !digestRe.MatchString(digest) {
		return "", "", false
	}
	slash := strings.LastIndex(name, "/")
	colon := strings.LastIndex(name, ":")
	if colon <= slash || colon == len(name)-1 {
		return "", "", false // no tag: the archive cannot carry a name for it
	}
	repo := normalizeRepo(name[:colon])
	return repo + name[colon:], repo + "@" + digest, true
}

// normalizeRepo applies Docker's reference defaults, as containerd does when it
// names imported images.
func normalizeRepo(repo string) string {
	first, rest, hasSlash := strings.Cut(repo, "/")
	if !hasSlash {
		return "docker.io/library/" + repo
	}
	if !strings.ContainsAny(first, ".:") && first != "localhost" {
		return "docker.io/" + repo
	}
	if first == "index.docker.io" {
		first = "docker.io"
	}
	if first == "docker.io" && !strings.Contains(rest, "/") {
		return "docker.io/library/" + rest
	}
	return first + "/" + rest
}

// AliasResult reports what AliasDigestRefs did.
type AliasResult struct {
	// Named are the digest references that were added.
	Named []string
	// Present already resolved (an earlier run, or a registry pull).
	Present []string
	// Missing are pinned images whose tag is not on the node either: an older
	// bundle saved them without a name. The kubelet pulls them from the
	// registry when the node is online.
	Missing []string
}

// AliasDigestRefs gives every digest-pinned reference in refs a containerd name
// in the kubelet's namespace that points at the image imported under its tag
// (`k3s ctr -n k8s.io images tag repo:tag repo@sha256:...`). Run it after k3s
// imported the bundle's archives (k3s does that before it starts the kubelet).
// References that are not digest-pinned are ignored.
func AliasDigestRefs(ctx context.Context, refs []string) (AliasResult, error) {
	var res AliasResult
	out, err := Run(ctx, "k3s", "ctr", "-n", k8sNamespace, "images", "ls", "-q")
	if err != nil {
		return res, fmt.Errorf("list containerd images: %w: %s", err, strings.TrimSpace(string(out)))
	}
	names := map[string]bool{}
	for _, line := range strings.Split(string(out), "\n") {
		if line = strings.TrimSpace(line); line != "" {
			names[line] = true
		}
	}
	seen := map[string]bool{}
	for _, ref := range refs {
		tagRef, digestRef, ok := DigestAlias(ref)
		if !ok || seen[digestRef] {
			continue
		}
		seen[digestRef] = true
		switch {
		case names[digestRef]:
			res.Present = append(res.Present, digestRef)
		case !names[tagRef]:
			res.Missing = append(res.Missing, ref)
		default:
			if out, err := Run(ctx, "k3s", "ctr", "-n", k8sNamespace, "images", "tag", tagRef, digestRef); err != nil {
				return res, fmt.Errorf("name %s: %w: %s", digestRef, err, strings.TrimSpace(string(out)))
			}
			res.Named = append(res.Named, digestRef)
		}
	}
	sort.Strings(res.Named)
	sort.Strings(res.Present)
	sort.Strings(res.Missing)
	return res, nil
}
