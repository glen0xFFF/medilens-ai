package imaging

import (
	"bytes"
	"encoding/binary"
	"errors"
	"runtime"
	"testing"

	"github.com/medilens-ai/medilens/internal/contracts"
)

// The Node limits (apps/server/src/config.ts), as recorded.
func TestLimitsMatchNode(t *testing.T) {
	ref := loadReference(t)
	if MaxImageBytes != 8*1024*1024 || MaxImageBytes != ref.MaxImageBytes {
		t.Errorf("MaxImageBytes = %d, Node %d", MaxImageBytes, ref.MaxImageBytes)
	}
	if MaxImagePixels != 40_000_000 || MaxImagePixels != ref.MaxImagePixels {
		t.Errorf("MaxImagePixels = %d, Node %d", MaxImagePixels, ref.MaxImagePixels)
	}
}

func TestValidateAcceptsJPEGPNGAndWebP(t *testing.T) {
	for _, c := range []struct {
		file string
		want Format
	}{
		{"sharp.jpg", FormatJPEG},
		{"sharp.png", FormatPNG},
		{"sharp.webp", FormatWebP},
		{"sharp-lossless.webp", FormatWebP},
	} {
		f, err := Validate(fixture(t, c.file))
		if err != nil || f != c.want {
			t.Errorf("%s: Validate = %q, %v; want %q", c.file, f, err, c.want)
		}
	}
}

func TestValidateRejectsOver8MiBBeforeLookingAtTheBytes(t *testing.T) {
	// A 9 MB zero buffer, and a 9 MB buffer that starts with a valid JPEG
	// (validate.test.ts: size is checked before format).
	jpg := fixture(t, "sharp.jpg")
	padded := append(append([]byte{}, jpg...), make([]byte, 9*1024*1024-len(jpg))...)
	for name, b := range map[string][]byte{"zeros": make([]byte, 9*1024*1024), "jpeg+padding": padded} {
		if _, err := Validate(b); !errors.Is(err, ErrImageTooLarge) {
			t.Errorf("%s: Validate = %v, want IMAGE_TOO_LARGE", name, err)
		}
	}
	// Exactly 8 MiB is not too large.
	exact := append(append([]byte{}, jpg...), make([]byte, MaxImageBytes-len(jpg))...)
	if _, err := Validate(exact); errors.Is(err, ErrImageTooLarge) {
		t.Errorf("8 MiB exactly: %v", err)
	}
}

func TestValidateRejectsWhatIsNotAnAcceptedImage(t *testing.T) {
	jpg := fixture(t, "sharp.jpg")
	for name, b := range map[string][]byte{
		"truncated GIF header": []byte("GIF89a…"),
		"text file":            []byte("Paracetamol 500mg\nTake two tablets.\n"),
		"empty":                {},
		"real GIF":             fixture(t, "sharp.gif"),
		"JPEG magic only":      {0xFF, 0xD8, 0xFF},
		"truncated JPEG":       jpg[:20],
		"PNG signature only":   {0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A},
		"RIFF not WEBP":        []byte("RIFF\x10\x00\x00\x00AVI LIST"),
	} {
		f, err := Validate(b)
		if !errors.Is(err, ErrInvalidImage) {
			t.Errorf("%s: Validate = %q, %v; want INVALID_IMAGE", name, f, err)
		}
	}
}

func TestErrorsCarryTheContractCodes(t *testing.T) {
	for err, want := range map[error]contracts.ErrorCode{
		ErrInvalidImage:  contracts.ErrInvalidImage,
		ErrImageTooLarge: contracts.ErrImageTooLarge,
	} {
		var e *Error
		if !errors.As(err, &e) || e.Code != want || err.Error() != string(want) {
			t.Errorf("%v: code %v, want %v", err, e, want)
		}
	}
}

// The decompression bomb of validate.test.ts: a 7000x7000 PNG (49 MP, over
// the 40 MP cap) of about 150 KB. It is rejected from its header: no full
// decode runs, and Validate allocates nowhere near the 147 MB the pixels
// would take.
func TestDecompressionBombRejectedBeforeDecode(t *testing.T) {
	huge := fixture(t, "huge.png")
	if len(huge) >= MaxImageBytes {
		t.Fatalf("fixture is %d bytes; the point is a small file", len(huge))
	}
	before := decodeCount.Load()

	var m0, m1 runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&m0)
	_, err := Validate(huge)
	runtime.ReadMemStats(&m1)
	if !errors.Is(err, ErrInvalidImage) {
		t.Fatalf("Validate(7000x7000 PNG) = %v, want INVALID_IMAGE", err)
	}
	if alloc := m1.TotalAlloc - m0.TotalAlloc; alloc > 4<<20 {
		t.Errorf("Validate allocated %d bytes on a bomb header", alloc)
	}

	if _, err := Normalize(huge); !errors.Is(err, ErrInvalidImage) {
		t.Errorf("Normalize(7000x7000 PNG) = %v, want INVALID_IMAGE", err)
	}
	if _, err := AssessWith(huge, DefaultThresholds()); !errors.Is(err, ErrInvalidImage) {
		t.Errorf("AssessWith(7000x7000 PNG) = %v, want INVALID_IMAGE", err)
	}
	if n := decodeCount.Load() - before; n != 0 {
		t.Errorf("%d full decodes ran on a bomb", n)
	}
}

// A JPEG whose SOF claims 65500x65500 (4.3 GP) is rejected from its header.
func TestJPEGBombHeaderRejectedBeforeDecode(t *testing.T) {
	b := append([]byte{}, fixture(t, "sharp.jpg")...)
	patched := false
	for i := 2; i+9 < len(b) && b[i] == 0xFF; {
		marker := b[i+1]
		if marker == 0xC0 || marker == 0xC2 {
			binary.BigEndian.PutUint16(b[i+5:], 65500) // height
			binary.BigEndian.PutUint16(b[i+7:], 65500) // width
			patched = true
			break
		}
		i += 2 + int(binary.BigEndian.Uint16(b[i+2:]))
	}
	if !patched {
		t.Fatal("no SOF in sharp.jpg")
	}
	before := decodeCount.Load()
	if _, err := Validate(b); !errors.Is(err, ErrInvalidImage) {
		t.Errorf("Validate = %v, want INVALID_IMAGE", err)
	}
	if _, err := Normalize(b); !errors.Is(err, ErrInvalidImage) {
		t.Errorf("Normalize = %v, want INVALID_IMAGE", err)
	}
	if n := decodeCount.Load() - before; n != 0 {
		t.Errorf("%d full decodes ran on a bomb", n)
	}
}

// Exactly 40 MP passes the pixel cap and one pixel more fails, from the
// header alone (a PNG IHDR with no image data behind it).
func TestPixelCapBoundary(t *testing.T) {
	header := func(w, h uint32) []byte {
		var b bytes.Buffer
		b.Write([]byte{0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A})
		ihdr := make([]byte, 13)
		binary.BigEndian.PutUint32(ihdr[0:], w)
		binary.BigEndian.PutUint32(ihdr[4:], h)
		ihdr[8], ihdr[9] = 8, 0 // 8-bit grey
		writePNGChunk(&b, "IHDR", ihdr)
		return b.Bytes()
	}
	if _, err := Validate(header(8000, 5000)); err != nil {
		t.Errorf("8000x5000 (40 MP): %v", err)
	}
	if _, err := Validate(header(40_000_001, 1)); !errors.Is(err, ErrInvalidImage) {
		t.Errorf("40,000,001 x 1: %v, want INVALID_IMAGE", err)
	}
	if _, err := Validate(header(7000, 7000)); !errors.Is(err, ErrInvalidImage) {
		t.Errorf("7000x7000: %v, want INVALID_IMAGE", err)
	}
}

// Every parity image gets the same validateImage verdict as Node.
func TestValidateParity(t *testing.T) {
	for _, im := range loadReference(t).Images {
		f, err := Validate(fixture(t, im.File))
		if im.Validate.OK {
			if err != nil || string(f) != im.Validate.Format {
				t.Errorf("%s: Validate = %q, %v; Node ok %q", im.File, f, err, im.Validate.Format)
			}
			continue
		}
		var e *Error
		if !errors.As(err, &e) || string(e.Code) != im.Validate.Code {
			t.Errorf("%s: Validate = %v; Node %s", im.File, err, im.Validate.Code)
		}
	}
}

func FuzzValidate(f *testing.F) {
	for _, file := range []string{"sharp.jpg", "sharp.png", "sharp.webp", "sharp-lossless.webp", "orient6.webp"} {
		b := fixture(f, file)
		f.Add(b[:min(len(b), 512)])
	}
	f.Add([]byte("GIF89a"))
	f.Fuzz(func(t *testing.T, b []byte) {
		f, err := Validate(b)
		if err == nil && f != FormatJPEG && f != FormatPNG && f != FormatWebP {
			t.Fatalf("accepted format %q", f)
		}
	})
}
