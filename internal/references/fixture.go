package references

import (
	"context"

	"github.com/medilens-ai/medilens/internal/contracts"
	"github.com/medilens-ai/medilens/internal/demo"
)

// Fixture is the demo registry (Node FixtureReferenceProvider): whatever
// the query, it returns the reference of the demo scenario ScenarioID, as a
// fresh copy. No network. Every record it returns is synthetic DEMO DATA.
type Fixture struct {
	ScenarioID string
}

// Search returns the scenario's reference, or unavailable for an unknown
// scenario.
func (f Fixture) Search(_ context.Context, _ Query) contracts.SearchResult {
	s, ok := demo.Get(f.ScenarioID)
	if !ok {
		return contracts.SearchResult{Kind: contracts.SearchUnavailable, Reason: "Unknown demo scenario."}
	}
	return s.Reference
}
