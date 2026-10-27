package imaging

import (
	"bytes"
	"image"
	"image/jpeg"
	"image/png"
	"sync/atomic"

	"golang.org/x/image/webp"
)

// decodeSlot admits one full decode at a time, process-wide. It is held
// from the decode until the caller is done with the decoded pixels, so at
// most one decoded image (plus its working copies) is in memory.
var decodeSlot = make(chan struct{}, 1)

// Test hooks: full decodes started, and decodes holding the slot now and
// at most.
var decodeCount, inFlight, maxInFlight atomic.Int64

// withDecoded validates b (header only), then, holding the decode slot,
// decodes it fully and calls use with the decoder's output (for a lossy
// WebP still in YCbCr: see pixels). Any decode failure is ErrInvalidImage;
// an error from use is returned as is.
func withDecoded(b []byte, use func(img image.Image, f Format) error) error {
	f, cfg, err := validate(b)
	if err != nil {
		return err
	}
	decodeSlot <- struct{}{}
	defer func() { <-decodeSlot }()
	n := inFlight.Add(1)
	defer inFlight.Add(-1)
	for m := maxInFlight.Load(); n > m && !maxInFlight.CompareAndSwap(m, n); m = maxInFlight.Load() {
	}
	decodeCount.Add(1)

	img, err := decodeFull(f, b)
	if err != nil {
		return ErrInvalidImage
	}
	// The header was checked against the pixel cap; the image must be the
	// size the header said.
	if bd := img.Bounds(); bd.Dx() != cfg.Width || bd.Dy() != cfg.Height {
		return ErrInvalidImage
	}
	return use(img, f)
}

// decodeFull decodes with the sniffed format's decoder. A decoder panic on
// hostile input is an invalid image, not a crash. A lossy WebP comes back
// as x/image/webp returns it (YCbCr), because a scaled load works on the
// planes.
func decodeFull(f Format, b []byte) (img image.Image, err error) {
	defer func() {
		if recover() != nil {
			img, err = nil, ErrInvalidImage
		}
	}()
	r := bytes.NewReader(b)
	switch f {
	case FormatJPEG:
		return jpeg.Decode(r)
	case FormatPNG:
		return png.Decode(r)
	case FormatWebP:
		return webp.Decode(r)
	}
	return nil, ErrInvalidImage
}

// webpToNRGBA converts lossy WebP output with libwebp's own colour maths.
//
// x/image/webp returns VP8 frames as *image.YCbCr / *image.NYCbCrA, which
// Go treats as full-range JFIF YCbCr. libwebp (and so libvips/sharp)
// decodes VP8 as limited-range BT.601 (vp8YUVToRGB). Without this the
// parity fixture loses 4.9 grey levels of luminance and 14% of its
// sharpness (golang/go#19672). Chroma is sampled nearest-neighbour;
// libwebp's "fancy" upsampling differs only on colour edges. Lossless VP8L
// decodes to NRGBA already and is returned unchanged.
func webpToNRGBA(m image.Image) image.Image {
	var yc *image.YCbCr
	var alpha []uint8
	var astride int
	switch t := m.(type) {
	case *image.YCbCr:
		yc = t
	case *image.NYCbCrA:
		yc, alpha, astride = &t.YCbCr, t.A, t.AStride
	default:
		return m
	}
	b := yc.Rect
	out := image.NewNRGBA(image.Rect(0, 0, b.Dx(), b.Dy()))
	for y := b.Min.Y; y < b.Max.Y; y++ {
		for x := b.Min.X; x < b.Max.X; x++ {
			ci := yc.COffset(x, y)
			o := out.PixOffset(x-b.Min.X, y-b.Min.Y)
			out.Pix[o+0], out.Pix[o+1], out.Pix[o+2] = vp8YUVToRGB(yc.Y[yc.YOffset(x, y)], yc.Cb[ci], yc.Cr[ci])
			a := uint8(255)
			if alpha != nil {
				a = alpha[(y-b.Min.Y)*astride+(x-b.Min.X)]
			}
			out.Pix[o+3] = a
		}
	}
	return out
}
