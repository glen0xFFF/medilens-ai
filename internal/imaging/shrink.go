package imaging

import (
	"image"
	"image/draw"
	"math"
)

// resizeLikeSharp is the resize half of normalizeImage, staged as sharp
// 0.35.5 stages it (pipeline.cc) so the result stays on the calibrated
// sharpness scale for large uploads too:
//
//  1. The shrink: the larger of width/2048 and height/2048, never below 1
//     (withoutEnlargement), each axis clamped so it cannot reach 0
//     (common.cc ResolveShrink).
//  2. Shrink on load, when the image shrinks at all:
//     - JPEG: libjpeg's DCT scaling by 2, 4 or 8 (jpegShrinkOnLoad). Its
//     reduced IDCT outputs the averages of 2x2, 4x4 or 8x8 blocks of the
//     full IDCT (jidctred.c), so a box average of the decoded pixels
//     reproduces it up to rounding.
//     - WebP: libwebp decodes straight to the scaled size (webpRescale).
//  3. libvips resize of what is left (resize.c, reducev/reduceh with gap
//     2): a box shrink by floor(ratio/2) on an axis whose ratio is 4 or
//     more, then Lanczos3 to the fit-inside size of the loaded image.
//
// raw is the decoder's output (for WebP, before colour conversion).
func resizeLikeSharp(raw image.Image, f Format) *image.RGBA {
	bd := raw.Bounds()
	w, h := bd.Dx(), bd.Dy()
	hs, vs := resolveShrink(w, h, MaxEdge)
	if hs == 1 && vs == 1 {
		return toRGBA(pixels(raw, f))
	}
	shrink := math.Min(hs, vs)
	var img *image.RGBA
	switch f {
	case FormatJPEG:
		s := jpegShrinkOnLoad(shrink)
		if s == 1 {
			// A full-size load: libjpeg's own colour conversion.
			img = toRGBA(pixels(raw, f))
			break
		}
		// The scaled IDCT scales chroma to the scaled luma size, so no
		// upsampling filter runs: a box average of the decode stands in.
		cmyk, isCMYK := raw.(*image.CMYK)
		if isCMYK {
			img = cmykPlanes(cmyk)
		} else {
			img = toRGBA(raw)
		}
		img = boxShrink(img, s, s)
		// libvips converts CMYK to sRGB after the scaled load, before the
		// resize.
		if isCMYK {
			img = cmykToRGBA(img)
		}
	case FormatWebP:
		// libvips webp2vips.c: rint(canvas * scale), with scale = 1/shrink.
		scale := 1.0 / shrink
		sw := int(math.RoundToEven(float64(w) * scale))
		sh := int(math.RoundToEven(float64(h) * scale))
		img = toRGBA(webpRescale(raw, sw, sh))
	default:
		img = toRGBA(raw)
	}
	tw, th := fitInside(img.Rect.Dx(), img.Rect.Dy(), MaxEdge)
	return reduce(img, tw, th)
}

// resolveShrink is sharp's ResolveShrink for fit 'inside' with
// withoutEnlargement.
func resolveShrink(w, h, max int) (float64, float64) {
	s := math.Max(1, math.Max(float64(w)/float64(max), float64(h)/float64(max)))
	return math.Min(s, float64(w)), math.Min(s, float64(h))
}

// jpegShrinkOnLoad is sharp's JPEG shrink-on-load factor with
// fastShrinkOnLoad (the default): the largest of 8, 4, 2 not above the
// shrink, halved when the shrink truncates to exactly that factor.
func jpegShrinkOnLoad(shrink float64) int {
	s := 1
	switch {
	case shrink >= 8:
		s = 8
	case shrink >= 4:
		s = 4
	case shrink >= 2:
		s = 2
	}
	if s > 1 && int(shrink) == s {
		s /= 2
	}
	return s
}

// reduce is libvips resize to tw x th with the Lanczos3 kernel and a
// reducing gap of 2.
func reduce(img *image.RGBA, tw, th int) *image.RGBA {
	w, h := img.Rect.Dx(), img.Rect.Dy()
	if tw == w && th == h {
		return img
	}
	ih := max(1, int(math.Floor(float64(w)/float64(tw)/2)))
	iv := max(1, int(math.Floor(float64(h)/float64(th)/2)))
	if ih > 1 || iv > 1 {
		img = boxShrink(img, ih, iv)
	}
	if img.Rect.Dx() == tw && img.Rect.Dy() == th {
		return img
	}
	return scale(img, tw, th)
}

// boxShrink averages sx x sy blocks (the last ones partial), rounding to
// nearest: vips_shrinkh/v with ceil, and libjpeg's scaled IDCT.
func boxShrink(img *image.RGBA, sx, sy int) *image.RGBA {
	w, h := img.Rect.Dx(), img.Rect.Dy()
	ow, oh := (w+sx-1)/sx, (h+sy-1)/sy
	out := image.NewRGBA(image.Rect(0, 0, ow, oh))
	for oy := range oh {
		y0, y1 := oy*sy, min((oy+1)*sy, h)
		for ox := range ow {
			x0, x1 := ox*sx, min((ox+1)*sx, w)
			var sum [4]int
			for y := y0; y < y1; y++ {
				row := img.Pix[y*img.Stride:]
				for x := x0; x < x1; x++ {
					for c := range 4 {
						sum[c] += int(row[4*x+c])
					}
				}
			}
			n := (x1 - x0) * (y1 - y0)
			o := oy*out.Stride + 4*ox
			for c := range 4 {
				out.Pix[o+c] = uint8((sum[c] + n/2) / n)
			}
		}
	}
	return out
}

// pixels is the decoded image in display colours: lossy WebP goes through
// libwebp's YUV conversion (webpToNRGBA), a YCbCr JPEG through libjpeg's
// upsampling and conversion (jpegToRGBA), a CMYK (or YCCK) JPEG through
// sharp's CMYK to sRGB transform (cmykToSRGB); everything else is as
// decoded.
func pixels(raw image.Image, f Format) image.Image {
	if f == FormatWebP {
		return webpToNRGBA(raw)
	}
	switch t := raw.(type) {
	case *image.CMYK:
		return cmykToRGBA(cmykPlanes(t))
	case *image.YCbCr:
		if f == FormatJPEG {
			return jpegToRGBA(t)
		}
	}
	return raw
}

// toRGBA copies img into a premultiplied RGBA image at the origin.
func toRGBA(img image.Image) *image.RGBA {
	if r, ok := img.(*image.RGBA); ok && r.Rect.Min == (image.Point{}) {
		return r
	}
	bd := img.Bounds()
	out := image.NewRGBA(image.Rect(0, 0, bd.Dx(), bd.Dy()))
	draw.Draw(out, out.Bounds(), img, bd.Min, draw.Src)
	return out
}
