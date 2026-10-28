package imaging

import (
	"bytes"
	"image"
	"image/jpeg"
	"os"
	"path/filepath"
	"testing"
)

func readCMYKFixture(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "..", "fixtures", "parity", "cmyk", name))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// cmykToSRGB against sharp's own output on seeded random CMYK pixels
// (record-cmyk-lut.ts), drawn with seeds the fit does not use: 20,000
// anywhere in the cube and 20,000 on its faces (inks at 0 or 255: plain K,
// no-ink and full-ink colours; those with two or fewer free inks are also
// among the fit's enumerated pixels). The node values are a least-squares
// estimate, so an output that lands next to a rounding boundary may round
// the other way: at most one level, unbiased; measured 96.7% (interior)
// and 98.7% (faces) of channels exact, held at 96% and 98%.
func TestCMYKToSRGBMatchesSharp(t *testing.T) {
	for _, set := range []struct {
		name     string
		minExact float64
	}{{"pixels", 0.96}, {"faces", 0.98}} {
		in := readCMYKFixture(t, set.name+".cmyk")
		want := readCMYKFixture(t, set.name+".srgb")
		if len(in)/4 != len(want)/3 || len(in) == 0 {
			t.Fatalf("%s: fixture sizes %d / %d", set.name, len(in), len(want))
		}
		var exact, total, bias, worst int
		for i := range len(in) / 4 {
			r, g, b := cmykToSRGB(in[4*i], in[4*i+1], in[4*i+2], in[4*i+3])
			for ch, v := range [3]uint8{r, g, b} {
				d := int(v) - int(want[3*i+ch])
				bias += d
				total++
				if d == 0 {
					exact++
				}
				worst = max(worst, d, -d)
			}
		}
		mean := float64(bias) / float64(total)
		t.Logf("%s: exact %d/%d, worst %d, mean error %+.4f", set.name, exact, total, worst, mean)
		if worst > 1 {
			t.Errorf("%s: worst channel error %d, want at most 1", set.name, worst)
		}
		if float64(exact) < set.minExact*float64(total) {
			t.Errorf("%s: %d of %d channels exact, want at least %.0f%%", set.name, exact, total, 100*set.minExact)
		}
		if mean > 0.01 || mean < -0.01 {
			t.Errorf("%s: mean error %+.4f, want within 0.01", set.name, mean)
		}
	}
}

// The table corners are exact sharp output: no ink is white, and the
// table is the 17^4 grid the evaluator indexes.
func TestCMYKTableShape(t *testing.T) {
	if len(cmykLUT) != cmykNodes*cmykNodes*cmykNodes*cmykNodes*3*2 {
		t.Fatalf("table has %d bytes", len(cmykLUT))
	}
	if r, g, b := cmykToSRGB(0, 0, 0, 0); r != 255 || g != 255 || b != 255 {
		t.Errorf("no ink is %d,%d,%d, want white", r, g, b)
	}
}

// Go's image/jpeg decodes sharp's CMYK JPEG (Adobe, inverted) to the
// same ink values libjpeg gives libvips, so the table applies to them;
// the decode goes through the sRGB transform, not image/color's naive
// CMYK formula (which measured cmyk.jpg 2.9 to 3.5 grey levels brighter).
func TestCMYKJPEGDecodesThroughTable(t *testing.T) {
	b := fixture(t, "cmyk.jpg")
	raw, err := jpeg.Decode(bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	c, ok := raw.(*image.CMYK)
	if !ok {
		t.Fatalf("decoded %T, want *image.CMYK", raw)
	}
	px := pixels(raw, FormatJPEG)
	for _, p := range []image.Point{{0, 0}, {123, 45}, {399, 299}} {
		o := c.PixOffset(p.X, p.Y)
		wr, wg, wb := cmykToSRGB(c.Pix[o], c.Pix[o+1], c.Pix[o+2], c.Pix[o+3])
		r, g, bb, _ := px.At(p.X, p.Y).RGBA()
		if uint8(r>>8) != wr || uint8(g>>8) != wg || uint8(bb>>8) != wb {
			t.Errorf("pixel %v: %d,%d,%d, table %d,%d,%d", p, r>>8, g>>8, bb>>8, wr, wg, wb)
		}
	}
}
