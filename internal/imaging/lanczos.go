package imaging

import (
	"image"
	"math"

	xdraw "golang.org/x/image/draw"
)

// lanczos3 is sharp's default resize kernel ('lanczos3'). Its shape is
// libvips'; libvips' fixed-point reduce is not replicated, and the parity
// set bounds the difference. A cheaper kernel
// shifts the calibrated sharpness scale: CatmullRom reads about 5% low and
// bilinear can turn a sharp image BLURRY (research notes, imaging.md §2).
var lanczos3 = &xdraw.Kernel{Support: 3, At: func(t float64) float64 {
	if t == 0 {
		return 1
	}
	if t >= 3 {
		return 0
	}
	pt := math.Pi * t
	return 3 * math.Sin(pt) * math.Sin(pt/3) / (pt * pt)
}}

// fitInside is sharp's resize({width: max, height: max, fit: 'inside',
// withoutEnlargement: true}) size: one shrink factor for both axes (the
// larger), never below 1, never sending an axis to 0, and the output size
// rounded half up (as recorded from sharp, fixtures/parity/images "fit").
func fitInside(w, h, max int) (int, int) {
	hs, vs := resolveShrink(w, h, max)
	return int(math.Floor(float64(w)/hs + 0.5)), int(math.Floor(float64(h)/vs + 0.5))
}

// scale resizes img to w x h with the Lanczos3 kernel.
func scale(img image.Image, w, h int) *image.RGBA {
	dst := image.NewRGBA(image.Rect(0, 0, w, h))
	lanczos3.Scale(dst, dst.Bounds(), img, img.Bounds(), xdraw.Src, nil)
	return dst
}
