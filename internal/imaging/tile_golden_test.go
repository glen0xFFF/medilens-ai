package imaging

import (
	"math"
	"slices"
	"strings"
	"testing"

	"github.com/medilens-ai/medilens/internal/contracts"
)

// Why the production verdict differs from the verdict Node recorded. Node
// decides BLURRY on the global sharpness (12, set on these synthetic
// patterns); production decides it on the tile metric (0.26).
const (
	whyDarkSharp   = "sharp pattern in the dark: TOO_DARK still applies; Node also called it BLURRY"
	whyLowContrast = "low-contrast copy of the sharp pattern: crisp edges, global under 12 only from the contrast"
	whyGradient    = "smooth gradient with no edges: quantisation steps clear 0.26; the gate is not proof of focus"
	whyCells       = "96x64 flat cells with hard edges: one tile at 1.94; Node's global 12 rejects any flat-cell chart"
	whyResampled   = "sharp pattern resampled or flattened: global 7 to 12, best tiles 10 to 15"
)

// tileGolden is the tile metric and production reasons of every accepted
// parity image, on the upload (norm false) and after Normalize (norm
// true). The values were measured by this code and cross-checked against
// the calibration run's px128/top3 (the same tiling, computed separately).
// reasons is space-separated; why is set exactly where the production
// verdict differs from the verdict Node recorded.
var tileGolden = []struct {
	file    string
	norm    bool
	tile    float64
	reasons string
	why     string
}{
	{"sharp.jpg", false, 16.5360, "", ""},
	{"sharp.jpg", true, 16.7526, "", ""},
	{"sharp.png", false, 16.4487, "", ""},
	{"sharp.png", true, 16.6095, "", ""},
	{"sharp.webp", false, 16.4246, "", ""},
	{"sharp.webp", true, 16.5754, "", ""},
	{"sharp-lossless.webp", false, 16.4487, "", ""},
	{"sharp-lossless.webp", true, 16.6095, "", ""},
	{"blurred.jpg", false, 0.1900, "BLURRY", ""},
	{"blurred.jpg", true, 0.2124, "BLURRY", ""},
	{"dark.jpg", false, 1.7107, "TOO_DARK", whyDarkSharp},
	{"dark.jpg", true, 1.9623, "TOO_DARK", whyDarkSharp},
	{"glare.jpg", false, 16.2875, "GLARE", ""},
	{"glare.jpg", true, 16.5002, "GLARE", ""},
	{"blue.jpg", false, 0.0000, "BLURRY", ""},
	{"blue.jpg", true, 0.0000, "BLURRY", ""},
	{"green.jpg", false, 0.0000, "BLURRY", ""},
	{"green.jpg", true, 0.0000, "BLURRY", ""},
	{"wide.jpg", false, 16.6335, "", ""},
	{"wide.jpg", true, 15.3680, "", ""},
	{"tall.jpg", false, 16.5565, "", ""},
	{"tall.jpg", true, 15.0755, "", ""},
	{"progressive.jpg", false, 16.5360, "", ""},
	{"progressive.jpg", true, 16.7526, "", ""},
	{"cmyk.jpg", false, 16.8455, "", ""},
	{"cmyk.jpg", true, 17.2383, "", ""},
	{"cmyk-contrast-62.jpg", false, 10.4576, "", whyLowContrast},
	{"cmyk-contrast-62.jpg", true, 11.1355, "", whyLowContrast},
	{"cmyk-contrast-66.jpg", false, 11.2991, "", whyLowContrast},
	{"cmyk-contrast-66.jpg", true, 11.8186, "", whyLowContrast},
	{"cmyk-contrast-68.jpg", false, 11.8359, "", whyLowContrast},
	{"cmyk-contrast-68.jpg", true, 12.5091, "", ""},
	{"cmyk-contrast-74.jpg", false, 12.5979, "", ""},
	{"cmyk-contrast-74.jpg", true, 13.1482, "", ""},
	{"cmyk-dark-30.jpg", false, 3.6620, "TOO_DARK", whyDarkSharp},
	{"cmyk-dark-30.jpg", true, 3.9518, "TOO_DARK", whyDarkSharp},
	{"cmyk-dark-32.jpg", false, 4.0555, "TOO_DARK", whyDarkSharp},
	{"cmyk-dark-32.jpg", true, 4.3428, "TOO_DARK", whyDarkSharp},
	{"cmyk-dark-34.jpg", false, 4.4395, "", whyLowContrast},
	{"cmyk-dark-34.jpg", true, 4.5794, "", whyLowContrast},
	{"cmyk-dark-38.jpg", false, 5.4422, "", whyLowContrast},
	{"cmyk-dark-38.jpg", true, 5.5777, "", whyLowContrast},
	{"large-shrink3-cmyk.jpg", false, 11.8065, "", ""},
	{"large-shrink3-cmyk.jpg", true, 15.8685, "", ""},
	{"patches-1x1.jpg", false, 0.0000, "BLURRY GLARE", ""},
	{"patches-1x1.jpg", true, 0.0000, "BLURRY GLARE", ""},
	{"patches-2x3.jpg", false, 37.5354, "", ""},
	{"patches-2x3.jpg", true, 36.2962, "", ""},
	{"patches-3x2.jpg", false, 22.9077, "GLARE", ""},
	{"patches-3x2.jpg", true, 20.2002, "GLARE", ""},
	{"patches-5x4.jpg", false, 15.7198, "GLARE", ""},
	{"patches-5x4.jpg", true, 15.3230, "GLARE", ""},
	{"patches-7x5.jpg", false, 26.7705, "GLARE", ""},
	{"patches-7x5.jpg", true, 26.9134, "", ""},
	{"patches-9x2.jpg", false, 18.8691, "GLARE", ""},
	{"patches-9x2.jpg", true, 18.4708, "GLARE", ""},
	{"patches-33x17.jpg", false, 29.4438, "", ""},
	{"patches-33x17.jpg", true, 29.5937, "", ""},
	{"patches-33x17-444.jpg", false, 30.3377, "", ""},
	{"patches-33x17-444.jpg", true, 29.4838, "", ""},
	{"colour.png", false, 0.3319, "", whyGradient},
	{"colour.png", true, 0.3930, "", whyGradient},
	{"colour-p3.jpg", false, 0.3504, "", whyGradient},
	{"colour-p3.jpg", true, 0.3645, "", whyGradient},
	{"sharp-p3.jpg", false, 16.5360, "", ""},
	{"sharp-p3.jpg", true, 16.7526, "", ""},
	{"colour.jpg", false, 0.3958, "", whyGradient},
	{"colour.jpg", true, 0.4096, "", whyGradient},
	{"colour-444.jpg", false, 0.3675, "", whyGradient},
	{"colour-444.jpg", true, 0.4050, "", whyGradient},
	{"alpha.png", false, 16.4487, "", ""},
	{"alpha.png", true, 15.0445, "", whyResampled},
	{"grey16.png", false, 16.4487, "", ""},
	{"grey16.png", true, 16.6095, "", ""},
	{"orient6.jpg", false, 16.5035, "", ""},
	{"orient6.jpg", true, 16.0769, "", ""},
	{"orient6.png", false, 16.4487, "", ""},
	{"orient6.png", true, 16.4762, "", ""},
	{"orient6.webp", false, 16.4246, "", ""},
	{"orient6.webp", true, 16.4550, "", ""},
	{"cells-o1.jpg", false, 1.9446, "", whyCells},
	{"cells-o1.jpg", true, 1.9446, "", whyCells},
	{"cells-o2.jpg", false, 1.9446, "", whyCells},
	{"cells-o2.jpg", true, 1.9446, "", whyCells},
	{"cells-o3.jpg", false, 1.9446, "", whyCells},
	{"cells-o3.jpg", true, 1.9446, "", whyCells},
	{"cells-o4.jpg", false, 1.9446, "", whyCells},
	{"cells-o4.jpg", true, 1.9446, "", whyCells},
	{"cells-o5.jpg", false, 1.9446, "", whyCells},
	{"cells-o5.jpg", true, 1.9446, "", whyCells},
	{"cells-o6.jpg", false, 1.9446, "", whyCells},
	{"cells-o6.jpg", true, 1.9446, "", whyCells},
	{"cells-o7.jpg", false, 1.9446, "", whyCells},
	{"cells-o7.jpg", true, 1.9446, "", whyCells},
	{"cells-o8.jpg", false, 1.9446, "", whyCells},
	{"cells-o8.jpg", true, 1.9446, "", whyCells},
	{"large-shrink3.jpg", false, 11.3294, "", ""},
	{"large-shrink3.jpg", true, 15.7025, "", ""},
	{"large-shrink5.jpg", false, 11.2699, "", ""},
	{"large-shrink5.jpg", true, 26.6661, "", ""},
	{"large-shrink9.jpg", false, 8.3921, "", ""},
	{"large-shrink9.jpg", true, 24.7035, "", ""},
	{"large-shrink5.png", false, 11.2699, "", ""},
	{"large-shrink5.png", true, 24.5154, "", ""},
	{"large-2400.webp", false, 16.4309, "", ""},
	{"large-2400.webp", true, 12.1708, "", whyResampled},
	{"large-3000.webp", false, 16.5198, "", ""},
	{"large-3000.webp", true, 13.8615, "", ""},
	{"large-alpha.webp", false, 13.1295, "", ""},
	{"large-alpha.webp", true, 10.4902, "", whyResampled},
	{"large-lossless.webp", false, 13.3539, "", ""},
	{"large-lossless.webp", true, 11.1480, "", whyResampled},
	{"tiny.jpg", false, 0.0000, "BLURRY", ""},
	{"tiny.jpg", true, 0.0000, "BLURRY", ""},
}

// tileGoldenTolerance bounds |measured - golden| tileSharpness.
const tileGoldenTolerance = 0.05

// tileMargin is how close to MinTileSharpness, as a fraction of it, no
// parity image may measure: a fixture that close would flip on a codec or
// decoder change, and the verdict pinned here would be luck.
const tileMargin = 0.15

func TestTileVerdictGolden(t *testing.T) {
	ref := loadReference(t)
	th := DefaultThresholds()
	lo, hi := th.MinTileSharpness*(1-tileMargin), th.MinTileSharpness*(1+tileMargin)
	type key struct {
		file string
		norm bool
	}
	seen := map[key]bool{}
	for _, row := range tileGolden {
		k := key{row.file, row.norm}
		if seen[k] {
			t.Errorf("%s norm=%v: duplicate golden row", row.file, row.norm)
		}
		seen[k] = true
		im := ref.image(t, row.file)
		b := fixture(t, row.file)
		label := row.file
		var node *refQuality
		if row.norm {
			label += " normalised"
			out, err := Normalize(b)
			if err != nil {
				t.Errorf("%s: Normalize: %v", label, err)
				continue
			}
			b = out
			if im.Normalized != nil {
				node = &im.Normalized.Quality
			}
		} else {
			node = im.Assess
		}
		m, q, err := assess(b, th)
		if err != nil {
			t.Errorf("%s: assess: %v", label, err)
			continue
		}
		if d := math.Abs(m.tileSharpness - row.tile); d > tileGoldenTolerance {
			t.Errorf("%s: tileSharpness %.4f, golden %.4f", label, m.tileSharpness, row.tile)
		}
		if m.tileSharpness >= lo && m.tileSharpness <= hi {
			t.Errorf("%s: tileSharpness %.4f is within %.0f%% of MinTileSharpness %v",
				label, m.tileSharpness, tileMargin*100, th.MinTileSharpness)
		}
		want := []contracts.QualityReason{}
		for _, r := range strings.Fields(row.reasons) {
			want = append(want, contracts.QualityReason(r))
		}
		if !slices.Equal(q.Reasons, want) || q.OK != (len(want) == 0) {
			t.Errorf("%s: production verdict ok=%v %v, golden %v", label, q.OK, q.Reasons, want)
		}
		differs := node != nil && !slices.Equal(node.Reasons, want)
		if differs && row.why == "" {
			t.Errorf("%s: differs from Node's recorded %v but has no why", label, node.Reasons)
		}
		if !differs && row.why != "" {
			t.Errorf("%s: has a why but matches Node's recorded verdict (or Node recorded none)", label)
		}
	}
	// Every accepted parity image is in the table, raw and normalised, and
	// no rejected one is.
	for _, im := range ref.Images {
		for _, norm := range []bool{false, true} {
			if im.Validate.OK != seen[key{im.File, norm}] {
				t.Errorf("%s norm=%v: accepted %v, in the golden table %v", im.File, norm, im.Validate.OK, seen[key{im.File, norm}])
			}
		}
	}
}
