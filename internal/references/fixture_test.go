package references

import (
	"context"
	"testing"

	"github.com/medilens-ai/medilens/internal/contracts"
	"github.com/medilens-ai/medilens/internal/demo"
)

func TestFixtureReturnsTheScenarioReference(t *testing.T) {
	for _, s := range demo.Scenarios() {
		got := Fixture{ScenarioID: s.ID}.Search(context.Background(), Query{Name: "x"})
		jsonEq(t, s.ID, got, s.Reference)
	}
}

func TestFixtureIsUnavailableForAnUnknownScenario(t *testing.T) {
	r := Fixture{ScenarioID: "nope"}.Search(context.Background(), Query{RegistrationNumber: "DR-XY900001"})
	if r.Kind != contracts.SearchUnavailable || r.Reason != "Unknown demo scenario." {
		t.Errorf("result %+v", r)
	}
	if r := (Fixture{}).Search(context.Background(), Query{}); r.Kind != contracts.SearchUnavailable {
		t.Errorf("no scenario: %+v", r)
	}
}

func TestFixtureReturnsCopies(t *testing.T) {
	f := Fixture{ScenarioID: "s1-clear"}
	a := f.Search(context.Background(), Query{})
	*a.Records[0].BrandName = "changed"
	if b := f.Search(context.Background(), Query{}); *b.Records[0].BrandName != "Paracelin 500" {
		t.Error("a change to a result reached the next search")
	}
}

// Both providers satisfy the interface.
var (
	_ Provider = Fixture{}
	_ Provider = (*PHFDA)(nil)
)
