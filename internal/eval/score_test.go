package eval

import (
	"reflect"
	"strings"
	"testing"

	"github.com/medilens-ai/medilens/internal/contracts"
)

// The cases port apps/server/test/eval/score.test.ts (tag node-fallback-v1)
// one for one; the GroundTruth issue texts were printed by the Node build's
// GroundTruthSchema (zod 4.6.7) for the same inputs.

func baseTruth() GroundTruth {
	return GroundTruth{
		PackID:             "pack-01",
		Images:             []string{"front.jpg"},
		BrandName:          "Biogesic",
		GenericNames:       []string{"Paracetamol"},
		Strength:           "500 mg",
		DosageForm:         "Tablet",
		RegistrationNumber: contracts.Ptr("DR-XY12345"),
		ExpiryDate:         contracts.Ptr("2027-03"),
	}
}

type read struct {
	value      *string
	legibility contracts.Legibility
}

func clear(v string) read { return read{contracts.Ptr(v), contracts.LegibilityClear} }

func readAs(v *string, l contracts.Legibility) read { return read{v, l} }

// label is the faithful read with overrides, fields in the TS object order.
func label(overrides map[contracts.FieldKey]read) contracts.ExtractedLabel {
	order := []contracts.FieldKey{
		contracts.FieldBrandName, contracts.FieldGenericNames, contracts.FieldStrength,
		contracts.FieldDosageForm, contracts.FieldRegistrationNumber, contracts.FieldExpiryDate,
	}
	base := map[contracts.FieldKey]read{
		contracts.FieldBrandName:          clear("BIOGESIC®"),
		contracts.FieldGenericNames:       clear("Paracetamol"),
		contracts.FieldStrength:           clear("500 mg"),
		contracts.FieldDosageForm:         clear("tablet"),
		contracts.FieldRegistrationNumber: clear("DR-XY 12345"),
		contracts.FieldExpiryDate:         clear("EXP 03/2027"),
	}
	for k, v := range overrides {
		base[k] = v
	}
	l := contracts.ExtractedLabel{ImageKind: contracts.ImageKindLabel}
	for _, k := range order {
		r := base[k]
		l.Fields = append(l.Fields, contracts.LabelField{
			Key: k, Value: r.value, Legibility: r.legibility, EvidenceText: r.value, ImageIndex: contracts.Ptr(0),
		})
	}
	return l
}

func field(t *testing.T, results []FieldScore, key contracts.FieldKey) FieldScore {
	t.Helper()
	for _, r := range results {
		if r.Field == key {
			return r
		}
	}
	t.Fatalf("no result for %s", key)
	return FieldScore{}
}

func TestScoreLabelFaithfulRead(t *testing.T) {
	results := ScoreLabel(baseTruth(), label(nil))
	var fields []contracts.FieldKey
	for _, r := range results {
		fields = append(fields, r.Field)
		if !r.Correct || r.ConfidentlyWrong {
			t.Errorf("%s: %+v, want correct", r.Field, r)
		}
	}
	if !reflect.DeepEqual(fields, ScoredFields) {
		t.Fatalf("fields %v, want %v", fields, ScoredFields)
	}
}

func TestScoreLabelLegibility(t *testing.T) {
	tr := baseTruth()
	got := field(t, ScoreLabel(tr, label(map[contracts.FieldKey]read{contracts.FieldStrength: clear("250 mg")})), contracts.FieldStrength)
	want := FieldScore{Field: contracts.FieldStrength, Correct: false, Legibility: contracts.LegibilityClear, ConfidentlyWrong: true}
	if got != want {
		t.Errorf("wrong clear strength: %+v, want %+v", got, want)
	}
	for _, l := range []contracts.Legibility{contracts.LegibilityPartial, contracts.LegibilityUnreadable} {
		r := field(t, ScoreLabel(tr, label(map[contracts.FieldKey]read{contracts.FieldStrength: readAs(contracts.Ptr("250 mg"), l)})), contracts.FieldStrength)
		if r.Correct || r.ConfidentlyWrong {
			t.Errorf("wrong %s strength: %+v, want incorrect and not confidently wrong", l, r)
		}
	}
}

func TestScoreLabelStrength(t *testing.T) {
	tr := baseTruth()
	tr.Strength = "1 g"
	if r := field(t, ScoreLabel(tr, label(map[contracts.FieldKey]read{contracts.FieldStrength: clear("1000 mg")})), contracts.FieldStrength); !r.Correct {
		t.Errorf("1 g vs 1000 mg: %+v, want correct", r)
	}
	r := field(t, ScoreLabel(baseTruth(), label(map[contracts.FieldKey]read{contracts.FieldStrength: clear("5OO mg")})), contracts.FieldStrength)
	if r.Correct || !r.ConfidentlyWrong {
		t.Errorf("unparseable strength: %+v, want confidently wrong", r)
	}
}

func TestScoreLabelExpiry(t *testing.T) {
	tr := baseTruth()
	if r := field(t, ScoreLabel(tr, label(map[contracts.FieldKey]read{contracts.FieldExpiryDate: clear("EXP 03/2027")})), contracts.FieldExpiryDate); !r.Correct {
		t.Errorf("EXP 03/2027 vs 2027-03: %+v, want correct", r)
	}
	if r := field(t, ScoreLabel(tr, label(map[contracts.FieldKey]read{contracts.FieldExpiryDate: clear("04/2027")})), contracts.FieldExpiryDate); !r.ConfidentlyWrong {
		t.Errorf("04/2027: %+v, want confidently wrong", r)
	}
}

func TestScoreLabelNullTruth(t *testing.T) {
	tr := baseTruth()
	tr.ExpiryDate, tr.RegistrationNumber = nil, nil
	if r := field(t, ScoreLabel(tr, label(map[contracts.FieldKey]read{contracts.FieldExpiryDate: readAs(nil, contracts.LegibilityClear)})), contracts.FieldExpiryDate); !r.Correct {
		t.Errorf("null read of a null truth: %+v, want correct", r)
	}
	if r := field(t, ScoreLabel(tr, label(map[contracts.FieldKey]read{contracts.FieldRegistrationNumber: readAs(contracts.Ptr("DR-?"), contracts.LegibilityUnreadable)})), contracts.FieldRegistrationNumber); !r.Correct {
		t.Errorf("unreadable read of a null truth: %+v, want correct", r)
	}
	r := field(t, ScoreLabel(tr, label(map[contracts.FieldKey]read{contracts.FieldExpiryDate: clear("03/2027")})), contracts.FieldExpiryDate)
	if r.Correct || !r.ConfidentlyWrong {
		t.Errorf("invented expiry: %+v, want confidently wrong", r)
	}
}

func TestScoreLabelMissingField(t *testing.T) {
	l := label(nil)
	var kept []contracts.LabelField
	for _, f := range l.Fields {
		if f.Key != contracts.FieldBrandName {
			kept = append(kept, f)
		}
	}
	l.Fields = kept
	got := field(t, ScoreLabel(baseTruth(), l), contracts.FieldBrandName)
	want := FieldScore{Field: contracts.FieldBrandName, Correct: false, Legibility: contracts.LegibilityUnreadable, ConfidentlyWrong: false}
	if got != want {
		t.Errorf("missing field: %+v, want %+v", got, want)
	}
}

func TestScoreLabelGenericNames(t *testing.T) {
	tr := baseTruth()
	tr.GenericNames = []string{"Amoxicillin", "Clavulanic Acid"}
	if r := field(t, ScoreLabel(tr, label(map[contracts.FieldKey]read{contracts.FieldGenericNames: clear("clavulanic acid + AMOXICILLIN")})), contracts.FieldGenericNames); !r.Correct {
		t.Errorf("same set: %+v, want correct", r)
	}
	if r := field(t, ScoreLabel(tr, label(map[contracts.FieldKey]read{contracts.FieldGenericNames: clear("Amoxicillin")})), contracts.FieldGenericNames); r.Correct {
		t.Errorf("subset: %+v, want incorrect", r)
	}
	// the other separators of the split: , / ; & and the word "and"
	for _, v := range []string{"Clavulanic acid, Amoxicillin", "amoxicillin/clavulanic acid", "Amoxicillin ; Clavulanic Acid", "Amoxicillin & Clavulanic Acid", "Amoxicillin AND Clavulanic Acid"} {
		if r := field(t, ScoreLabel(tr, label(map[contracts.FieldKey]read{contracts.FieldGenericNames: clear(v)})), contracts.FieldGenericNames); !r.Correct {
			t.Errorf("%q: %+v, want correct", v, r)
		}
	}
	// "and" inside a word is not a separator
	tr.GenericNames = []string{"Sandoz"}
	if r := field(t, ScoreLabel(tr, label(map[contracts.FieldKey]read{contracts.FieldGenericNames: clear("SANDOZ")})), contracts.FieldGenericNames); !r.Correct {
		t.Errorf("Sandoz: %+v, want correct", r)
	}
}

func TestScoreLabelNormalizes(t *testing.T) {
	results := ScoreLabel(baseTruth(), label(map[contracts.FieldKey]read{
		contracts.FieldRegistrationNumber: clear("dr-xy12345"),
		contracts.FieldBrandName:          clear("Biogesic Tablet"),
		contracts.FieldDosageForm:         clear("Film-coated tablets"),
	}))
	for _, k := range []contracts.FieldKey{contracts.FieldRegistrationNumber, contracts.FieldBrandName, contracts.FieldDosageForm} {
		if r := field(t, results, k); !r.Correct {
			t.Errorf("%s: %+v, want correct", k, r)
		}
	}
}

func TestScoreLabelDosageForm(t *testing.T) {
	r := field(t, ScoreLabel(baseTruth(), label(map[contracts.FieldKey]read{contracts.FieldDosageForm: clear("Capsule")})), contracts.FieldDosageForm)
	if r.Correct || !r.ConfidentlyWrong {
		t.Errorf("capsule vs tablet: %+v, want confidently wrong", r)
	}
	tr := baseTruth()
	tr.DosageForm = "Eye drops"
	if r := field(t, ScoreLabel(tr, label(map[contracts.FieldKey]read{contracts.FieldDosageForm: clear("Ear Drops")})), contracts.FieldDosageForm); r.Correct {
		t.Errorf("ear vs eye drops: %+v, want incorrect", r)
	}
	if r := field(t, ScoreLabel(tr, label(map[contracts.FieldKey]read{contracts.FieldDosageForm: clear("eye drop")})), contracts.FieldDosageForm); !r.Correct {
		t.Errorf("eye drop vs eye drops: %+v, want correct", r)
	}
}

func TestParseMonthYear(t *testing.T) {
	for in, want := range map[string]MonthYear{
		"03/2027":       {3, 2027},
		"3-2027":        {3, 2027},
		"2027-03":       {3, 2027},
		"MAR 2027":      {3, 2027},
		"Exp. Mar 2027": {3, 2027},
		"EXP: 12/2026":  {12, 2026},
		// beyond the TS cases: full month names, an Expiry date: prefix,
		// JS whitespace (a no-break space) and spaces around the separator
		"expiry date: september 2026": {9, 2026},
		"EXP\u00a003 / 2027":          {3, 2027},
	} {
		got, ok := ParseMonthYear(in)
		if !ok || got != want {
			t.Errorf("ParseMonthYear(%q) = %v, %v; want %v", in, got, ok, want)
		}
	}
	for _, in := range []string{"13/2027", "2027", "March", "03/27", "MAR 2027 03/2028", "00/2027", "Mär 2027", "03.2027"} {
		if got, ok := ParseMonthYear(in); ok {
			t.Errorf("ParseMonthYear(%q) = %v; want rejected", in, got)
		}
	}
}

// recorded from the Node build: GroundTruthSchema.safeParse(v) issues,
// formatted as scripts/eval-labels.ts prints them
func TestValidateGroundTruth(t *testing.T) {
	const truthJSON = `"packId":"pack-01","images":["front.jpg"],"brandName":"Biogesic","genericNames":["Paracetamol"],"strength":"500 mg","dosageForm":"Tablet"`
	const tail = `,"registrationNumber":"DR-XY12345","expiryDate":"2027-03"`
	obj := func(fields string) string { return "{" + fields + "}" }
	with := func(key, value string) string {
		all := truthJSON + tail
		i := strings.Index(all, `"`+key+`":`)
		j := i + len(key) + 3
		depth := 0
		k := j
		for ; k < len(all); k++ {
			c := all[k]
			if c == '[' || c == '{' {
				depth++
			} else if c == ']' || c == '}' {
				depth--
			} else if c == ',' && depth == 0 {
				break
			}
		}
		return obj(all[:j] + value + all[k:])
	}
	without := func(key string) string {
		s := with(key, "0")
		return strings.Replace(s, `"`+key+`":0`, `"zz":0`, 1)
	}
	expMsg := `expiryDate: expiryDate must be a month and year, e.g. "03/2027", "2027-03" or "MAR 2027"`
	cases := []struct{ name, in, want string }{
		{"notobj", `5`, `: Invalid input: expected object, received number`},
		{"null", `null`, `: Invalid input: expected object, received null`},
		{"arr", `[]`, `: Invalid input: expected object, received array`},
		{"emptyStrength", with("strength", `"  "`), `strength: Too small: expected string to have >=1 characters; strength: strength must be parseable, e.g. "500 mg"`},
		{"numStrength", with("strength", `5`), `strength: Invalid input: expected string, received number`},
		{"missingPack", without("packId"), `packId: Invalid input: expected string, received undefined`},
		{"noImages", with("images", `[]`), `images: Too small: expected array to have >=1 items`},
		{"fourImages", with("images", `["a","b","c","d"]`), `images: Too big: expected array to have <=3 items`},
		{"imgEmpty", with("images", `["a"," "]`), `images.1: Too small: expected string to have >=1 characters`},
		{"imagesStr", with("images", `"a"`), `images: Invalid input: expected array, received string`},
		{"genericEmpty", with("genericNames", `[]`), `genericNames: Too small: expected array to have >=1 items`},
		{"regBad", with("registrationNumber", `"FR-1"`), `registrationNumber: registrationNumber must be a recognised registration number, e.g. "DR-XY12345"`},
		{"regMissing", without("registrationNumber"), `registrationNumber: Invalid input: expected string, received undefined`},
		{"expBad", with("expiryDate", `"03.2027"`), expMsg},
		{"expEmpty", with("expiryDate", `""`), `expiryDate: Too small: expected string to have >=1 characters; ` + expMsg},
		{"many", `{"packId":"","images":[1],"brandName":null,"genericNames":[""],"strength":"x","dosageForm":true,"registrationNumber":3,"expiryDate":"q"}`,
			`packId: Too small: expected string to have >=1 characters; images.0: Invalid input: expected string, received number; brandName: Invalid input: expected string, received null; genericNames.0: Too small: expected string to have >=1 characters; strength: strength must be parseable, e.g. "500 mg"; dosageForm: Invalid input: expected string, received boolean; registrationNumber: Invalid input: expected string, received number; ` + expMsg},
		{"imgOrder", with("images", `[" ",1,"c","d"]`), `images: Too big: expected array to have <=3 items`},
		{"genObj", with("genericNames", `[{},null,2.5]`), `genericNames.0: Invalid input: expected string, received object; genericNames.1: Invalid input: expected string, received null; genericNames.2: Invalid input: expected string, received number`},
		{"expNum", with("expiryDate", `2027`), `expiryDate: Invalid input: expected string, received number`},
		{"packObj", with("packId", `{"a":1}`), `packId: Invalid input: expected string, received object`},
	}
	for _, c := range cases {
		_, err := ParseGroundTruth([]byte(c.in))
		if err == nil {
			t.Errorf("%s: accepted %s", c.name, c.in)
			continue
		}
		if err.Error() != c.want {
			t.Errorf("%s:\n got %s\nwant %s", c.name, err.Error(), c.want)
		}
	}

	// trimmed values, an unknown key dropped
	got, err := ParseGroundTruth([]byte(with("brandName", `"  Bio  "`)[:len(with("brandName", `"  Bio  "`))-1] + `,"extra":1}`))
	if err != nil {
		t.Fatal(err)
	}
	want := baseTruth()
	want.BrandName = "Bio"
	if !reflect.DeepEqual(got, want) {
		t.Errorf("trimmed: %+v, want %+v", got, want)
	}
	// TS: accepts the base truth, EXP 03/2027 and null expiry or registration
	for _, in := range []string{obj(truthJSON + tail), with("expiryDate", `"EXP 03/2027"`), with("expiryDate", `null`), with("registrationNumber", `null`)} {
		if _, err := ParseGroundTruth([]byte(in)); err != nil {
			t.Errorf("rejected %s: %v", in, err)
		}
	}
	if _, err := ParseGroundTruth([]byte(with("strength", `"five hundred"`))); err == nil {
		t.Error("accepted an unparseable strength")
	}
	if _, err := ParseGroundTruth([]byte(`{"packId":`)); err == nil || err.Error() != "truth.json is not valid JSON" {
		t.Errorf("invalid JSON: %v", err)
	}
}

func TestSummarizeAndRender(t *testing.T) {
	tr := baseTruth()
	a := ScoreLabel(tr, label(map[contracts.FieldKey]read{contracts.FieldStrength: clear("250 mg")}))
	b := ScoreLabel(tr, label(map[contracts.FieldKey]read{contracts.FieldExpiryDate: readAs(nil, contracts.LegibilityUnreadable)}))
	s := Summarize([][]FieldScore{a, b})
	if s.Packs != 2 {
		t.Fatalf("packs %d", s.Packs)
	}
	var strength, expiry FieldSummary
	for _, f := range s.Fields {
		switch f.Field {
		case contracts.FieldStrength:
			strength = f
		case contracts.FieldExpiryDate:
			expiry = f
		}
	}
	if want := (FieldSummary{Field: contracts.FieldStrength, Total: 2, Correct: 1, Unreadable: 0, ConfidentlyWrong: 1}); strength != want {
		t.Errorf("strength %+v, want %+v", strength, want)
	}
	if expiry.Correct != 1 || expiry.Unreadable != 1 {
		t.Errorf("expiry %+v", expiry)
	}
	md := RenderResultsMarkdown(s, "2026-10-30", Run{Found: 2, Attempted: 2, Skipped: 0})
	if !strings.Contains(md, "| strength | 2 | 1 | 0 | 1 |") || strings.Contains(md, "pack-01") || strings.Contains(md, "250") {
		t.Errorf("markdown:\n%s", md)
	}
	if MeetsBar(s) {
		t.Error("a confidently-wrong strength meets the bar")
	}
	if !MeetsBar(Summarize([][]FieldScore{ScoreLabel(tr, label(nil))})) {
		t.Error("a faithful read misses the bar")
	}
}

// the whole document, byte for byte as the Node renderer writes it
func TestRenderResultsMarkdownExact(t *testing.T) {
	s := Summarize([][]FieldScore{ScoreLabel(baseTruth(), label(nil))})
	got := RenderResultsMarkdown(s, "2026-10-30", Run{Found: 4, Attempted: 3, Skipped: 2})
	want := strings.Join([]string{
		"# Label accuracy eval results",
		"",
		"Run date: 2026-10-30. Reader: live Muse Spark.",
		"",
		"Packs found: 4. Attempted: 3. Scored: 1. Skipped: 2. Not attempted (spend cap): 1.",
		"",
		"**Not a clean run:** the counts and the bar below cover the 1 scored packs only.",
		"",
		"Aggregate counts only. Photos, pack identities and read text stay on the owner's machine.",
		"",
		"| Field | Total | Correct | Unreadable | Confidently wrong |",
		"| --- | --- | --- | --- | --- |",
		"| brandName | 1 | 1 | 0 | 0 |",
		"| genericNames | 1 | 1 | 0 | 0 |",
		"| strength | 1 | 1 | 0 | 0 |",
		"| dosageForm | 1 | 1 | 0 | 0 |",
		"| registrationNumber | 1 | 1 | 0 | 0 |",
		"| expiryDate | 1 | 1 | 0 | 0 |",
		"",
		"Bar (zero confidently-wrong strengths or expiry dates): MET.",
		"",
	}, "\n")
	if got != want {
		t.Errorf("got:\n%s\nwant:\n%s", got, want)
	}
	clean := RenderResultsMarkdown(s, "2026-10-30", Run{Found: 1, Attempted: 1, Skipped: 0})
	if !strings.Contains(clean, "Packs found: 1. Attempted: 1. Scored: 1. Skipped: 0. Not attempted (spend cap): 0.") || strings.Contains(clean, "Not a clean run") {
		t.Errorf("clean run:\n%s", clean)
	}
}
