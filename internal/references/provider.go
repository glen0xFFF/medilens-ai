// Package references looks medicines up in a registry: the live PH FDA
// verification search (phfda.go) or the demo fixtures (fixture.go). Every
// outcome is a contracts.SearchResult, the shape the matcher consumes; a
// provider never returns an error.
package references

import (
	"context"

	"github.com/medilens-ai/medilens/internal/contracts"
)

// Query is a registry query built from clear label text only (Node
// ReferenceQuery). An empty field is absent.
type Query struct {
	RegistrationNumber string
	Name               string
}

// Provider is a registry lookup (Node ReferenceProvider). A lookup that
// fails is {kind: unavailable}; one with nothing to search for is
// {kind: not_attempted}.
type Provider interface {
	Search(ctx context.Context, q Query) contracts.SearchResult
}
