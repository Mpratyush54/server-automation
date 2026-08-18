package components

import "testing"

func TestSqlLiteralEscapesQuotes(t *testing.T) {
	if got := sqlLiteral("a'b"); got != "a''b" {
		t.Errorf("sqlLiteral = %q", got)
	}
	if got := sqlLiteral("plain"); got != "plain" {
		t.Errorf("sqlLiteral = %q", got)
	}
}

func TestFirstFilledSkipsEmpty(t *testing.T) {
	if got := firstFilled("", "  ", "keep", "later"); got != "keep" {
		t.Errorf("firstFilled = %q", got)
	}
	if got := firstFilled("", ""); got != "" {
		t.Errorf("expected empty, got %q", got)
	}
}

func TestRandomTokenLength(t *testing.T) {
	tok := randomToken(16)
	if len(tok) != 16 {
		t.Errorf("len=%d want 16 (%q)", len(tok), tok)
	}
}
