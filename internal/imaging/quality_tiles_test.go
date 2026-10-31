package imaging

import (
	"bytes"
	"image"
	"image/png"
	"math"
	"slices"
	"testing"

	"github.com/medilens-ai/medilens/internal/contracts"
)

// row is a 1-pixel-tall grey image of width w, flat 0 except the given
// pixels. On one row the vertical neighbours replicate the pixel itself, so
// a lone pixel of value v far from the edges has the Laplacian responses
// v/9, -2v/9, v/9 and 0 everywhere else: a tile of n pixels holding it has
// s = 0 and s2 = 6v²/81, so its score is sqrt(6v²/81 / (n-1)).
func row(w int, px map[int]uint8) *image.Gray {
	g := image.NewGray(image.Rect(0, 0, w, 1))
	for x, v := range px {
		g.Pix[x] = v
	}
	return g
}

// loneScore is the tile score of a tile of n pixels on one row holding a
// single pixel of value v (see row).
func loneScore(v float64, n int) float64 {
	return math.Sqrt(6 * v * v / 81 / float64(n-1))
}

func encodePNG(t testing.TB, img image.Image) []byte {
	t.Helper()
	var b bytes.Buffer
	if err := png.Encode(&b, img); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

// The tile metric by hand: tiles of 128 px from 0 on each axis, a
// trailing partial tile under 64 px skipped, an axis of 128 px or less one
// tile, tile score the sample deviation of the same Laplacian responses as
// the global metric, and tileSharpness the mean of the 3 best tiles (all
// tiles when there are fewer).
func TestMeasureTilesByHand(t *testing.T) {
	for _, c := range []struct {
		name string
		g    *image.Gray
		want float64
	}{
		// One pixel: one tile with n = 1 scores 0.
		{"1x1", image.NewGray(image.Rect(0, 0, 1, 1)), 0},
		// An axis of 128 px or less is one tile spanning it.
		{"100 px axis, one tile", row(100, map[int]uint8{50: 90}), loneScore(90, 100)},
		// 150 px: one tile [0,128); the trailing 22 px are skipped.
		{"150 px axis, pixel in the first tile", row(150, map[int]uint8{60: 90}), loneScore(90, 128)},
		{"150 px axis, pixel in the skipped 22 px", row(150, map[int]uint8{140: 90}), 0},
		// 200 px: tiles [0,128) and [128,200) (72 px counts); fewer than 3
		// tiles, so the mean of both.
		{"200 px axis, two tiles", row(200, map[int]uint8{160: 90}), (0 + loneScore(90, 72)) / 2},
		// The 64 px boundary: a trailing tile of exactly 64 px counts, 63
		// px does not.
		{"192 px axis, trailing 64 px counts", row(192, map[int]uint8{170: 90}), loneScore(90, 64) / 2},
		{"191 px axis, trailing 63 px skipped", row(191, map[int]uint8{170: 90}), 0},
		// 640 px: 5 tiles scoring 1, 2, 0.5, 0 and 1.5 times
		// loneScore(90, 128); the best 3 are 2, 1.5 and 1.
		{"640 px axis, top 3 of 5", row(640, map[int]uint8{60: 90, 190: 180, 320: 45, 580: 135}),
			(2 + 1.5 + 1) / 3 * loneScore(90, 128)},
	} {
		m := measure(c.g)
		if math.Abs(m.tileSharpness-c.want) > 1e-9 {
			t.Errorf("%s: tileSharpness %v, want %v", c.name, m.tileSharpness, c.want)
		}
	}

	// Tiles are 2-D: on a 256x256 image a lone pixel of 90 in tile (1,1)
	// has the responses -40 and four of +10, s2 = 2000 over 16384 pixels;
	// the other three tiles score 0.
	g := image.NewGray(image.Rect(0, 0, 256, 256))
	g.Pix[200*g.Stride+200] = 90
	if m, want := measure(g), math.Sqrt(2000.0/16383)/3; math.Abs(m.tileSharpness-want) > 1e-9 {
		t.Errorf("256x256: tileSharpness %v, want %v", m.tileSharpness, want)
	}

	// The 150 px row with its only pixel in the skipped tail: the global
	// metric sees it, the tile metric does not.
	if m := measure(row(150, map[int]uint8{140: 90})); m.sharpness == 0 || m.tileSharpness != 0 {
		t.Errorf("skipped tail: %+v, want global > 0 and tileSharpness 0", m)
	}

	// An empty image measures 0.
	if m := measure(image.NewGray(image.Rect(0, 0, 0, 0))); m != (metrics{}) {
		t.Errorf("empty: %+v", m)
	}

	// A 1x1 photo has no sharpness to measure: BLURRY.
	one := image.NewGray(image.Rect(0, 0, 1, 1))
	one.Pix[0] = 128
	if q := Assess(encodePNG(t, one)); q.OK || !slices.Contains(q.Reasons, contracts.QualityBlurry) {
		t.Errorf("1x1: %+v, want BLURRY", q)
	}
}

// gaussBlur is a separable Gaussian blur of a grey image (radius 3 sigma,
// edges replicated, rounded back to 8 bits): the test's defocus.
func gaussBlur(g *image.Gray, sigma float64) *image.Gray {
	r := int(math.Ceil(3 * sigma))
	k := make([]float64, 2*r+1)
	var sum float64
	for i := range k {
		d := float64(i - r)
		k[i] = math.Exp(-d * d / (2 * sigma * sigma))
		sum += k[i]
	}
	for i := range k {
		k[i] /= sum
	}
	w, h := g.Rect.Dx(), g.Rect.Dy()
	tmp := make([]float64, w*h)
	for y := range h {
		for x := range w {
			var v float64
			for i, kv := range k {
				v += kv * float64(g.Pix[y*g.Stride+min(max(x+i-r, 0), w-1)])
			}
			tmp[y*w+x] = v
		}
	}
	out := image.NewGray(image.Rect(0, 0, w, h))
	for y := range h {
		for x := range w {
			var v float64
			for i, kv := range k {
				v += kv * tmp[min(max(y+i-r, 0), h-1)*w+x]
			}
			out.Pix[y*out.Stride+x] = uint8(math.Round(v))
		}
	}
	return out
}

// greyFixture is the libvips-compatible greyscale of a PNG fixture.
func greyFixture(t testing.TB, file string) *image.Gray {
	t.Helper()
	img, err := png.Decode(bytes.NewReader(fixture(t, file)))
	if err != nil {
		t.Fatal(err)
	}
	return grey(img)
}

// The real-photo failure mode of the global metric: the label fills part
// of the frame and the rest is smooth (table, wall, packaging), so the
// global deviation is diluted under 12 however crisp the print is. Here one
// 128 px tile of crisp dark strokes on white sits in a flat 1024x1024 grey
// frame.
func TestSharpRegionInFlatFrameIsNotBlurry(t *testing.T) {
	g := image.NewGray(image.Rect(0, 0, 1024, 1024))
	for i := range g.Pix {
		g.Pix[i] = 128
	}
	// text-like: lines of 3 px strokes 2 px apart, a word gap every 35 px
	for y := 384; y < 512; y++ {
		for x := 512; x < 640; x++ {
			v := uint8(245)
			if (y-384)%12 < 8 && (x-512)%5 < 3 && (x-512)%35 < 28 {
				v = 20
			}
			g.Pix[y*g.Stride+x] = v
		}
	}
	q := Assess(encodePNG(t, g))
	if !q.OK || len(q.Reasons) != 0 {
		t.Errorf("got %+v, want ok", q)
	}
	if q.Sharpness >= DefaultThresholds().MinSharpness {
		t.Errorf("global sharpness %v, want it under %v (diluted)", q.Sharpness, DefaultThresholds().MinSharpness)
	}
	if nv := nodeVerdict(measure(g), DefaultThresholds()); !slices.Equal(nv.Reasons, []contracts.QualityReason{contracts.QualityBlurry}) {
		t.Errorf("node rule %v, want [BLURRY]: the frame should be one Node rejects", nv.Reasons)
	}
}

// A pair either side of MinTileSharpness, made from sharp.png by a Go
// blur: sigma 4.8 measures about 0.21 (BLURRY), sigma 3.3 about 0.41 (not
// BLURRY). Node's global rule rejects both.
func TestBlurStraddlesMinTileSharpness(t *testing.T) {
	g := greyFixture(t, "sharp.png")
	for _, c := range []struct {
		sigma  float64
		lo, hi float64
		blurry bool
	}{
		{4.8, 0.15, 0.24, true},
		{3.3, 0.33, 0.50, false},
	} {
		b := gaussBlur(g, c.sigma)
		m := measure(b)
		if m.tileSharpness < c.lo || m.tileSharpness > c.hi {
			t.Errorf("sigma %v: tileSharpness %v, want in [%v, %v]", c.sigma, m.tileSharpness, c.lo, c.hi)
		}
		q := Assess(encodePNG(t, b))
		if got := slices.Contains(q.Reasons, contracts.QualityBlurry); got != c.blurry || q.OK == c.blurry {
			t.Errorf("sigma %v: %+v, want BLURRY %v", c.sigma, q, c.blurry)
		}
	}
}

// NaN fails closed: a tile metric that is not a number is BLURRY.
func TestNaNTileSharpnessIsBlurry(t *testing.T) {
	m := metrics{sharpness: 100, tileSharpness: math.NaN(), luminance: 128}
	if q := verdict(m, DefaultThresholds()); q.OK || !slices.Equal(q.Reasons, []contracts.QualityReason{contracts.QualityBlurry}) {
		t.Errorf("got %+v, want [BLURRY]", q)
	}
}

// KNOWN GAP, not label focus: the gate passes a frame whose only sharp
// content is a thin border of texture around a defocused middle. The best
// 3 tiles sit on the border, so a blurred label framed by a sharp
// background (a table edge, a patterned cloth) is not BLURRY. The reader's
// per-field legibility and LABEL_UNREADABLE decide whether the label can
// be read. This test pins the gap, so a fix shows up as a change here.
func TestKnownGapSharpBorderAroundBlurredBlockPasses(t *testing.T) {
	sharp := greyFixture(t, "sharp.png")
	g := gaussBlur(sharp, 8)
	const border = 32
	w, h := g.Rect.Dx(), g.Rect.Dy()
	for y := range h {
		for x := range w {
			if x < border || y < border || x >= w-border || y >= h-border {
				g.Pix[y*g.Stride+x] = sharp.Pix[y*sharp.Stride+x]
			}
		}
	}
	m := measure(g)
	q := Assess(encodePNG(t, g))
	if !q.OK {
		t.Errorf("known gap changed: %+v (tileSharpness %v); if the gate now catches this, update the docs and this test", q, m.tileSharpness)
	}
	if m.sharpness >= DefaultThresholds().MinSharpness {
		t.Errorf("global %v: the blurred middle should keep the global metric under 12", m.sharpness)
	}
}

// A frame of at most 128x128 px is one tile, so its tile sharpness is
// the global sharpness computed from the same float32 Laplacian values.
// Non-integer grey steps make float32 rounding matter: a tile pass fed
// an unrounded Laplacian would differ in the last bits.
func TestSingleTileEqualsGlobalSharpnessExactly(t *testing.T) {
	g := image.NewGray(image.Rect(0, 0, 97, 61))
	for i := range g.Pix {
		g.Pix[i] = uint8((i*37 + i*i*11) % 251)
	}
	m := measure(g)
	if m.tileSharpness != m.sharpness || m.sharpness == 0 {
		t.Errorf("tileSharpness %v, sharpness %v: want bit-identical", m.tileSharpness, m.sharpness)
	}
}
