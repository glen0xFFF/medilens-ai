package imaging

import (
	"bytes"
	"encoding/json"
	"image"
	"image/jpeg"
	"os"
	"path/filepath"
	"testing"

	"github.com/medilens-ai/medilens/internal/contracts"
	"github.com/medilens-ai/medilens/internal/parity"
)

// reference is fixtures/parity/images/reference.json, recorded from the
// Node build by scripts/parity/record-images.ts.
type reference struct {
	Versions   map[string]string `json:"versions"`
	Thresholds struct {
		MinSharpness float64 `json:"minSharpness"`
		MinLuminance float64 `json:"minLuminance"`
		MaxLuminance float64 `json:"maxLuminance"`
		MaxGlare     float64 `json:"maxGlare"`
	} `json:"thresholds"`
	MaxImageBytes  int        `json:"maxImageBytes"`
	MaxImagePixels int        `json:"maxImagePixels"`
	Images         []refImage `json:"images"`
	// Fit is [inWidth, inHeight, outWidth, outHeight] per recorded size.
	Fit [][4]int `json:"fit"`
}

type refImage struct {
	File     string `json:"file"`
	Recipe   string `json:"recipe"`
	Bytes    int    `json:"bytes"`
	Validate struct {
		OK     bool   `json:"ok"`
		Format string `json:"format"`
		Code   string `json:"code"`
	} `json:"validate"`
	Assess     *refQuality `json:"assess"`
	Normalized *struct {
		Width    int        `json:"width"`
		Height   int        `json:"height"`
		Channels int        `json:"channels"`
		Quality  refQuality `json:"quality"`
		Grid     []float64  `json:"grid"`
	} `json:"normalized"`
	// RGB is sharp's raw RGB decode of the image itself, where recorded.
	RGB []int `json:"rgb"`
}

type refQuality struct {
	OK            bool                      `json:"ok"`
	Sharpness     float64                   `json:"sharpness"`
	Luminance     float64                   `json:"luminance"`
	GlareFraction float64                   `json:"glareFraction"`
	Reasons       []contracts.QualityReason `json:"reasons"`
}

func imagesDir(t testing.TB) string {
	t.Helper()
	dir, err := parity.Dir()
	if err != nil {
		t.Fatal(err)
	}
	return filepath.Join(dir, "images")
}

func loadReference(t testing.TB) reference {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(imagesDir(t), "reference.json"))
	if err != nil {
		t.Fatal(err)
	}
	var r reference
	if err := json.Unmarshal(b, &r); err != nil {
		t.Fatal(err)
	}
	if len(r.Images) == 0 {
		t.Fatal("reference.json has no images")
	}
	return r
}

func (r reference) image(t testing.TB, file string) refImage {
	t.Helper()
	for _, im := range r.Images {
		if im.File == file {
			return im
		}
	}
	t.Fatalf("reference.json has no %s", file)
	return refImage{}
}

func fixture(t testing.TB, file string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(imagesDir(t), file))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func jpegConfig(t testing.TB, b []byte) image.Config {
	t.Helper()
	cfg, err := jpeg.DecodeConfig(bytes.NewReader(b))
	if err != nil {
		t.Fatalf("output is not a JPEG: %v", err)
	}
	return cfg
}

// gridOf is the 4x4 block means of the libvips-compatible greyscale of a
// JPEG, with the block edges record-images.ts uses (floor(i*size/4)).
func gridOf(t testing.TB, b []byte) []float64 {
	t.Helper()
	m, err := jpeg.Decode(bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	g := grey(m)
	w, h := g.Rect.Dx(), g.Rect.Dy()
	out := make([]float64, 0, 16)
	for gy := range 4 {
		for gx := range 4 {
			x0, x1 := gx*w/4, (gx+1)*w/4
			y0, y1 := gy*h/4, (gy+1)*h/4
			sum := 0
			for y := y0; y < y1; y++ {
				for x := x0; x < x1; x++ {
					sum += int(g.Pix[y*g.Stride+x])
				}
			}
			out = append(out, float64(sum)/float64((x1-x0)*(y1-y0)))
		}
	}
	return out
}
