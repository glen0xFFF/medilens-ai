package references

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/medilens-ai/medilens/internal/contracts"
	"github.com/medilens-ai/medilens/internal/domain"
)

// Live PH FDA registry lookup (base spec §2, §5.4), a port of
// apps/server/src/providers/phFda.ts. Backend-only, honest User-Agent, 5 s
// timeout (headers and body), a 24 h cache of successful responses, and at
// most two fetches per search: the registration number first, then the name
// (for records when the number found nothing, or for advisories only when
// it found something).
//
// The search endpoint is UNDOCUMENTED: PH FDA publishes no API for it. It
// is the JSON endpoint behind the public verification page, so its shape
// can change without notice; any shape this code does not expect is
// "unavailable", never "no record".
//
// Response field names, confirmed against one real response on 2026-10-27
// (GET /api/search?q=biogesic, first 4 KB; recorded in the Node source):
//
//	top level: lto_food, lto_drugs, lto_medicaldevice, lto_healthrelateddevice,
//	  lto_pco, fdafoodproducts, cdrr, ... fdawebsite
//	cdrr rows: registration_number, generic_name, brand_name,
//	  dosage_strength_form, classification, packaging, manufacturer,
//	  country_of_origin, trader, importer, distributor, app_type,
//	  issuance_date, expiry_date, pharmacologic_category
//
// The fdawebsite rows were beyond the 4 KB captured, so their field names
// are NOT confirmed: `title` comes from the research memo; the link is the
// first of url / link / permalink / guid that the contract accepts. Until a
// live check confirms them (final review Minor 9), a non-empty fdawebsite
// list that maps to no advisory at all, or a row about this product whose
// link is unusable, flags AdvisoriesUnchecked, so a field-name mismatch is
// never read as "no advisory".
//
// expiry_date is the registration certificate's expiry, never the product's.

// PHFDAProvider is the provider name on every PH FDA record.
const PHFDAProvider = "ph-fda"

const (
	// DefaultPHFDATimeout bounds one fetch, response body included.
	DefaultPHFDATimeout = 5 * time.Second
	// DefaultPHFDACacheTTL is how long a successful lookup of a term is kept.
	DefaultPHFDACacheTTL = 24 * time.Hour

	phFDAAPIURL    = "https://verification.fda.gov.ph/api/search?q="
	phFDASourceURL = "https://verification.fda.gov.ph/?search="

	// maxPHFDABodyBytes bounds the memory one response may take (Go
	// hardening: Node read any size). A larger response is unavailable.
	maxPHFDABodyBytes = 16 << 20

	lookupFailed = "PH FDA lookup failed: "
)

var advisoryURLKeys = []string{"url", "link", "permalink", "guid"}

// PHFDAOptions configures NewPHFDA.
type PHFDAOptions struct {
	// UserAgent is the honest User-Agent sent with every request
	// (config.Config.UserAgent).
	UserAgent string
	// HTTPClient sends the requests; nil uses a plain http.Client. Its own
	// Timeout is not needed: each fetch has Timeout.
	HTTPClient *http.Client
	// Now is the clock for checkedAt and the cache; nil uses time.Now.
	Now func() time.Time
	// Timeout bounds one fetch; zero uses DefaultPHFDATimeout.
	Timeout time.Duration
	// CacheTTL is how long a successful lookup is cached; zero uses
	// DefaultPHFDACacheTTL.
	CacheTTL time.Duration
	// APIURL replaces the search URL prefix, for tests against a local
	// fake only; empty uses the PH FDA endpoint. Record source links always
	// point at the public PH FDA verification page.
	APIURL string
}

// PHFDA is the live registry provider. It is safe for concurrent use.
type PHFDA struct {
	userAgent string
	client    *http.Client
	now       func() time.Time
	timeout   time.Duration
	apiURL    string
	cache     *TTLCache[string, termResult]
}

// termResult is one successful lookup of one term: mapped records, every
// advisory row the contract accepts, the titles of rows that had a title
// but no link the contract accepts, and whether a non-empty advisory list
// mapped to nothing at all (field names not as expected). Cached; never
// handed out without a copy.
type termResult struct {
	records        []contracts.ReferenceRecord
	advisories     []contracts.Advisory
	unusableTitles []string
	unmappable     bool
}

// NewPHFDA makes the provider.
func NewPHFDA(o PHFDAOptions) *PHFDA {
	p := &PHFDA{
		userAgent: o.UserAgent,
		client:    o.HTTPClient,
		now:       o.Now,
		timeout:   o.Timeout,
		apiURL:    o.APIURL,
	}
	if p.client == nil {
		p.client = &http.Client{}
	}
	if p.now == nil {
		p.now = time.Now
	}
	if p.timeout <= 0 {
		p.timeout = DefaultPHFDATimeout
	}
	if p.apiURL == "" {
		p.apiURL = phFDAAPIURL
	}
	ttl := o.CacheTTL
	if ttl <= 0 {
		ttl = DefaultPHFDACacheTTL
	}
	p.cache = NewTTLCache[string, termResult](ttl, p.now, DefaultMaxEntries)
	return p
}

// text is a row value as a trimmed string, or nil for a non-string or an
// empty string.
func text(v any) *string {
	s, ok := v.(string)
	if !ok {
		return nil
	}
	t := domain.JSTrim(s)
	if t == "" {
		return nil
	}
	return &t
}

// mapRecord is a cdrr row as the contract's ReferenceRecordSchema accepts
// it, or false: a row that is not an object or has no registration number
// is dropped.
func mapRecord(row any, sourceURL, checkedAt string) (contracts.ReferenceRecord, bool) {
	m, ok := row.(map[string]any)
	if !ok {
		return contracts.ReferenceRecord{}, false
	}
	reg := text(m["registration_number"])
	src, srcOK := contracts.ParseHTTPURL(sourceURL)
	if reg == nil || !srcOK {
		return contracts.ReferenceRecord{}, false
	}
	return contracts.ReferenceRecord{
		Provider:           PHFDAProvider,
		SourceURL:          src,
		RegistrationNumber: *reg,
		BrandName:          text(m["brand_name"]),
		GenericName:        text(m["generic_name"]),
		StrengthForm:       text(m["dosage_strength_form"]),
		Manufacturer:       text(m["manufacturer"]),
		Classification:     text(m["classification"]),
		RegistrationExpiry: text(m["expiry_date"]),
		CheckedAt:          checkedAt,
	}, true
}

// mapAdvisory is an advisory row as the contract's AdvisorySchema accepts it
// (final review Minor 7: a link the WHATWG parser takes but the contract
// rejects, such as "https:/host/x" or "https://localhost/x", must not fail
// the whole scan), else the row's title when it has one as unusable, else
// nothing.
func mapAdvisory(row any) (advisory *contracts.Advisory, unusableTitle *string) {
	m, ok := row.(map[string]any)
	if !ok {
		return nil, nil
	}
	title := text(m["title"])
	if title == nil {
		return nil, nil
	}
	for _, key := range advisoryURLKeys {
		u := text(m[key])
		if u == nil {
			continue
		}
		if parsed, ok := contracts.ParseHTTPURL(*u); ok {
			return &contracts.Advisory{Title: *title, URL: parsed}, nil
		}
	}
	return nil, title
}

func mapAdvisories(rows []any) (advisories []contracts.Advisory, unusableTitles []string, unmappable bool) {
	for _, row := range rows {
		a, title := mapAdvisory(row)
		switch {
		case a != nil:
			advisories = append(advisories, *a)
		case title != nil:
			unusableTitles = append(unusableTitles, *title)
		}
	}
	// final review Minor 9: rows that map to nothing at all (no title under
	// the field names assumed above) are an unknown, never "no advisory"
	return advisories, unusableTitles, len(rows) > 0 && len(advisories) == 0
}

// parseJSON is JSON.parse of a response body read with res.text(): a
// leading UTF-8 BOM is dropped, a number too large for a float is not an
// error, and anything after the value is.
func parseJSON(body []byte) (any, bool) {
	dec := json.NewDecoder(bytes.NewReader(bytes.TrimPrefix(body, []byte("\xef\xbb\xbf"))))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil, false
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return nil, false
	}
	return v, true
}

// get fetches url within the timeout, response body included (a stalled
// body is a timeout too), and returns the body or the failure reason.
func (p *PHFDA) get(ctx context.Context, url string) ([]byte, string, bool) {
	ctx, cancel := context.WithTimeout(ctx, p.timeout)
	defer cancel()
	failed := func() string {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return lookupFailed + "timeout"
		}
		if ctx.Err() != nil {
			return lookupFailed + "canceled"
		}
		return lookupFailed + "fetch failed" // the message of a failed fetch() in Node
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, failed(), false
	}
	req.Header.Set("User-Agent", p.userAgent)
	req.Header.Set("Accept", "application/json")
	res, err := p.client.Do(req)
	if err != nil {
		return nil, failed(), false
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return nil, lookupFailed + "HTTP " + strconv.Itoa(res.StatusCode), false
	}
	body, err := io.ReadAll(io.LimitReader(res.Body, maxPHFDABodyBytes+1))
	if err != nil {
		return nil, failed(), false
	}
	if len(body) > maxPHFDABodyBytes {
		return nil, lookupFailed + "response too large", false
	}
	return body, "", true
}

// fetchTerm looks one term up, from the cache when it can. Only successful
// lookups are cached.
func (p *PHFDA) fetchTerm(ctx context.Context, term string) (termResult, string, bool) {
	if cached, ok := p.cache.Get(term); ok {
		return cached, "", true
	}
	encoded, ok := domain.EncodeURIComponent(term)
	if !ok {
		return termResult{}, lookupFailed + "URI malformed", false
	}
	body, reason, ok := p.get(ctx, p.apiURL+encoded)
	if !ok {
		return termResult{}, reason, false
	}
	v, ok := parseJSON(body)
	if !ok {
		return termResult{}, lookupFailed + "response was not JSON", false
	}
	obj, isObject := v.(map[string]any)
	cdrr, cdrrOK := obj["cdrr"].([]any)
	website, websiteOK := obj["fdawebsite"].([]any)
	if !isObject || !cdrrOK || !websiteOK {
		return termResult{}, lookupFailed + "unexpected response shape", false
	}

	checkedAt := contracts.FormatTime(p.now())
	value := termResult{}
	for _, row := range cdrr {
		if r, ok := mapRecord(row, phFDASourceURL+encoded, checkedAt); ok {
			value.records = append(value.records, r)
		}
	}
	value.advisories, value.unusableTitles, value.unmappable = mapAdvisories(website)
	p.cache.Set(term, value)
	return value, "", true
}

// Search looks the query up: at most two fetches, the registration number
// first. Advisory pages are keyed by product name, so a registration hit
// spends the second fetch on a name term for advisories only.
func (p *PHFDA) Search(ctx context.Context, q Query) contracts.SearchResult {
	reg := domain.NormalizeRegistrationNumber(q.RegistrationNumber)
	name := domain.NormalizeName(q.Name)
	var terms []string
	if reg != nil && *reg != "" {
		terms = append(terms, *reg)
	}
	if name != "" {
		terms = append(terms, name)
	}
	if len(terms) == 0 {
		return contracts.SearchResult{Kind: contracts.SearchNotAttempted}
	}

	first, reason, ok := p.fetchTerm(ctx, terms[0])
	if !ok {
		return contracts.SearchResult{Kind: contracts.SearchUnavailable, Reason: reason}
	}
	advisoryPool := slices.Clone(first.advisories)
	unusablePool := slices.Clone(first.unusableTitles)
	unchecked := first.unmappable

	// Brands of the first lookup's records. Only a registration hit makes
	// them this pack's brand; a name search can return other products.
	var recordBrands []string
	for _, r := range first.records {
		b := ""
		if r.BrandName != nil {
			b = domain.NormalizeName(*r.BrandName)
		}
		if b != "" && !slices.Contains(recordBrands, b) {
			recordBrands = append(recordBrands, b)
		}
	}
	records := first.records

	regFirst := reg != nil && terms[0] == *reg
	if regFirst {
		if len(first.records) == 0 {
			if name != "" {
				second, reason, ok := p.fetchTerm(ctx, name)
				if !ok {
					return contracts.SearchResult{Kind: contracts.SearchUnavailable, Reason: reason}
				}
				records = second.records
				advisoryPool = append(advisoryPool, second.advisories...)
				unusablePool = append(unusablePool, second.unusableTitles...)
				unchecked = unchecked || second.unmappable
			}
		} else {
			advisoryTerm := name
			if advisoryTerm == "" && len(recordBrands) > 0 {
				advisoryTerm = recordBrands[0]
			}
			if advisoryTerm == "" {
				unchecked = true
			} else {
				// Records stay from the registration hit; a failed advisory
				// lookup is flagged, never silently read as "no advisory".
				second, _, ok := p.fetchTerm(ctx, advisoryTerm)
				if ok {
					advisoryPool = append(advisoryPool, second.advisories...)
					unusablePool = append(unusablePool, second.unusableTitles...)
					unchecked = unchecked || second.unmappable
				} else {
					unchecked = true
				}
			}
		}
	}

	regHit := regFirst && len(first.records) > 0
	var brands []string
	if name != "" {
		brands = append(brands, name)
	}
	if regHit {
		for _, b := range recordBrands {
			if !slices.Contains(brands, b) {
				brands = append(brands, b)
			}
		}
	}
	aboutProduct := func(title string) bool {
		lower := domain.JSLower(title)
		return slices.ContainsFunc(brands, func(b string) bool { return strings.Contains(lower, b) })
	}
	// An advisory about this product whose link the contract rejects is
	// dropped, so the advisories are flagged unchecked, never "none" (Minor 7).
	if slices.ContainsFunc(unusablePool, aboutProduct) {
		unchecked = true
	}
	advisories := []contracts.Advisory{}
	for _, a := range advisoryPool {
		if !aboutProduct(a.Title) || slices.Contains(advisories, a) {
			continue
		}
		advisories = append(advisories, a)
	}
	return contracts.SearchResult{
		Kind:                contracts.SearchOK,
		Records:             cloneRecords(records),
		Advisories:          advisories,
		AdvisoriesUnchecked: unchecked,
	}
}

// cloneRecords copies records and every value they point to, so a caller
// can never change a cached lookup.
func cloneRecords(rs []contracts.ReferenceRecord) []contracts.ReferenceRecord {
	out := make([]contracts.ReferenceRecord, len(rs))
	for i, r := range rs {
		r.BrandName = cloneString(r.BrandName)
		r.GenericName = cloneString(r.GenericName)
		r.StrengthForm = cloneString(r.StrengthForm)
		r.Manufacturer = cloneString(r.Manufacturer)
		r.Classification = cloneString(r.Classification)
		r.RegistrationExpiry = cloneString(r.RegistrationExpiry)
		out[i] = r
	}
	return out
}

func cloneString(s *string) *string {
	if s == nil {
		return nil
	}
	return contracts.Ptr(*s)
}
