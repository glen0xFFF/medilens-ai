package imaging

import (
	"bytes"
	"image"
	"image/jpeg"
)

const (
	// MaxEdge is the box a normalised image fits inside.
	MaxEdge = 2048
	// JPEGQuality is the quality of the normalised JPEG.
	JPEGQuality = 85
)

// Normalize mirrors normalizeImage: apply the EXIF orientation, fit inside
// 2048x2048 without enlarging (Lanczos3, staged as sharp stages it: see
// resizeLikeSharp), and re-encode as a 3-channel (sRGB, 4:2:0) JPEG at
// quality 85. Alpha is flattened onto black, as sharp's JPEG output does.
// Like sharp, it resizes before rotating; the box is square, so the size
// is the same either way. It returns ErrImageTooLarge or ErrInvalidImage
// (analyze.ts maps a normalise failure to INVALID_IMAGE).
func Normalize(b []byte) ([]byte, error) {
	var out bytes.Buffer
	err := withDecoded(b, func(img image.Image, f Format) error {
		rgba := orient(resizeLikeSharp(img, f), orientation(f, b))
		if err := jpeg.Encode(&out, rgba, &jpeg.Options{Quality: JPEGQuality}); err != nil {
			return ErrInvalidImage
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}
