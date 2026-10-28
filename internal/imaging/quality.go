package imaging

import (
	"image"
	"image/color"
	"math"

	"github.com/medilens-ai/medilens/internal/contracts"
)

// GlareLevel is the grey level at or above which a pixel counts as glare.
const GlareLevel = 250

// Thresholds maps the metrics to retake reasons (config.ts
// QualityThresholds).
type Thresholds struct {
	MinSharpness float64
	MinLuminance float64
	// MaxLuminance adds no reason code: the contract has only BLURRY,
	// TOO_DARK and GLARE, and an overexposed frame surfaces as GLARE.
	MaxLuminance float64
	MaxGlare     float64
}

// DefaultThresholds are config.ts DEFAULT_THRESHOLDS: starting values, to
// be calibrated on real label photos. A function, so no caller can loosen
// them for everyone.
func DefaultThresholds() Thresholds {
	return Thresholds{MinSharpness: 12, MinLuminance: 40, MaxLuminance: 235, MaxGlare: 0.08}
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
// image, mapped to reasons with t. ok is true exactly when reasons is
// empty. It returns ErrImageTooLarge or ErrInvalidImage.
func AssessWith(b []byte, t Thresholds) (contracts.QualityReport, error) {
	var m metrics
	err := withDecoded(b, func(img image.Image, f Format) error {
		m = measure(grey(pixels(img, f)))
		return nil
	})
	if err != nil {
		return contracts.QualityReport{}, err
	}
	return verdict(m, t), nil
}

func verdict(m metrics, t Thresholds) contracts.QualityReport {
	reasons := []contracts.QualityReason{}
	if m.sharpness < t.MinSharpness {
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
}

// measure computes the three metrics of quality.ts on a grey image:
//
//   - luminance: the mean grey level;
//   - glareFraction: the fraction of pixels at GlareLevel or above;
//   - sharpness: sharp's stats().sharpness, that is libvips
//     deviate(conv(grey, [0 1 0; 1 -4 1; 0 1 0], scale 9)): float
//     precision with each response stored as float32 and summed in
//     double, edge pixels replicated (VIPS_EXTEND_COPY), and the one-pass
//     sample standard deviation sqrt(|Σv² − (Σv)²/N| / (N−1)).
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
	for y := range h {
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
		}
	}
	m := metrics{luminance: sum / float64(n), glareFraction: float64(glare) / float64(n)}
	if n > 1 {
		m.sharpness = math.Sqrt(math.Abs(s2-s*s/float64(n)) / float64(n-1))
	}
	return m
}
