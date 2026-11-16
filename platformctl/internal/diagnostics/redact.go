package diagnostics

import (
	"regexp"
	"strings"
)

type rule struct {
	re   *regexp.Regexp
	repl string
}

// Applied in order: specific secrets first, then addresses, then generic tokens.
var rules = []rule{
	{regexp.MustCompile(`(?s)-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*?-----END [A-Z0-9 ]*PRIVATE KEY-----`), "[secret]"},
	{regexp.MustCompile(`AGE-SECRET-KEY-1[0-9A-Z]+`), "[secret]"},
	{regexp.MustCompile(`\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}`), "[secret]"},
	{regexp.MustCompile(`(?i)\b(?:sdk_live|sdk_test|plat_agent|plat_pat|cairn|ghp|gho|ghs|github_pat|glpat|xox[abp])_[A-Za-z0-9_-]{8,}`), "[secret]"},
	{regexp.MustCompile(`\bAKIA[0-9A-Z]{16}\b`), "[secret]"},
	{regexp.MustCompile(`(?i)\b(authorization:\s*)(?:bearer|basic|token)\s+\S+`), "${1}[secret]"},
	{regexp.MustCompile(`(?i)\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}`), "${1} [secret]"},
	{regexp.MustCompile(`(?i)\b([A-Z0-9_.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential)[A-Z0-9_.-]*)("?\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)`), "${1}${2}[secret]"},
	{regexp.MustCompile(`(?i)\b[a-z][a-z0-9+.-]*://[^\s"'<>]+`), "[url]"},
	{regexp.MustCompile(`(?i)\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b`), "[email]"},
	{regexp.MustCompile(`\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}(?:/\d{1,2})?(?::\d{1,5})?\b`), "[ip]"},
	{regexp.MustCompile(`(?i)\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}\b|(?i)(?:[0-9a-f]{1,4}:)*:(?::[0-9a-f]{1,4})+\b|(?i)\b(?:[0-9a-f]{1,4}:){1,7}:`), "[ip]"},
}

var longToken = regexp.MustCompile(`[A-Za-z0-9+/_=-]{32,}`)

var hostRe = regexp.MustCompile(`\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}\b`)

// File extensions and internal suffixes that look like host names but are not.
var notTLD = map[string]bool{
	"yaml": true, "yml": true, "json": true, "go": true, "sh": true, "service": true, "timer": true, "conf": true,
	"log": true, "txt": true, "tgz": true, "zst": true, "gz": true, "tar": true, "md": true, "js": true, "ts": true,
	"py": true, "sql": true, "pem": true, "crt": true, "key": true, "csr": true, "toml": true, "ini": true, "env": true,
	"lock": true, "sock": true, "pid": true, "deb": true, "img": true, "mjs": true, "html": true, "css": true,
}

// Redact removes domains, IPs, emails, URLs, tokens and secrets from s.
func Redact(s string) string {
	for _, r := range rules {
		s = r.re.ReplaceAllString(s, r.repl)
	}
	s = longToken.ReplaceAllStringFunc(s, func(m string) string {
		digits, lower, upper := 0, 0, 0
		for _, c := range m {
			switch {
			case c >= '0' && c <= '9':
				digits++
			case c >= 'a' && c <= 'z':
				lower++
			case c >= 'A' && c <= 'Z':
				upper++
			}
		}
		if (upper > 0 && lower > 0 && digits > 0) || (digits >= 4 && lower+upper >= 4) {
			return "[secret]"
		}
		return m
	})
	return hostRe.ReplaceAllStringFunc(s, func(m string) string {
		labels := strings.Split(m, ".")
		if notTLD[strings.ToLower(labels[len(labels)-1])] {
			return m
		}
		return "[host]"
	})
}
