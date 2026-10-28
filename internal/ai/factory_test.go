package ai

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/medilens-ai/medilens/internal/config"
	"github.com/medilens-ai/medilens/internal/contracts"
	"github.com/medilens-ai/medilens/internal/demo"
	"github.com/medilens-ai/medilens/internal/metaapi"
	"github.com/medilens-ai/medilens/internal/references"
)

func env(m map[string]string) func(string) string { return func(k string) string { return m[k] } }

func load(t *testing.T, m map[string]string) config.Config {
	t.Helper()
	cfg, err := config.Load(env(m))
	if err != nil {
		t.Fatal(err)
	}
	return cfg
}

func TestDefaultProvidersAreTheLabelledMocks(t *testing.T) {
	p, err := NewFromConfig(load(t, nil))
	if err != nil {
		t.Fatal(err)
	}
	if p.ModelProvider != config.ModelMock || p.ModelID != "" || p.ReferenceProvider != config.ReferenceFixture || !p.Demo() {
		t.Errorf("providers %+v", p)
	}
	r, err := p.Reader.Read(bg, [][]byte{jpeg})
	if err != nil || !r.OK || r.Model != MockModel || jsonOf(t, r.Label) != jsonOf(t, scenario(t, demo.UploadScenario).Label) {
		t.Errorf("read %+v, %v", r, err)
	}
	if _, _, err := p.Explainer.Explain(bg, "Store in a cool dry place"); !errors.Is(err, ErrNoModel) {
		t.Errorf("explain: %v", err)
	}
	got := p.References.Search(bg, references.Query{Name: "anything", RegistrationNumber: "DR-XY1"})
	if jsonOf(t, got) != jsonOf(t, scenario(t, demo.UploadScenario).Reference) {
		t.Errorf("references %+v", got)
	}
}

// No silent fallback: Muse Spark without a key is an error, never the mock.
func TestMuseSparkWithoutAKeyIsAnError(t *testing.T) {
	p, err := NewFromConfig(config.Config{ModelProvider: config.ModelMuseSpark, ReferenceProvider: config.ReferenceFixture})
	if err == nil || !strings.Contains(err.Error(), "MODEL_API_KEY") {
		t.Errorf("err %v", err)
	}
	if p.Reader != nil || p.Explainer != nil || p.References != nil {
		t.Errorf("providers returned with the error: %+v", p)
	}
}

func TestUnknownProvidersAreErrors(t *testing.T) {
	for _, cfg := range []config.Config{
		{ModelProvider: "claude", ReferenceProvider: config.ReferenceFixture},
		{ModelProvider: "", ReferenceProvider: config.ReferenceFixture},
		{ModelProvider: config.ModelMock, ReferenceProvider: "live"},
	} {
		if p, err := NewFromConfig(cfg); err == nil || p.Reader != nil {
			t.Errorf("%+v: err %v", cfg, err)
		}
	}
}

func TestMuseSparkAndPHFDAAreWiredFromTheConfig(t *testing.T) {
	meta := newFakeMeta(t, reply(t, "label-ok"))
	var mu sync.Mutex
	var uas []string
	fda := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		uas = append(uas, r.Header.Get("User-Agent"))
		mu.Unlock()
		_, _ = w.Write([]byte(`{"cdrr":[],"fdawebsite":[]}`))
	}))
	defer fda.Close()
	cfg := load(t, map[string]string{
		"MODEL_PROVIDER":     "muse_spark",
		"MODEL_API_KEY":      "test-key-not-real",
		"REFERENCE_PROVIDER": "ph_fda",
		"PUBLIC_REPO_URL":    "https://github.com/example/medilens-ai",
	})
	p, err := NewFromConfig(cfg,
		WithMetaOptions(metaapi.WithBaseURL(meta.srv.URL), metaapi.WithSleep(noSleep)),
		WithPHFDAOptions(func(o *references.PHFDAOptions) { o.APIURL = fda.URL + "/api/search?q=" }),
	)
	if err != nil {
		t.Fatal(err)
	}
	if p.ModelProvider != config.ModelMuseSpark || p.ModelID != "muse-spark-1.3" || p.ReferenceProvider != config.ReferencePHFDA || p.Demo() {
		t.Errorf("providers %+v", p)
	}
	r, err := p.Reader.Read(bg, [][]byte{jpeg})
	if err != nil || !r.OK || r.Model != "muse-spark-1.3" {
		t.Errorf("read %+v, %v", r, err)
	}
	if len(meta.auth) != 1 || meta.auth[0] != "Bearer test-key-not-real" {
		t.Errorf("auth %v", meta.auth)
	}
	if res := p.References.Search(bg, references.Query{Name: "Paracelin"}); res.Kind != contracts.SearchOK {
		t.Errorf("search %+v", res)
	}
	if len(uas) != 1 || uas[0] != "MediLensAI/0.1 (+https://github.com/example/medilens-ai)" {
		t.Errorf("user agents %v", uas)
	}
}

// Results made with any fixture provider are demo data.
func TestAnyFixtureProviderMakesTheResultsDemo(t *testing.T) {
	p, err := NewFromConfig(load(t, map[string]string{"MODEL_PROVIDER": "muse_spark", "MODEL_API_KEY": "k"}))
	if err != nil || !p.Demo() || p.ModelID != "muse-spark-1.3" {
		t.Errorf("muse_spark + fixture: %+v, %v", p, err)
	}
	p, err = NewFromConfig(load(t, map[string]string{"REFERENCE_PROVIDER": "ph_fda"}))
	if err != nil || !p.Demo() {
		t.Errorf("mock + ph_fda: %+v, %v", p, err)
	}
	if _, ok := p.References.(*references.PHFDA); !ok {
		t.Errorf("references %T", p.References)
	}
}

func TestModelErrorsReachTheHook(t *testing.T) {
	meta := newFakeMeta(t, metaReply{status: 401})
	var got []RequestFailure
	p, err := NewFromConfig(load(t, map[string]string{"MODEL_PROVIDER": "muse_spark", "MODEL_API_KEY": "k"}),
		WithMetaOptions(metaapi.WithBaseURL(meta.srv.URL)),
		WithOnModelError(func(f RequestFailure) { got = append(got, f) }),
	)
	if err != nil {
		t.Fatal(err)
	}
	if r, _ := p.Reader.Read(bg, [][]byte{jpeg}); r.OK || len(got) != 1 || got[0] != (RequestFailure{"http_status", 401}) {
		t.Errorf("read %+v, errors %+v", r, got)
	}
}
