package references

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/medilens-ai/medilens/internal/contracts"
	"github.com/medilens-ai/medilens/internal/parity"
)

/* Synthetic PH FDA search response (DEMO DATA, fictional products), the
   Node test fixture recorded under fixtures/parity/providers. No network:
   every test talks to an httptest server on loopback. */

const ua = "MediLensAI/0.1 (+https://github.com/medilens-ai)"

var t0 = time.Date(2026, 10, 27, 8, 0, 0, 0, time.UTC)

const day = 24 * time.Hour

func fixtureBody(t *testing.T) string {
	t.Helper()
	dir, err := parity.Dir()
	if err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(filepath.Join(dir, "providers", "phfda", "search-paracelin.json"))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

const emptyBody = `{"cdrr":[],"fdawebsite":[]}`

// reply is one canned PH FDA response: a status and body, a request that
// hangs until the client gives up, or a connection dropped mid-request.
type reply struct {
	status int
	body   string
	hang   bool
	reset  bool
}

func ok200(body string) reply { return reply{status: 200, body: body} }

type call struct {
	uri, method, ua, accept string
}

// fakeFDA serves the queued replies in order; the last one repeats (as the
// Node tests' fakeFetch).
type fakeFDA struct {
	srv     *httptest.Server
	mu      sync.Mutex
	replies []reply
	calls   []call
}

func newFakeFDA(t *testing.T, replies ...reply) *fakeFDA {
	t.Helper()
	f := &fakeFDA{replies: replies}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		f.calls = append(f.calls, call{r.URL.RequestURI(), r.Method, r.Header.Get("User-Agent"), r.Header.Get("Accept")})
		next := f.replies[0]
		if len(f.replies) > 1 {
			f.replies = f.replies[1:]
		}
		f.mu.Unlock()
		switch {
		case next.hang:
			<-r.Context().Done()
		case next.reset:
			conn, _, err := w.(http.Hijacker).Hijack()
			if err == nil {
				conn.Close()
			}
		default:
			w.WriteHeader(next.status)
			_, _ = w.Write([]byte(next.body))
		}
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeFDA) uris() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []string
	for _, c := range f.calls {
		out = append(out, c.uri)
	}
	return out
}

func (f *fakeFDA) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.calls)
}

type setup struct {
	provider *PHFDA
	fake     *fakeFDA
	clk      *clock
}

func newSetup(t *testing.T, replies ...reply) setup {
	t.Helper()
	fake := newFakeFDA(t, replies...)
	clk := &clock{t: t0}
	p := NewPHFDA(PHFDAOptions{
		UserAgent: ua,
		Now:       clk.now,
		APIURL:    fake.srv.URL + "/api/search?q=",
		Timeout:   2 * time.Second,
	})
	return setup{p, fake, clk}
}

func search(t *testing.T, p Provider, q Query) contracts.SearchResult {
	t.Helper()
	return p.Search(context.Background(), q)
}

func mustOK(t *testing.T, r contracts.SearchResult) contracts.SearchResult {
	t.Helper()
	if r.Kind != contracts.SearchOK {
		t.Fatalf("kind %s (%s), want ok", r.Kind, r.Reason)
	}
	return r
}

func jsonEq(t *testing.T, where string, got, want any) {
	t.Helper()
	g, _ := json.Marshal(got)
	w, _ := json.Marshal(want)
	gn, err := parity.Normalize(g)
	if err != nil {
		t.Fatal(err)
	}
	wn, err := parity.Normalize(w)
	if err != nil {
		t.Fatal(err)
	}
	if string(gn) != string(wn) {
		t.Errorf("%s:\n got %s\nwant %s", where, gn, wn)
	}
}

func withBody(t *testing.T, base string, key string, value any) string {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal([]byte(base), &m); err != nil {
		t.Fatal(err)
	}
	m[key] = value
	b, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestPHFDAConstants(t *testing.T) {
	if DefaultPHFDATimeout != 5*time.Second || DefaultPHFDACacheTTL != 24*time.Hour {
		t.Errorf("timeout %v, cache TTL %v; want 5s and 24h", DefaultPHFDATimeout, DefaultPHFDACacheTTL)
	}
	if PHFDAProvider != "ph-fda" {
		t.Errorf("provider name %q", PHFDAProvider)
	}
}

func TestPHFDAMapsTheFixtureRowsAndDropsInvalidRows(t *testing.T) {
	s := newSetup(t, ok200(fixtureBody(t)))
	r := mustOK(t, search(t, s.provider, Query{Name: "Paracelin"}))
	// the third row has no registration number and is dropped
	if len(r.Records) != 2 {
		t.Fatalf("%d records", len(r.Records))
	}
	for _, rec := range r.Records {
		if u, ok := contracts.ParseHTTPURL(rec.SourceURL); !ok || u != rec.SourceURL {
			t.Errorf("sourceUrl %q fails the contract", rec.SourceURL)
		}
	}
	jsonEq(t, "first record", r.Records[0], contracts.ReferenceRecord{
		Provider:           "ph-fda",
		SourceURL:          "https://verification.fda.gov.ph/?search=paracelin",
		RegistrationNumber: "DR-XY99001",
		BrandName:          contracts.Ptr("Paracelin"),
		GenericName:        contracts.Ptr("Paracetamol"),
		StrengthForm:       contracts.Ptr("500 mg Tablet"),
		Manufacturer:       contracts.Ptr("Demo Fictional Pharma, Inc."),
		Classification:     contracts.Ptr("Over-the-Counter (OTC) Drug"),
		RegistrationExpiry: contracts.Ptr("01 January 2030"),
		CheckedAt:          "2026-10-27T08:00:00.000Z",
	})
	if got := s.fake.uris(); !slices.Equal(got, []string{"/api/search?q=paracelin"}) {
		t.Errorf("calls %v", got)
	}
}

func TestPHFDAAdvisoriesBrandInTitleCaseInsensitiveHTTPURLOnly(t *testing.T) {
	s := newSetup(t, ok200(fixtureBody(t)))
	r := mustOK(t, search(t, s.provider, Query{Name: "PARACELIN"}))
	jsonEq(t, "advisories", r.Advisories, []contracts.Advisory{{
		Title: "FDA Advisory No.2099-0001 || Public Health Warning Against the Purchase and Use of the Counterfeit Drug Product 'Paracetamol (PARACELIN) 500 mg Tablet'",
		URL:   "https://www.fda.gov.ph/fda-advisory-no-2099-0001-demo/",
	}})
}

func TestPHFDASendsTheHonestUserAgentAndAcceptsJSON(t *testing.T) {
	s := newSetup(t, ok200(fixtureBody(t)))
	search(t, s.provider, Query{Name: "Paracelin"})
	c := s.fake.calls[0]
	if c.ua != ua || c.method != http.MethodGet || c.accept != "application/json" {
		t.Errorf("call %+v", c)
	}
}

func TestPHFDARegistrationNumberFirstThenAdvisoriesByName(t *testing.T) {
	s := newSetup(t, ok200(fixtureBody(t)))
	r := mustOK(t, search(t, s.provider, Query{RegistrationNumber: "dr-xy 99001", Name: "Paracelin"}))
	if got := s.fake.uris(); !slices.Equal(got, []string{"/api/search?q=DR-XY99001", "/api/search?q=paracelin"}) {
		t.Errorf("calls %v", got)
	}
	if r.Records[0].SourceURL != "https://verification.fda.gov.ph/?search=DR-XY99001" {
		t.Errorf("sourceUrl %q", r.Records[0].SourceURL)
	}
	// the same advisory in both responses is reported once
	if len(r.Advisories) != 1 {
		t.Errorf("%d advisories", len(r.Advisories))
	}
	// final review Minor 7: the Paracelin row with a javascript: link is
	// dropped, so advisories about this product are not all known
	if !r.AdvisoriesUnchecked {
		t.Error("advisories not flagged unchecked")
	}
}

func TestPHFDARegHitWithNoAdvisoriesStillSurfacesTheNameLookupAdvisory(t *testing.T) {
	body := fixtureBody(t)
	regOnly := withBody(t, body, "fdawebsite", []any{})
	nameBody := withBody(t, body, "cdrr", []any{})
	s := newSetup(t, ok200(regOnly), ok200(nameBody))
	r := mustOK(t, search(t, s.provider, Query{RegistrationNumber: "DR-XY99001", Name: "Paracelin"}))
	if got := s.fake.uris(); len(got) != 2 || got[1] != "/api/search?q=paracelin" {
		t.Errorf("calls %v", got)
	}
	// records come from the registration hit only
	if len(r.Records) != 2 {
		t.Fatalf("%d records", len(r.Records))
	}
	for _, rec := range r.Records {
		if !strings.HasSuffix(rec.SourceURL, "?search=DR-XY99001") {
			t.Errorf("sourceUrl %q", rec.SourceURL)
		}
	}
	if len(r.Advisories) != 1 || !strings.Contains(r.Advisories[0].Title, "Counterfeit") {
		t.Errorf("advisories %+v", r.Advisories)
	}
}

func TestPHFDARegOnlyQueryUsesTheRecordBrandForTheAdvisoryFetch(t *testing.T) {
	regOnly := withBody(t, fixtureBody(t), "fdawebsite", []any{})
	s := newSetup(t, ok200(regOnly), ok200(fixtureBody(t)))
	r := mustOK(t, search(t, s.provider, Query{RegistrationNumber: "DR-XY99001"}))
	if got := s.fake.uris(); !slices.Equal(got, []string{"/api/search?q=DR-XY99001", "/api/search?q=paracelin"}) {
		t.Errorf("calls %v", got)
	}
	if len(r.Advisories) != 1 {
		t.Errorf("%d advisories", len(r.Advisories))
	}
}

func TestPHFDARegHitButTheAdvisoryFetchFailsIsFlagged(t *testing.T) {
	regOnly := withBody(t, fixtureBody(t), "fdawebsite", []any{})
	s := newSetup(t, ok200(regOnly), reply{status: 503, body: "down"})
	r := mustOK(t, search(t, s.provider, Query{RegistrationNumber: "DR-XY99001", Name: "Paracelin"}))
	if s.fake.count() != 2 || len(r.Records) != 2 || len(r.Advisories) != 0 || !r.AdvisoriesUnchecked {
		t.Errorf("calls %d, result %+v", s.fake.count(), r)
	}
}

func TestPHFDAFallsBackToTheNameWhenTheRegistrationNumberFindsNothing(t *testing.T) {
	s := newSetup(t, ok200(emptyBody), ok200(fixtureBody(t)))
	r := mustOK(t, search(t, s.provider, Query{RegistrationNumber: "DR-XY12345", Name: "Paracelin"}))
	if got := s.fake.uris(); !slices.Equal(got, []string{"/api/search?q=DR-XY12345", "/api/search?q=paracelin"}) {
		t.Errorf("calls %v", got)
	}
	if len(r.Records) != 2 {
		t.Errorf("%d records", len(r.Records))
	}
}

func TestPHFDANeverMoreThanTwoFetches(t *testing.T) {
	s := newSetup(t, ok200(emptyBody))
	r := search(t, s.provider, Query{RegistrationNumber: "DR-1", Name: "Nothingfound"})
	if s.fake.count() != 2 {
		t.Errorf("%d fetches", s.fake.count())
	}
	jsonEq(t, "result", r, map[string]any{"kind": "ok", "records": []any{}, "advisories": []any{}})
}

func TestPHFDAAdvisoryBrandFallsBackToRecordBrandNames(t *testing.T) {
	s := newSetup(t, ok200(fixtureBody(t)))
	r := mustOK(t, search(t, s.provider, Query{RegistrationNumber: "DR-XY99001"}))
	if len(r.Advisories) != 1 {
		t.Errorf("%d advisories", len(r.Advisories))
	}
}

func TestPHFDANoUsableQueryIsNotAttempted(t *testing.T) {
	s := newSetup(t, ok200(fixtureBody(t)))
	for _, q := range []Query{{}, {RegistrationNumber: "garbage", Name: "  "}} {
		jsonEq(t, "not attempted", search(t, s.provider, q), map[string]any{"kind": "not_attempted"})
	}
	if s.fake.count() != 0 {
		t.Errorf("%d fetches", s.fake.count())
	}
}

func TestPHFDAEmptyCdrrIsOKWithZeroRecords(t *testing.T) {
	s := newSetup(t, ok200(emptyBody))
	jsonEq(t, "result", search(t, s.provider, Query{Name: "Paracelin"}),
		map[string]any{"kind": "ok", "records": []any{}, "advisories": []any{}})
}

func TestPHFDACachesForTheTTL(t *testing.T) {
	s := newSetup(t, ok200(fixtureBody(t)))
	search(t, s.provider, Query{Name: "Paracelin"})
	s.clk.t = t0.Add(day - time.Millisecond)
	again := mustOK(t, search(t, s.provider, Query{Name: " paracelin "}))
	if s.fake.count() != 1 || len(again.Records) != 2 {
		t.Errorf("fetches %d, records %d", s.fake.count(), len(again.Records))
	}
	s.clk.t = t0.Add(day)
	search(t, s.provider, Query{Name: "Paracelin"})
	if s.fake.count() != 2 {
		t.Errorf("after the TTL: %d fetches, want 2", s.fake.count())
	}
}

func TestPHFDAUnavailableResultsAreNotCached(t *testing.T) {
	s := newSetup(t, reply{status: 500, body: "oops"}, ok200(fixtureBody(t)))
	if k := search(t, s.provider, Query{Name: "Paracelin"}).Kind; k != contracts.SearchUnavailable {
		t.Errorf("first: %s", k)
	}
	if k := search(t, s.provider, Query{Name: "Paracelin"}).Kind; k != contracts.SearchOK {
		t.Errorf("second: %s", k)
	}
	if s.fake.count() != 2 {
		t.Errorf("%d fetches", s.fake.count())
	}
}

func TestPHFDATimeoutIsUnavailable(t *testing.T) {
	fake := newFakeFDA(t, reply{hang: true})
	p := NewPHFDA(PHFDAOptions{UserAgent: ua, Now: func() time.Time { return t0 }, APIURL: fake.srv.URL + "/api/search?q=", Timeout: 100 * time.Millisecond})
	start := time.Now()
	r := p.Search(context.Background(), Query{Name: "Paracelin"})
	if r.Kind != contracts.SearchUnavailable || r.Reason != "PH FDA lookup failed: timeout" {
		t.Errorf("result %+v", r)
	}
	if fake.count() != 1 {
		t.Errorf("%d fetches", fake.count())
	}
	if d := time.Since(start); d > 2*time.Second {
		t.Errorf("took %v", d)
	}
}

// A body that stalls after the headers is a timeout too (the Node body read
// is inside the timeout race).
func TestPHFDAStalledBodyIsATimeout(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
		_, _ = w.Write([]byte(`{"cdrr":[`))
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	defer srv.Close()
	p := NewPHFDA(PHFDAOptions{UserAgent: ua, Now: func() time.Time { return t0 }, APIURL: srv.URL + "/api/search?q=", Timeout: 100 * time.Millisecond})
	r := p.Search(context.Background(), Query{Name: "Paracelin"})
	if r.Kind != contracts.SearchUnavailable || r.Reason != "PH FDA lookup failed: timeout" {
		t.Errorf("result %+v", r)
	}
}

func TestPHFDAHTTPErrorsAreUnavailableAndNotRetried(t *testing.T) {
	for _, status := range []int{403, 429, 500} {
		s := newSetup(t, reply{status: status, body: emptyBody})
		r := search(t, s.provider, Query{RegistrationNumber: "DR-XY99001", Name: "Paracelin"})
		if r.Kind != contracts.SearchUnavailable {
			t.Errorf("HTTP %d: %s", status, r.Kind)
		}
		if want := "PH FDA lookup failed: HTTP " + itoa(status); r.Reason != want {
			t.Errorf("reason %q, want %q", r.Reason, want)
		}
		// a failed lookup is not retried under the other term
		if s.fake.count() != 1 {
			t.Errorf("HTTP %d: %d fetches", status, s.fake.count())
		}
	}
}

func itoa(i int) string {
	b, _ := json.Marshal(i)
	return string(b)
}

func TestPHFDANetworkErrorIsUnavailable(t *testing.T) {
	s := newSetup(t, reply{reset: true})
	r := search(t, s.provider, Query{Name: "Paracelin"})
	if r.Kind != contracts.SearchUnavailable || r.Reason != "PH FDA lookup failed: fetch failed" {
		t.Errorf("result %+v", r)
	}
}

func TestPHFDAHTMLBodyIsUnavailable(t *testing.T) {
	s := newSetup(t, ok200("<!doctype html><html><body>Blocked</body></html>"))
	r := search(t, s.provider, Query{Name: "Paracelin"})
	if r.Kind != contracts.SearchUnavailable || r.Reason != "PH FDA lookup failed: response was not JSON" {
		t.Errorf("result %+v", r)
	}
}

func TestPHFDAUnexpectedShapesAreUnavailable(t *testing.T) {
	for name, body := range map[string]string{
		"no arrays":          `{"message":"ok"}`,
		"cdrr not an array":  `{"cdrr":{},"fdawebsite":[]}`,
		"fdawebsite missing": `{"cdrr":[]}`,
		"JSON array":         `[]`,
		"JSON null":          `null`,
		"trailing data":      `{"cdrr":[],"fdawebsite":[]} x`,
	} {
		s := newSetup(t, ok200(body))
		r := search(t, s.provider, Query{Name: "Paracelin"})
		if r.Kind != contracts.SearchUnavailable {
			t.Errorf("%s: %s", name, r.Kind)
		}
	}
	s := newSetup(t, ok200(`{"message":"ok"}`))
	if r := search(t, s.provider, Query{Name: "Paracelin"}); r.Reason != "PH FDA lookup failed: unexpected response shape" {
		t.Errorf("reason %q", r.Reason)
	}
}

/* ------------------------------------------------- final review fixes */

var goodAdvisory = contracts.Advisory{Title: "Counterfeit Paracelin notice", URL: "https://www.fda.gov.ph/ok-demo"}

// final review Minor 7: an advisory row the contract rejects is dropped,
// never a failed scan.
func TestPHFDAAdvisoryRowTheContractRejectsIsDroppedAndFlagged(t *testing.T) {
	for _, url := range []string{"https:/www.fda.gov.ph/x", "https://localhost/x", "http://10.0.0.1/a"} {
		body, _ := json.Marshal(map[string]any{
			"cdrr":       []any{},
			"fdawebsite": []any{map[string]string{"title": "Recall of Paracelin 500", "url": url}, goodAdvisory},
		})
		s := newSetup(t, ok200(string(body)))
		r := mustOK(t, search(t, s.provider, Query{Name: "Paracelin"}))
		jsonEq(t, url, r.Advisories, []contracts.Advisory{goodAdvisory})
		for _, a := range r.Advisories {
			if u, ok := contracts.ParseHTTPURL(a.URL); !ok || u != a.URL {
				t.Errorf("%s: advisory url %q fails the contract", url, a.URL)
			}
		}
		if !r.AdvisoriesUnchecked {
			t.Errorf("%s: not flagged", url)
		}
	}
}

func TestPHFDAProductRowWithARejectedLinkFlagsUnchecked(t *testing.T) {
	body := `{"cdrr":[],"fdawebsite":[{"title":"Counterfeit Paracelin 500 warning","url":"https://localhost/x"}]}`
	s := newSetup(t, ok200(body))
	r := mustOK(t, search(t, s.provider, Query{Name: "Paracelin"}))
	if len(r.Advisories) != 0 || !r.AdvisoriesUnchecked {
		t.Errorf("result %+v", r)
	}
}

// The link is the first of url, link, permalink, guid that the contract
// accepts, as the contract outputs it (tab and newline removed).
func TestPHFDAAdvisoryLinkKeysAndContractOutput(t *testing.T) {
	body := `{"cdrr":[],"fdawebsite":[` +
		`{"title":"Paracelin A","url":"javascript:alert(1)","link":"https://www.fda.gov.ph/a"},` +
		`{"title":"Paracelin B","permalink":"  https://www.fda.gov.ph/b\n  "},` +
		`{"title":"Paracelin C","guid":"https://www.fda.gov.ph/c\td"},` +
		`{"title":"  ","url":"https://www.fda.gov.ph/blank-title"},` +
		`"not a row",null,[1,2]` +
		`]}`
	s := newSetup(t, ok200(body))
	r := mustOK(t, search(t, s.provider, Query{Name: "Paracelin"}))
	jsonEq(t, "advisories", r.Advisories, []contracts.Advisory{
		{Title: "Paracelin A", URL: "https://www.fda.gov.ph/a"},
		{Title: "Paracelin B", URL: "https://www.fda.gov.ph/b"},
		{Title: "Paracelin C", URL: "https://www.fda.gov.ph/cd"},
	})
	if r.AdvisoriesUnchecked {
		t.Error("flagged unchecked with every titled row mapped")
	}
}

// final review Minor 9: advisory rows that cannot be mapped are flagged,
// never read as none.
func TestPHFDARowsWithNoTitleFlagUnchecked(t *testing.T) {
	body := `{"cdrr":[],"fdawebsite":[{"name":"Counterfeit Paracelin 500","link":"https://www.fda.gov.ph/a"}]}`
	s := newSetup(t, ok200(body))
	r := mustOK(t, search(t, s.provider, Query{Name: "Paracelin"}))
	if len(r.Advisories) != 0 || !r.AdvisoriesUnchecked {
		t.Errorf("result %+v", r)
	}
}

func TestPHFDATheFlagIsKeptForACachedLookup(t *testing.T) {
	s := newSetup(t, ok200(`{"cdrr":[],"fdawebsite":[{"heading":"Paracelin"}]}`))
	search(t, s.provider, Query{Name: "Paracelin"})
	r := search(t, s.provider, Query{Name: "Paracelin"})
	if s.fake.count() != 1 || !r.AdvisoriesUnchecked {
		t.Errorf("fetches %d, result %+v", s.fake.count(), r)
	}
}

func TestPHFDAEmptyAdvisoryListIsNoAdvisoryNotUnchecked(t *testing.T) {
	s := newSetup(t, ok200(emptyBody))
	if r := mustOK(t, search(t, s.provider, Query{Name: "Paracelin"})); r.AdvisoriesUnchecked {
		t.Error("flagged unchecked")
	}
}

func TestPHFDAMappedRowsAboutOtherProductsAreNoAdvisory(t *testing.T) {
	s := newSetup(t, ok200(`{"cdrr":[],"fdawebsite":[{"title":"Recall of Fictivex","url":"https://www.fda.gov.ph/f"}]}`))
	if r := mustOK(t, search(t, s.provider, Query{Name: "Paracelin"})); r.AdvisoriesUnchecked || len(r.Advisories) != 0 {
		t.Errorf("result %+v", r)
	}
}

/* --------------------------------------------------------- Go specifics */

// A returned result never shares memory with the cache.
func TestPHFDAReturnsCopies(t *testing.T) {
	s := newSetup(t, ok200(fixtureBody(t)))
	a := mustOK(t, search(t, s.provider, Query{Name: "Paracelin"}))
	*a.Records[0].BrandName = "changed"
	a.Records[1].RegistrationNumber = "changed"
	a.Advisories[0].Title = "changed"
	b := mustOK(t, search(t, s.provider, Query{Name: "Paracelin"}))
	if *b.Records[0].BrandName != "Paracelin" || b.Records[1].RegistrationNumber != "DRHR-99002" ||
		!strings.HasPrefix(b.Advisories[0].Title, "FDA Advisory No.2099-0001") {
		t.Error("a change to a returned result reached the cache")
	}
	if s.fake.count() != 1 {
		t.Errorf("%d fetches", s.fake.count())
	}
}

// res.text() drops a UTF-8 BOM, and JSON.parse takes a number too large for
// a float as Infinity rather than failing.
func TestPHFDABodyQuirks(t *testing.T) {
	body := "\xef\xbb\xbf" + `{"cdrr":[{"registration_number":"DR-XY99001","brand_name":"Paracelin","count":1e999}],"fdawebsite":[]}`
	s := newSetup(t, ok200(body))
	r := mustOK(t, search(t, s.provider, Query{Name: "Paracelin"}))
	if len(r.Records) != 1 {
		t.Errorf("records %+v", r.Records)
	}
}

func TestPHFDAOversizedBodyIsUnavailable(t *testing.T) {
	big := `{"cdrr":[],"fdawebsite":[],"pad":"` + strings.Repeat("x", maxPHFDABodyBytes) + `"}`
	s := newSetup(t, ok200(big))
	if r := search(t, s.provider, Query{Name: "Paracelin"}); r.Kind != contracts.SearchUnavailable {
		t.Errorf("result kind %s", r.Kind)
	}
}

// Row values: a non-string is null, whitespace is trimmed, an empty string
// is null; a non-object row is dropped.
func TestPHFDARecordFieldMapping(t *testing.T) {
	body := `{"cdrr":[` +
		`{"registration_number":"  DR-XY99001 ","brand_name":"","generic_name":7,"dosage_strength_form":null,"manufacturer":" M "},` +
		`{"registration_number":42},"row",null,[],` +
		`{"registration_number":"   "}` +
		`],"fdawebsite":[]}`
	s := newSetup(t, ok200(body))
	r := mustOK(t, search(t, s.provider, Query{Name: "Paracelin"}))
	want := []contracts.ReferenceRecord{{
		Provider:           "ph-fda",
		SourceURL:          "https://verification.fda.gov.ph/?search=paracelin",
		RegistrationNumber: "DR-XY99001",
		Manufacturer:       contracts.Ptr("M"),
		CheckedAt:          "2026-10-27T08:00:00.000Z",
	}}
	if !reflect.DeepEqual(r.Records, want) {
		jsonEq(t, "records", r.Records, want)
	}
}

// A search term is sent and linked encodeURIComponent-encoded.
func TestPHFDAEncodesTheTerm(t *testing.T) {
	s := newSetup(t, ok200(`{"cdrr":[{"registration_number":"DR-1"}],"fdawebsite":[]}`))
	r := mustOK(t, search(t, s.provider, Query{Name: "Para Celin & Co"}))
	if got := s.fake.uris(); !slices.Equal(got, []string{"/api/search?q=para%20celin%20%26%20co"}) {
		t.Errorf("calls %v", got)
	}
	if r.Records[0].SourceURL != "https://verification.fda.gov.ph/?search=para%20celin%20%26%20co" {
		t.Errorf("sourceUrl %q", r.Records[0].SourceURL)
	}
}
