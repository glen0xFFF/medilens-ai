package imaging

import (
	"bytes"
	"encoding/binary"
	"errors"
	"image/color"
	"os"
	"sync"
	"testing"
)

// validate.test.ts "outputs JPEG and keeps a small image at its size".
func TestNormalizeKeepsASmallImageAtItsSize(t *testing.T) {
	out, err := Normalize(fixture(t, "sharp.png"))
	if err != nil {
		t.Fatal(err)
	}
	if cfg := jpegConfig(t, out); cfg.Width != 800 || cfg.Height != 600 {
		t.Errorf("got %dx%d, want 800x600", cfg.Width, cfg.Height)
	}
}

// validate.test.ts "resizes a large image to fit inside 2048 keeping aspect ratio".
func TestNormalizeFitsInside2048(t *testing.T) {
	for _, c := range []struct {
		file string
		w, h int
	}{{"wide.jpg", 2048, 683}, {"tall.jpg", 512, 2048}} {
		out, err := Normalize(fixture(t, c.file))
		if err != nil {
			t.Fatal(err)
		}
		if cfg := jpegConfig(t, out); cfg.Width != c.w || cfg.Height != c.h {
			t.Errorf("%s: got %dx%d, want %dx%d", c.file, cfg.Width, cfg.Height, c.w, c.h)
		}
	}
}

func TestFitInsideMatchesSharp(t *testing.T) {
	for _, c := range []struct{ w, h, ww, wh int }{
		{800, 600, 800, 600},     // never enlarges
		{2048, 2048, 2048, 2048}, // already fits
		{3000, 1000, 2048, 683},  // 682.67 rounds up
		{600, 2400, 512, 2048},
		{4096, 1001, 2048, 501}, // 500.5 rounds half up, as sharp does (half-even would give 500)
		{2049, 1, 2048, 1},      // an axis never reaches 0
	} {
		w, h := fitInside(c.w, c.h, MaxEdge)
		if w != c.ww || h != c.wh {
			t.Errorf("fitInside(%d, %d) = %dx%d, want %dx%d", c.w, c.h, w, h, c.ww, c.wh)
		}
	}
}

// The output size sharp's fit-inside resize gives for the recorded input
// sizes (edge cases plus a seeded sample).
func TestFitInsideParity(t *testing.T) {
	ref := loadReference(t)
	if len(ref.Fit) < 100 {
		t.Fatalf("only %d recorded sizes", len(ref.Fit))
	}
	for _, c := range ref.Fit {
		w, h := fitInside(c[0], c[1], MaxEdge)
		if w != c[2] || h != c[3] {
			t.Errorf("fitInside(%d, %d) = %dx%d, sharp %dx%d", c[0], c[1], w, h, c[2], c[3])
		}
	}
}

// validate.test.ts "applies EXIF orientation", for JPEG, PNG and WebP.
func TestNormalizeAppliesEXIFOrientation6(t *testing.T) {
	for _, file := range []string{"orient6.jpg", "orient6.png", "orient6.webp"} {
		out, err := Normalize(fixture(t, file))
		if err != nil {
			t.Fatalf("%s: %v", file, err)
		}
		if cfg := jpegConfig(t, out); cfg.Width != 600 || cfg.Height != 800 {
			t.Errorf("%s: got %dx%d, want 600x800", file, cfg.Width, cfg.Height)
		}
	}
}

func TestNormalizeDecodesWebP(t *testing.T) {
	for _, file := range []string{"sharp.webp", "sharp-lossless.webp"} {
		out, err := Normalize(fixture(t, file))
		if err != nil {
			t.Fatalf("%s: %v", file, err)
		}
		if cfg := jpegConfig(t, out); cfg.Width != 800 || cfg.Height != 600 {
			t.Errorf("%s: got %dx%d", file, cfg.Width, cfg.Height)
		}
		if q := Assess(out); !q.OK {
			t.Errorf("%s: the sharp pattern as WebP is not ok after Normalize: %+v", file, q)
		}
	}
}

// sharp writes sRGB output, so even a grey upload comes out as a 3-channel
// JPEG; the Go output is the same shape.
func TestNormalizeWritesAThreeChannelJPEG(t *testing.T) {
	for _, file := range []string{"sharp.jpg", "sharp.png", "grey16.png", "alpha.png", "colour.png"} {
		out, err := Normalize(fixture(t, file))
		if err != nil {
			t.Fatalf("%s: %v", file, err)
		}
		if m := jpegConfig(t, out).ColorModel; m != color.YCbCrModel {
			t.Errorf("%s: colour model %v, want YCbCr", file, m)
		}
	}
}

// The luminance quantisation table of the output is the IJG standard table
// scaled for quality 85, which is what sharp's jpeg({quality: 85}) writes.
func TestNormalizeEncodesAtQuality85(t *testing.T) {
	out, err := Normalize(fixture(t, "sharp.jpg"))
	if err != nil {
		t.Fatal(err)
	}
	// Annex K luminance table, in zigzag order (as stored in DQT).
	base := [64]int{
		16, 11, 12, 14, 12, 10, 16, 14, 13, 14, 18, 17, 16, 19, 24, 40,
		26, 24, 22, 22, 24, 49, 35, 37, 29, 40, 58, 51, 61, 60, 57, 51,
		56, 55, 64, 72, 92, 78, 64, 68, 87, 69, 55, 56, 80, 109, 81, 87,
		95, 98, 103, 104, 103, 62, 77, 113, 121, 112, 100, 120, 92, 101, 103, 99,
	}
	scale := 200 - 2*85
	var want [64]byte
	for i, b := range base {
		q := (b*scale + 50) / 100
		want[i] = byte(min(max(q, 1), 255))
	}
	got, ok := firstDQT(out)
	if !ok {
		t.Fatal("no DQT in output")
	}
	if got != want {
		t.Errorf("luminance table %v, want %v", got, want)
	}
}

// firstDQT returns the first 8-bit quantisation table (table 0) of a JPEG.
func firstDQT(b []byte) ([64]byte, bool) {
	for i := 2; i+4 <= len(b) && b[i] == 0xFF; {
		marker := b[i+1]
		n := int(binary.BigEndian.Uint16(b[i+2:]))
		if marker == 0xDB && i+4+65 <= len(b) && b[i+4] == 0 {
			var q [64]byte
			copy(q[:], b[i+5:i+5+64])
			return q, true
		}
		if marker == 0xDA {
			break
		}
		i += 2 + n
	}
	return [64]byte{}, false
}

// A header that parses but data that does not decode is INVALID_IMAGE, as in
// the Node pipeline (normalizeImage throws, analyze.ts maps it).
func TestNormalizeRejectsUndecodableData(t *testing.T) {
	jpg := fixture(t, "sharp.jpg")
	truncated := jpg[:len(jpg)/2]
	if _, err := Validate(truncated); err != nil {
		t.Fatalf("the truncated JPEG should pass the header check: %v", err)
	}
	if _, err := Normalize(truncated); !errors.Is(err, ErrInvalidImage) {
		t.Errorf("Normalize(truncated JPEG) = %v, want INVALID_IMAGE", err)
	}
	if _, err := Normalize([]byte("not an image")); !errors.Is(err, ErrInvalidImage) {
		t.Errorf("Normalize(text) = %v, want INVALID_IMAGE", err)
	}
}

// At most one image is decoded at a time, process-wide, however many
// callers there are.
func TestDecodeSemaphoreAdmitsOneImageAtATime(t *testing.T) {
	inputs := [][]byte{fixture(t, "sharp.jpg"), fixture(t, "sharp.png"), fixture(t, "sharp.webp"), fixture(t, "colour.png")}
	maxInFlight.Store(0)
	var wg sync.WaitGroup
	errs := make(chan error, 2*4*len(inputs))
	for range 4 {
		for _, b := range inputs {
			wg.Add(2)
			go func() {
				defer wg.Done()
				_, err := Normalize(b)
				errs <- err
			}()
			go func() {
				defer wg.Done()
				_, err := AssessWith(b, DefaultThresholds())
				errs <- err
			}()
		}
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	if m := maxInFlight.Load(); m != 1 {
		t.Errorf("max decodes in flight = %d, want 1", m)
	}
	if n := inFlight.Load(); n != 0 {
		t.Errorf("%d decodes still in flight", n)
	}
}

// Images never touch disk: with the temp dir pointed at an empty
// directory, normalising and assessing every parity image leaves it empty.
func TestImagingNeverWritesToDisk(t *testing.T) {
	tmp := t.TempDir()
	for _, k := range []string{"TMPDIR", "TMP", "TEMP"} {
		t.Setenv(k, tmp)
	}
	if os.TempDir() != tmp {
		t.Fatalf("os.TempDir() = %q, want %q", os.TempDir(), tmp)
	}
	for _, im := range loadReference(t).Images {
		b := fixture(t, im.File)
		_, _ = Validate(b)
		if out, err := Normalize(b); err == nil {
			_ = Assess(out)
		}
		_ = Assess(b)
	}
	entries, err := os.ReadDir(tmp)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Errorf("imaging wrote %d entries to the temp dir", len(entries))
	}
}

func TestNormalizeIsDeterministic(t *testing.T) {
	b := fixture(t, "orient6.jpg")
	a1, err1 := Normalize(b)
	a2, err2 := Normalize(b)
	if err1 != nil || err2 != nil || !bytes.Equal(a1, a2) {
		t.Errorf("two runs differ (%v, %v)", err1, err2)
	}
}
