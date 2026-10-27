// Package imaging is the Go port of apps/server/src/imaging: upload
// validation, normalisation and the image-quality check, with numeric
// parity against the Node build's sharp 0.35.5 / libvips 8.18.7 pipeline
// (fixtures/parity/images, recorded by scripts/parity/record-images.ts).
//
// Images are processed in memory only and never written to disk. Full
// decodes are serialised process-wide (one at a time; see decode.go), and
// every decode is preceded by a header-only size check, so a decompression
// bomb is rejected before any pixel buffer is allocated. Within the 40 MP
// cap a single decode can still need a few hundred MB (a progressive JPEG
// or a 16-bit PNG), so deployments should set GOMEMLIMIT.
package imaging

import (
	"bytes"
	"image"
	"image/jpeg"
	"image/png"

	"golang.org/x/image/webp"

	"github.com/medilens-ai/medilens/internal/contracts"
)

const (
	// MaxImageBytes is the largest accepted upload, checked before any
	// decoding (config.ts MAX_IMAGE_BYTES).
	MaxImageBytes = 8 * 1024 * 1024
	// MaxImagePixels is the largest accepted width x height, checked from
	// the header before decoding: the decompression-bomb guard
	// (config.ts MAX_IMAGE_PIXELS).
	MaxImagePixels = 40_000_000
)

// Format is an accepted upload format. The values are validate.ts
// ImageFormat.
type Format string

const (
	FormatJPEG Format = "jpeg"
	FormatPNG  Format = "png"
	FormatWebP Format = "webp"
)

// Error is a rejected image, carrying the contract error code.
type Error struct {
	Code contracts.ErrorCode
}

func (e *Error) Error() string { return string(e.Code) }

var (
	// ErrInvalidImage: not a JPEG, PNG or WebP, unparseable, undecodable,
	// or over MaxImagePixels.
	ErrInvalidImage = &Error{Code: contracts.ErrInvalidImage}
	// ErrImageTooLarge: over MaxImageBytes.
	ErrImageTooLarge = &Error{Code: contracts.ErrImageTooLarge}
)

var pngSignature = []byte{0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A}

// sniff identifies the format from its magic bytes only. It does not use
// image.RegisterFormat, so an import that registers GIF or BMP cannot
// widen the accepted set.
func sniff(b []byte) (Format, bool) {
	switch {
	case len(b) >= 3 && b[0] == 0xFF && b[1] == 0xD8 && b[2] == 0xFF:
		return FormatJPEG, true
	case len(b) >= 8 && bytes.Equal(b[:8], pngSignature):
		return FormatPNG, true
	case len(b) >= 16 && string(b[0:4]) == "RIFF" && string(b[8:12]) == "WEBP":
		switch string(b[12:16]) {
		case "VP8 ", "VP8L", "VP8X":
			return FormatWebP, true
		}
	}
	return "", false
}

// decodeConfig reads the header only, with the decoder of the sniffed
// format.
func decodeConfig(f Format, b []byte) (image.Config, error) {
	r := bytes.NewReader(b)
	switch f {
	case FormatJPEG:
		return jpeg.DecodeConfig(r)
	case FormatPNG:
		return png.DecodeConfig(r)
	case FormatWebP:
		return webp.DecodeConfig(r)
	}
	return image.Config{}, ErrInvalidImage
}

// Validate mirrors validateImage: the byte size first (no look at an
// oversized upload), then the magic bytes and a header-only read of the
// dimensions, which must be positive with width x height at most
// MaxImagePixels. It returns ErrImageTooLarge or ErrInvalidImage.
func Validate(b []byte) (Format, error) {
	f, _, err := validate(b)
	return f, err
}

func validate(b []byte) (Format, image.Config, error) {
	if len(b) > MaxImageBytes {
		return "", image.Config{}, ErrImageTooLarge
	}
	f, ok := sniff(b)
	if !ok {
		return "", image.Config{}, ErrInvalidImage
	}
	cfg, err := decodeConfig(f, b)
	if err != nil || cfg.Width <= 0 || cfg.Height <= 0 ||
		int64(cfg.Width)*int64(cfg.Height) > MaxImagePixels {
		return "", image.Config{}, ErrInvalidImage
	}
	return f, cfg, nil
}
