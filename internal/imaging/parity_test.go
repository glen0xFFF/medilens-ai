package imaging

import (
	"fmt"
	"math"
	"slices"
	"strings"
	"testing"
)

// Parity tolerances (Go port spec §4 Imaging; task G5 brief). The verdict
// (ok and reasons) must be exactly equal.
var specTolerance = tolerance{
	sharpness: 0.5,
	luminance: 0.5,
	glare:     0.005,
	// grid bounds each 4x4 block mean of the normalised image, in grey
	// levels. It checks where the pixels went (orientation, resize), not
	// codec detail: a wrong rotation or flip moves a block by 14 or more
	// on the cells images.
	grid: 3.0,
}

type tolerance struct{ sharpness, luminance, glare, grid float64 }

// knownGaps are parity images Go does not match within the spec
// tolerance, each reported to the controller for a ruling (task G5 report,
// concerns). The verdict must still be equal, and the gap may not grow past
// the bound given, which sits just above the measured difference. A gap
// may relax only the block means: never a metric that decides the verdict
// (TestKnownGapsKeepMetricTolerance).
var knownGaps = map[string]struct {
	why string
	tol tolerance
}{
	// Measured: the three metrics within the spec tolerance (luminance
	// -0.31 / -0.27); block means of the saturated top-right corner up to
	// -3.2. The same image without a profile (colour.jpg) is within 3.
	"colour-p3.jpg": {
		why: "sharp converts an embedded Display P3 profile to sRGB; Go ignores ICC " +
			"profiles and reads the P3 values as sRGB",
		tol: tolerance{sharpness: 0.5, luminance: 0.5, glare: 0.005, grid: 4.0},
	},
}

func toleranceFor(t *testing.T, file string) tolerance {
	if gap, ok := knownGaps[file]; ok {
		t.Logf("%s: KNOWN GAP, bounds %+v: %s", file, gap.tol, gap.why)
		return gap.tol
	}
	return specTolerance
}

// checkQuality holds Go's metrics to Node's within tol, and Node's rule
// applied to Go's metrics (nodeVerdict) to Node's recorded verdict, exactly.
// The production verdict decides BLURRY on the Go-only tile metric, so it
// is not what Node recorded; TestTileVerdictGolden pins that one.
func checkQuality(t *testing.T, label string, m metrics, want refQuality, tol tolerance) {
	t.Helper()
	got := nodeVerdict(m, DefaultThresholds())
	t.Logf("%-30s go sharp=%9.4f lum=%9.4f glare=%.5f %v | node sharp=%9.4f lum=%9.4f glare=%.5f %v",
		label, got.Sharpness, got.Luminance, got.GlareFraction, got.Reasons,
		want.Sharpness, want.Luminance, want.GlareFraction, want.Reasons)
	if d := math.Abs(got.Sharpness - want.Sharpness); d > tol.sharpness {
		t.Errorf("%s: sharpness %v, node %v (|d| %.4f > %v)", label, got.Sharpness, want.Sharpness, d, tol.sharpness)
	}
	if d := math.Abs(got.Luminance - want.Luminance); d > tol.luminance {
		t.Errorf("%s: luminance %v, node %v (|d| %.4f > %v)", label, got.Luminance, want.Luminance, d, tol.luminance)
	}
	if d := math.Abs(got.GlareFraction - want.GlareFraction); d > tol.glare {
		t.Errorf("%s: glareFraction %v, node %v (|d| %.5f > %v)", label, got.GlareFraction, want.GlareFraction, d, tol.glare)
	}
	if got.OK != want.OK || !slices.Equal(got.Reasons, want.Reasons) {
		t.Errorf("%s: verdict ok=%v %v, node ok=%v %v", label, got.OK, got.Reasons, want.OK, want.Reasons)
	}
}

// Every accepted parity image: assessQuality on the upload (where
// recorded), and normalizeImage then assessQuality (what the pipeline
// measures), with the output size, channel count and block means.
func TestImageParity(t *testing.T) {
	ref := loadReference(t)
	if ref.Versions["sharp"] == "" || ref.Versions["vips"] == "" {
		t.Fatal("reference.json does not name the sharp/libvips versions")
	}
	normalized := 0
	for _, im := range ref.Images {
		b := fixture(t, im.File)
		tol := toleranceFor(t, im.File)
		if len(b) != im.Bytes {
			t.Errorf("%s: %d bytes, recorded %d", im.File, len(b), im.Bytes)
		}
		if im.Assess != nil {
			m, _, err := assess(b, DefaultThresholds())
			if err != nil {
				t.Errorf("%s: assess: %v", im.File, err)
			} else {
				checkQuality(t, im.File, m, *im.Assess, tol)
			}
		}
		if im.Normalized == nil {
			continue
		}
		normalized++
		out, err := Normalize(b)
		if err != nil {
			t.Errorf("%s: Normalize: %v", im.File, err)
			continue
		}
		cfg := jpegConfig(t, out)
		n := im.Normalized
		if cfg.Width != n.Width || cfg.Height != n.Height {
			t.Errorf("%s: normalised to %dx%d, node %dx%d", im.File, cfg.Width, cfg.Height, n.Width, n.Height)
		}
		if n.Channels != 3 {
			t.Errorf("%s: node wrote %d channels; the Go output is always 3", im.File, n.Channels)
		}
		m, _, err := assess(out, DefaultThresholds())
		if err != nil {
			t.Errorf("%s: assess(normalised): %v", im.File, err)
			continue
		}
		checkQuality(t, im.File+" normalised", m, n.Quality, tol)
		grid := gridOf(t, out)
		for i := range grid {
			if d := math.Abs(grid[i] - n.Grid[i]); d > tol.grid {
				t.Errorf("%s: block %d mean %.2f, node %.2f", im.File, i, grid[i], n.Grid[i])
			}
		}
	}
	if normalized < 20 {
		t.Errorf("only %d normalised parity images", normalized)
	}
	for file := range knownGaps {
		ref.image(t, file) // a gap names a recorded image
	}
}

// A known gap may not loosen sharpness, luminance or glare: those decide
// the verdict, and a looser bound lets Go pass an image Node sends back
// for a retake (task G5 review round 1: cmyk.jpg was exempted, and CMYK
// images near the thresholds flipped from BLURRY to ok).
func TestKnownGapsKeepMetricTolerance(t *testing.T) {
	for file, gap := range knownGaps {
		if gap.tol.sharpness > specTolerance.sharpness || gap.tol.luminance > specTolerance.luminance ||
			gap.tol.glare > specTolerance.glare {
			t.Errorf("%s: known gap loosens a metric past the spec tolerance: %+v", file, gap.tol)
		}
	}
}

// The CMYK parity images, including those either side of minSharpness and
// minLuminance, are held to the spec tolerance with no exemption.
func TestCMYKParityImagesHaveNoExemption(t *testing.T) {
	ref := loadReference(t)
	n, flips := 0, map[string]bool{}
	for _, im := range ref.Images {
		if !strings.Contains(im.File, "cmyk") {
			continue
		}
		n++
		if _, ok := knownGaps[im.File]; ok {
			t.Errorf("%s: CMYK image listed as a known gap", im.File)
		}
		if im.Normalized != nil {
			flips[fmt.Sprint(im.Normalized.Quality.Reasons)] = true
		}
		// Node's rule on Go's metrics gives Node's recorded verdict, on the
		// upload and on the normalised image.
		b := fixture(t, im.File)
		if im.Assess != nil {
			checkNodeVerdict(t, im.File, b, *im.Assess)
		}
		if im.Normalized != nil {
			out, err := Normalize(b)
			if err != nil {
				t.Errorf("%s: Normalize: %v", im.File, err)
				continue
			}
			checkNodeVerdict(t, im.File+" normalised", out, im.Normalized.Quality)
		}
	}
	if n < 10 {
		t.Errorf("%d CMYK parity images, want at least 10", n)
	}
	// Both sides of each threshold: ok, BLURRY alone, BLURRY+TOO_DARK.
	if len(flips) < 3 {
		t.Errorf("CMYK parity verdicts %v do not straddle the thresholds", flips)
	}
}

func checkNodeVerdict(t *testing.T, label string, b []byte, want refQuality) {
	t.Helper()
	m, _, err := assess(b, DefaultThresholds())
	if err != nil {
		t.Errorf("%s: assess: %v", label, err)
		return
	}
	if got := nodeVerdict(m, DefaultThresholds()); got.OK != want.OK || !slices.Equal(got.Reasons, want.Reasons) {
		t.Errorf("%s: node rule on go metrics ok=%v %v, node recorded ok=%v %v", label, got.OK, got.Reasons, want.OK, want.Reasons)
	}
}
