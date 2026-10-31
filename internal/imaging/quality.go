package imaging

import (
	"cmp"
	"image"
	"image/color"
	"math"
	"slices"

	"github.com/medilens-ai/medilens/internal/contracts"
)

// GlareLevel is the grey level at or above which a pixel counts as glare.
const GlareLevel = 250

// Thresholds maps the metrics to retake reasons (config.ts
// QualityThresholds, plus the Go-only MinTileSharpness).
//
// The BLURRY gate is coarse: it asks "is something in the frame in
// focus?", not "is the label in focus?". It passes a blurred label beside
// a sharp background, foil highlights, and noisy or recompressed frames
// (noise and JPEG blocking read as edges). Whether the label can be read
// is decided later, by the reader's per-field legibility and
// LABEL_UNREADABLE.
type Thresholds struct {
	// MinSharpness is Node's threshold on the global sharpness. It no
	// longer produces BLURRY: it is kept as the recorded Node value and
	// for the parity oracle (nodeVerdict). Set on synthetic patterns,
	// every real phone photo measured under it (0.79 to 1.82).
	MinSharpness float64
	// MinTileSharpness decides BLURRY: the frame is BLURRY unless its
	// tile sharpness (see measure) is at least this.
	MinTileSharpness float64
	MinLuminance     float64
	// MaxLuminance adds no reason code: the contract has only BLURRY,
	// TOO_DARK and GLARE, and an overexposed frame surfaces as GLARE.
	MaxLuminance float64
	MaxGlare     float64
}

// DefaultThresholds are config.ts DEFAULT_THRESHOLDS, plus
// MinTileSharpness 0.26, calibrated on 4 real label photos (2.7 to 4.0 as
// taken) and Gaussian blur of them (0.235 to 0.260 at sigma 8, where the
// reader failed on every one tried; 0.59 or more at sigma 2). It is
// permissive: the reader also failed photos that pass it (sigma 3 at 0.39,
// sigma 5 at 0.26 to 0.31, motion blur at 0.94 to 1.90), and the highest
// sigma-8 photo sits only 0.0001 under it. Real defocus and handshake
// photos are still needed, and added noise lifts a blurred frame over the
// threshold. A function, so no caller can loosen them for everyone.
func DefaultThresholds() Thresholds {
	return Thresholds{MinSharpness: 12, MinTileSharpness: 0.26, MinLuminance: 40, MaxLuminance: 235, MaxGlare: 0.08}
}

// Assess is assessQuality with the default thresholds, on the normalised
// JPEG (Normalize's output; any accepted format decodes). It cannot return
// an error, so bytes it cannot validate or decode fail closed: all metrics
// 0, which is not ok (BLURRY, TOO_DARK). Use AssessWith to get the error
// (the Node pipeline maps it to INVALID_IMAGE).
func Assess(jpeg []byte) contracts.QualityReport {
	q, err := AssessWith(jpeg, DefaultThresholds())
	if err != nil {
		return verdict(metrics{}, DefaultThresholds())
	}
	return q
}

// AssessWith mirrors assessQuality (quality.ts): sharpness, mean
// luminance and glare fraction on the libvips-compatible greyscale of the
// image, mapped to reasons with t, except that BLURRY is decided by the
// tile sharpness (see verdict). The report carries the Node-parity global
// sharpness, not the tile metric. ok is true exactly when reasons is
// empty. It returns ErrImageTooLarge or ErrInvalidImage.
func AssessWith(b []byte, t Thresholds) (contracts.QualityReport, error) {
	_, q, err := assess(b, t)
	return q, err
}

// assess decodes b, measures it and returns the metrics with the
// production verdict.
func assess(b []byte, t Thresholds) (metrics, contracts.QualityReport, error) {
	var m metrics
	err := withDecoded(b, func(img image.Image, f Format) error {
		m = measure(grey(pixels(img, f)))
		return nil
	})
	if err != nil {
		return metrics{}, contracts.QualityReport{}, err
	}
	return m, verdict(m, t), nil
}

// verdict is the production verdict: BLURRY unless the tile sharpness is
// at least MinTileSharpness (written so that NaN fails closed), then
// TOO_DARK and GLARE as in Node. The global sharpness is still reported
// but no longer decides BLURRY.
func verdict(m metrics, t Thresholds) contracts.QualityReport {
	return report(m, !(m.tileSharpness >= t.MinTileSharpness), t)
}

// nodeVerdict is assessQuality's rule (quality.ts): BLURRY when the global
// sharpness is under MinSharpness. It is the parity oracle: Node's rule
// on Go's metrics must give Node's recorded verdict.
func nodeVerdict(m metrics, t Thresholds) contracts.QualityReport {
	return report(m, m.sharpness < t.MinSharpness, t)
}

// report maps the metrics to reasons, in the order BLURRY, TOO_DARK,
// GLARE; ok is true exactly when there are none.
func report(m metrics, blurry bool, t Thresholds) contracts.QualityReport {
	reasons := []contracts.QualityReason{}
	if blurry {
		reasons = append(reasons, contracts.QualityBlurry)
	}
	if m.luminance < t.MinLuminance {
		reasons = append(reasons, contracts.QualityTooDark)
	}
	if m.glareFraction > t.MaxGlare {
		reasons = append(reasons, contracts.QualityGlare)
	}
	return contracts.QualityReport{
		OK:            len(reasons) == 0,
		Sharpness:     m.sharpness,
		Luminance:     m.luminance,
		GlareFraction: m.glareFraction,
		Reasons:       reasons,
	}
}

// libvips' 8-bit sRGB <-> linear tables (vips_v2Y_8 and vips_Y2v_8).
var (
	v2Y [256]float32
	y2v [257]int // one extra entry for the interpolation at 255
)

func init() {
	for i := range 256 {
		f := float32(i) / 255
		if f <= 0.04045 {
			v2Y[i] = f / 12.92
		} else {
			v2Y[i] = float32(math.Pow(float64((f+0.055)/(1+0.055)), 2.4))
		}
		var v float32
		if f <= 0.0031308 {
			v = 12.92 * f
		} else {
			v = float32((1.0+0.055)*math.Pow(float64(f), 1.0/2.4)) - 0.055
		}
		y2v[i] = int(math.RoundToEven(float64(255 * v)))
	}
	y2v[256] = y2v[255]
}

// greyFromRGB is libvips colourspace(B_W) on 8-bit sRGB: linearise through
// the float LUT, Rec.709 luminance in float32, re-encode through the int
// LUT with linear interpolation, round half to even
// (vips_col_scRGB2BW_8). It is not Rec.601 luma: saturated blue is 75,
// not 29.
func greyFromRGB(r, g, b uint8) uint8 {
	y := 0.2126*v2Y[r] + 0.7152*v2Y[g] + 0.0722*v2Y[b]
	yf := min(max(y*255, 0), 255)
	yi := int(yf)
	v := float32(y2v[yi]) + float32(y2v[yi+1]-y2v[yi])*(yf-float32(yi))
	return uint8(math.RoundToEven(float64(v)))
}

// grey is sharp's .greyscale(): an image that is already 8-bit grey passes
// through unchanged, as in libvips; anything else goes through
// greyFromRGB on its non-premultiplied colour.
func grey(img image.Image) *image.Gray {
	if g, ok := img.(*image.Gray); ok {
		return g
	}
	b := img.Bounds()
	out := image.NewGray(image.Rect(0, 0, b.Dx(), b.Dy()))
	for y := range b.Dy() {
		for x := range b.Dx() {
			c := color.NRGBAModel.Convert(img.At(b.Min.X+x, b.Min.Y+y)).(color.NRGBA)
			out.Pix[y*out.Stride+x] = greyFromRGB(c.R, c.G, c.B)
		}
	}
	return out
}

type metrics struct {
	sharpness, luminance, glareFraction float64
	tileSharpness                       float64
}

// measure computes the three metrics of quality.ts on a grey image, and
// the Go-only tile metric, in one pass:
//
//   - luminance: the mean grey level;
//   - glareFraction: the fraction of pixels at GlareLevel or above;
//   - sharpness: sharp's stats().sharpness, that is libvips
//     deviate(conv(grey, [0 1 0; 1 -4 1; 0 1 0], scale 9)): float
//     precision with each response stored as float32 and summed in
//     double, edge pixels replicated (VIPS_EXTEND_COPY), and the one-pass
//     sample standard deviation sqrt(|Σv² − (Σv)²/N| / (N−1));
//   - tileSharpness: the same responses split into 128 px tiles (see
//     tileIndex), each tile scored by the same sample deviation (0 below 2
//     pixels), and the mean of the 3 best tile scores (of all tiles when
//     there are fewer). A smooth background around the label does not
//     lower it; that dilution is why every real phone photo failed the
//     global sharpness.
func measure(g *image.Gray) metrics {
	w, h := g.Rect.Dx(), g.Rect.Dy()
	n := w * h
	if n == 0 {
		return metrics{}
	}
	at := func(x, y int) float64 {
		x = min(max(x, 0), w-1)
		y = min(max(y, 0), h-1)
		return float64(g.Pix[y*g.Stride+x])
	}
	const c, c4 = 1.0 / 9.0, -4.0 / 9.0
	var sum, s, s2 float64
	glare := 0
	colTile, nx := tileIndex(w)
	rowTile, ny := tileIndex(h)
	tiles := make([]tileAcc, nx*ny)
	for y := range h {
		ty := rowTile[y]
		for x := range w {
			v := g.Pix[y*g.Stride+x]
			sum += float64(v)
			if v >= GlareLevel {
				glare++
			}
			// The term order of libvips convf: row-major over the non-zero
			// coefficients.
			l := float64(float32(c*at(x, y-1) + c*at(x-1, y) + c4*at(x, y) + c*at(x+1, y) + c*at(x, y+1)))
			s += l
			s2 += l * l
			if tx := colTile[x]; tx >= 0 && ty >= 0 {
				a := &tiles[ty*nx+tx]
				a.s += l
				a.s2 += l * l
				a.n++
			}
		}
	}
	m := metrics{luminance: sum / float64(n), glareFraction: float64(glare) / float64(n)}
	m.sharpness = sampleSD(s, s2, n)
	m.tileSharpness = topMean(tiles, tileTop)
	return m
}

// Tiling of the region metric: tiles of tileSize pixels from 0 on each
// axis. A trailing partial tile shorter than tileMinTail is skipped (its
// pixels count in no tile); an axis of tileSize or less is one tile.
const (
	tileSize    = 128
	tileMinTail = tileSize / 2
	tileTop     = 3
)

type tileAcc struct {
	s, s2 float64
	n     int
}

// tileIndex maps each position on an axis of length size to its tile, or
// -1 for a skipped trailing pixel, and returns the number of tiles.
func tileIndex(size int) ([]int, int) {
	idx := make([]int, size)
	if size <= tileSize {
		return idx, 1
	}
	tiles := size / tileSize
	if size%tileSize >= tileMinTail {
		tiles++
	}
	for i := range idx {
		idx[i] = i / tileSize
		if idx[i] >= tiles {
			idx[i] = -1
		}
	}
	return idx, tiles
}

// sampleSD is the one-pass sample standard deviation
// sqrt(|Σv² − (Σv)²/N| / (N−1)); 0 when n < 2.
func sampleSD(s, s2 float64, n int) float64 {
	if n < 2 {
		return 0
	}
	return math.Sqrt(math.Abs(s2-s*s/float64(n)) / float64(n-1))
}

// topMean is the mean of the k largest tile scores (all of them when there
// are fewer than k); 0 when there are no tiles.
func topMean(tiles []tileAcc, k int) float64 {
	scores := make([]float64, len(tiles))
	for i, a := range tiles {
		scores[i] = sampleSD(a.s, a.s2, a.n)
	}
	slices.SortFunc(scores, func(a, b float64) int { return cmp.Compare(b, a) })
	k = min(k, len(scores))
	if k == 0 {
		return 0
	}
	var sum float64
	for _, v := range scores[:k] {
		sum += v
	}
	return sum / float64(k)
}
