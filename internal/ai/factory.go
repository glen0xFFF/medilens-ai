package ai

import (
	"errors"
	"fmt"

	"github.com/medilens-ai/medilens/internal/config"
	"github.com/medilens-ai/medilens/internal/demo"
	"github.com/medilens-ai/medilens/internal/metaapi"
	"github.com/medilens-ai/medilens/internal/references"
)

// Providers are the model and reference providers the configuration
// selects. There is no fallback between providers: an unusable
// configuration is an error, never the mock.
type Providers struct {
	ModelProvider config.ModelProvider
	// ModelID is the model the reader and explainer call; "" (null in the
	// capabilities) for the mock.
	ModelID           string
	ReferenceProvider config.ReferenceProvider
	Reader            LabelReader
	Explainer         PhraseExplainer
	References        references.Provider
}

// Demo reports whether results made with these providers are demo data:
// true when either provider is a mock or fixture, because the label or the
// registry rows are then made up. Such a result must carry isDemo: true.
func (p Providers) Demo() bool {
	return p.ModelProvider == config.ModelMock || p.ReferenceProvider == config.ReferenceFixture
}

// FactoryOption adjusts NewFromConfig (tests and logging hooks).
type FactoryOption func(*factory)

type factory struct {
	meta         []metaapi.Option
	phfda        func(*references.PHFDAOptions)
	onModelError func(RequestFailure)
}

// WithMetaOptions passes options to the Meta API client.
func WithMetaOptions(opts ...metaapi.Option) FactoryOption {
	return func(f *factory) { f.meta = append(f.meta, opts...) }
}

// WithPHFDAOptions adjusts the PH FDA provider options after they are set
// from the configuration.
func WithPHFDAOptions(edit func(*references.PHFDAOptions)) FactoryOption {
	return func(f *factory) { f.phfda = edit }
}

// WithOnModelError is called for every failed model request attempt, with
// its kind and status only.
func WithOnModelError(hook func(RequestFailure)) FactoryOption {
	return func(f *factory) { f.onModelError = hook }
}

// NewFromConfig builds the providers cfg selects:
//
//   - MODEL_PROVIDER=mock: the s1 label for any upload (model "mock") and no
//     explanations; muse_spark: Muse Spark through the Meta Model API, which
//     needs MODEL_API_KEY.
//   - REFERENCE_PROVIDER=fixture: the s1 demo registry rows; ph_fda: the live
//     PH FDA lookup with the configured User-Agent.
//
// Demo scenarios always run on the fixture providers and do not use these.
func NewFromConfig(cfg config.Config, opts ...FactoryOption) (Providers, error) {
	f := factory{}
	for _, o := range opts {
		o(&f)
	}
	p := Providers{ModelProvider: cfg.ModelProvider, ReferenceProvider: cfg.ReferenceProvider}

	switch cfg.ModelProvider {
	case config.ModelMock:
		p.Reader = NewMockReader()
		p.Explainer = MockExplainer{}
	case config.ModelMuseSpark:
		if cfg.ModelAPIKey.Reveal() == "" {
			return Providers{}, errors.New("ai: MODEL_API_KEY is required when MODEL_PROVIDER=muse_spark")
		}
		client, err := metaapi.New(cfg.ModelAPIKey.Reveal(), f.meta...)
		if err != nil {
			return Providers{}, err
		}
		muse := NewMuseSpark(client, MuseSparkOptions{OnError: f.onModelError})
		p.ModelID = MuseModel
		p.Reader = muse
		p.Explainer = muse
	default:
		return Providers{}, fmt.Errorf("ai: unknown MODEL_PROVIDER %q", cfg.ModelProvider)
	}

	switch cfg.ReferenceProvider {
	case config.ReferenceFixture:
		p.References = references.Fixture{ScenarioID: demo.UploadScenario}
	case config.ReferencePHFDA:
		o := references.PHFDAOptions{UserAgent: cfg.UserAgent()}
		if f.phfda != nil {
			f.phfda(&o)
		}
		p.References = references.NewPHFDA(o)
	default:
		return Providers{}, fmt.Errorf("ai: unknown REFERENCE_PROVIDER %q", cfg.ReferenceProvider)
	}
	return p, nil
}
