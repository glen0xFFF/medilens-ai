package imaging

import (
	"encoding/json"
	"image"
	"math"
	"slices"
	"testing"

	"github.com/medilens-ai/medilens/internal/contracts"
)

// quality.test.ts "has the agreed starting values", against the recording.
func TestDefaultThresholdsMatchNode(t *testing.T) {
	ref := loadReference(t).Thresholds
	want := Thresholds{MinSharpness: 12, MinLuminance: 40, MaxLuminance: 235, MaxGlare: 0.08}
	if DefaultThresholds() != want {
		t.Errorf("DefaultThresholds() = %+v, want %+v", DefaultThresholds(), want)
	}
	if got := (Thresholds{ref.MinSharpness, ref.MinLuminance, ref.MaxLuminance, ref.MaxGlare}); got != want {
		t.Errorf("recorded thresholds %+v, want %+v", got, want)
	}
}

func TestAssessSharpWellLitPatternIsOK(t *testing.T) {
	q := Assess(fixture(t, "sharp.jpg"))
	if !q.OK || len(q.Reasons) != 0 || q.Reasons == nil {
		t.Errorf("got %+v, want ok with reasons []", q)
	}
	if q.Sharpness < DefaultThresholds().MinSharpness || q.GlareFraction >= DefaultThresholds().MaxGlare {
		t.Errorf("metrics %+v", q)
	}
	b, err := json.Marshal(q)
	if err != nil {
		t.Fatal(err)
	}
	var back contracts.QualityReport
	if err := json.Unmarshal(b, &back); err != nil || back.OK != q.OK {
		t.Errorf("round trip: %s, %v", b, err)
	}
}

func TestAssessReasons(t *testing.T) {
	for _, c := range []struct {
		file string
		want contracts.QualityReason
	}{
		{"blurred.jpg", contracts.QualityBlurry},
		{"dark.jpg", contracts.QualityTooDark},
		{"glare.jpg", contracts.QualityGlare},
	} {
		q := Assess(fixture(t, c.file))
		if q.OK || !slices.Contains(q.Reasons, c.want) {
			t.Errorf("%s: %+v, want %s", c.file, q, c.want)
		}
	}
	if q := Assess(fixture(t, "blurred.jpg")); q.Sharpness >= DefaultThresholds().MinSharpness {
		t.Errorf("blurred sharpness %v", q.Sharpness)
	}
	if q := Assess(fixture(t, "dark.jpg")); q.Luminance >= DefaultThresholds().MinLuminance {
		t.Errorf("dark luminance %v", q.Luminance)
	}
	// quality.test.ts: a 30% white patch is GLARE with a fraction in (0.25, 0.35).
	if q := Assess(fixture(t, "glare.jpg")); q.GlareFraction <= 0.25 || q.GlareFraction >= 0.35 {
		t.Errorf("glare fraction %v", q.GlareFraction)
	}
}

// quality.test.ts "accepts custom thresholds".
func TestAssessWithCustomThresholds(t *testing.T) {
	th := DefaultThresholds()
	th.MinSharpness = 9007199254740991 // Number.MAX_SAFE_INTEGER
	q, err := AssessWith(fixture(t, "sharp.jpg"), th)
	if err != nil {
		t.Fatal(err)
	}
	if q.OK || !slices.Equal(q.Reasons, []contracts.QualityReason{contracts.QualityBlurry}) {
		t.Errorf("got %+v, want reasons [BLURRY]", q)
	}
}

// quality.test.ts: saturated blue and green are well lit. libvips greyscale
// is Rec.709 luminance in linear light, so blue is 75 and green 220; Rec.601
// luma would make blue 29 (TOO_DARK).
func TestAssessSaturatedColoursAreNotTooDark(t *testing.T) {
	for file, want := range map[string]float64{"blue.jpg": 75, "green.jpg": 220} {
		q := Assess(fixture(t, file))
		if slices.Contains(q.Reasons, contracts.QualityTooDark) || q.Luminance != want {
			t.Errorf("%s: %+v, want luminance %v and no TOO_DARK", file, q, want)
		}
	}
}

// quality.test.ts "the sharp pattern is ok after normalizeImage".
func TestSharpPatternIsOKAfterNormalize(t *testing.T) {
	out, err := Normalize(fixture(t, "sharp.jpg"))
	if err != nil {
		t.Fatal(err)
	}
	if q := Assess(out); !q.OK || len(q.Reasons) != 0 {
		t.Errorf("got %+v", q)
	}
}

// The metric maths alone, on the lossless PNG where decoding is exact: Go
// matches libvips to float precision, far inside the parity tolerance.
func TestMetricsMatchLibvipsExactlyOnLosslessInput(t *testing.T) {
	ref := loadReference(t).image(t, "sharp.png").Assess
	q := Assess(fixture(t, "sharp.png"))
	if math.Abs(q.Sharpness-ref.Sharpness) > 1e-6 || math.Abs(q.Luminance-ref.Luminance) > 1e-6 || q.GlareFraction != ref.GlareFraction {
		t.Errorf("go %+v, node %+v", q, *ref)
	}
}

// Laplacian standard deviation by hand on a 3x3 image: edge pixels are
// replicated, the mask is divided by 9, and the deviation is the sample one.
func TestMeasureByHand(t *testing.T) {
	g := image.NewGray(image.Rect(0, 0, 3, 3))
	g.Pix[4] = 90 // a single bright centre pixel
	m := measure(g)
	// Responses: centre -4*90/9 = -40; the 4 edge neighbours +10; corners 0.
	vals := []float64{0, 10, 0, 10, -40, 10, 0, 10, 0}
	var s, s2 float64
	for _, v := range vals {
		s += v
		s2 += v * v
	}
	wantSD := math.Sqrt((s2 - s*s/9) / 8)
	if math.Abs(m.sharpness-wantSD) > 1e-12 || m.luminance != 10 || m.glareFraction != 0 {
		t.Errorf("measure = %+v, want sharpness %v, luminance 10", m, wantSD)
	}
	g.Pix[4] = 250
	if m := measure(g); m.glareFraction != 1.0/9 {
		t.Errorf("glare fraction %v, want 1/9 (250 counts as glare)", m.glareFraction)
	}
	g.Pix[4] = 249
	if m := measure(g); m.glareFraction != 0 {
		t.Errorf("glare fraction %v, want 0 (249 is not glare)", m.glareFraction)
	}
}

// A 1x1 image has no sample deviation; sharp reports sharpness 0 for it
// (recorded as tiny.jpg in the parity set), and so does Go.
func TestMeasureSinglePixel(t *testing.T) {
	g := image.NewGray(image.Rect(0, 0, 1, 1))
	g.Pix[0] = 128
	if m := measure(g); m.sharpness != 0 || m.luminance != 128 {
		t.Errorf("measure = %+v", m)
	}
}

// Assess cannot return an error, so bytes it cannot decode fail closed: a
// retake verdict, never ok. AssessWith reports the error (INVALID_IMAGE in
// the Node pipeline).
func TestAssessFailsClosedOnBytesItCannotDecode(t *testing.T) {
	q := Assess([]byte("not an image"))
	want := []contracts.QualityReason{contracts.QualityBlurry, contracts.QualityTooDark}
	if q.OK || !slices.Equal(q.Reasons, want) || q.Sharpness != 0 || q.Luminance != 0 {
		t.Errorf("got %+v, want not ok with %v", q, want)
	}
	if _, err := AssessWith([]byte("not an image"), DefaultThresholds()); err == nil {
		t.Error("AssessWith: want an error")
	}
}
