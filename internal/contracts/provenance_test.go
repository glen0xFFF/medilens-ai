package contracts

import (
	"encoding/json"
	"strings"
	"testing"
)

// Go port spec §4: the result is base §5.3 plus an optional
// provenance:{model, references}. Absent, it is omitted, so the recorded
// Node results (which have none) still round-trip unchanged.
func TestProvenanceIsOptionalOnTheResult(t *testing.T) {
	r := AnalysisResult{ID: "x"}
	b, err := json.Marshal(r)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(b), "provenance") {
		t.Errorf("absent provenance encoded: %s", b)
	}
	r.Provenance = &Provenance{Model: "mock", References: "fixture"}
	if b, err = json.Marshal(r); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(b), `"provenance":{"model":"mock","references":"fixture"}`) {
		t.Errorf("provenance: %s", b)
	}
	var back AnalysisResult
	if err := json.Unmarshal(b, &back); err != nil || back.Provenance == nil || *back.Provenance != *r.Provenance {
		t.Errorf("round trip %+v %v", back.Provenance, err)
	}
}
