package imaging

import (
	"image"
	"image/draw"
)

// webpRescale is libvips' WebP load with a scale (webp2vips.c, used by
// sharp for any WebP that shrinks: pipeline.cc "fastShrinkOnLoad"), that is
// libwebp 1.6.0 decoding straight to w x h through its rescaler:
//
//   - lossy (VP8): the Y plane, and the U and V planes from their 4:2:0
//     size, are each rescaled to w x h (io_dec.c InitRGBRescaler), then
//     converted per pixel with the VP8 YUV-to-RGB formulas; an alpha
//     plane is rescaled on its own and stays unpremultiplied (MODE_RGBA);
//   - lossless (VP8L): the ARGB rows are premultiplied, rescaled and
//     unpremultiplied (vp8l_dec.c EmitRescaledRowsRGBA).
//
// libwebp also skips the VP8 loop filter when both axes shrink below 3/4
// (webp_dec.c bypass_filtering); x/image/vp8 always filters, so that one
// difference remains, and the parity set bounds it.
func webpRescale(m image.Image, w, h int) *image.NRGBA {
	out := image.NewNRGBA(image.Rect(0, 0, w, h))
	var yc *image.YCbCr
	var alpha []byte
	var astride int
	switch t := m.(type) {
	case *image.YCbCr:
		yc = t
	case *image.NYCbCrA:
		yc, alpha, astride = &t.YCbCr, t.A, t.AStride
	case *image.NRGBA:
		rescaleARGB(t, out)
		return out
	default: // x/image/webp returns only the three types above
		n := image.NewNRGBA(image.Rect(0, 0, m.Bounds().Dx(), m.Bounds().Dy()))
		draw.Draw(n, n.Rect, m, m.Bounds().Min, draw.Src)
		rescaleARGB(n, out)
		return out
	}
	sw, sh := yc.Rect.Dx(), yc.Rect.Dy()
	uvw, uvh := (sw+1)>>1, (sh+1)>>1
	ys := rescalePlane(yc.Y, yc.YStride, sw, sh, w, h, 1)
	us := rescalePlane(yc.Cb, yc.CStride, uvw, uvh, w, h, 1)
	vs := rescalePlane(yc.Cr, yc.CStride, uvw, uvh, w, h, 1)
	var as []byte
	if alpha != nil {
		as = rescalePlane(alpha, astride, sw, sh, w, h, 1)
	}
	for i := range w * h {
		r, g, b := vp8YUVToRGB(ys[i], us[i], vs[i])
		o := 4 * i
		out.Pix[o], out.Pix[o+1], out.Pix[o+2], out.Pix[o+3] = r, g, b, 255
		if as != nil {
			out.Pix[o+3] = as[i]
		}
	}
	return out
}

// vp8YUVToRGB is libwebp's VP8YuvToRgb (src/dsp/yuv.h): limited-range
// BT.601 in 14-bit fixed point.
func vp8YUVToRGB(y, u, v uint8) (uint8, uint8, uint8) {
	mulHi := func(v, c int) int { return (v * c) >> 8 }
	clip := func(v int) uint8 {
		if v&^((256<<6)-1) == 0 {
			return uint8(v >> 6)
		}
		if v < 0 {
			return 0
		}
		return 255
	}
	yy := mulHi(int(y), 19077)
	return clip(yy + mulHi(int(v), 26149) - 14234),
		clip(yy - mulHi(int(u), 6419) - mulHi(int(v), 13320) + 8708),
		clip(yy + mulHi(int(u), 33050) - 17685)
}

// rescaleARGB is the VP8L path: premultiply, rescale four channels,
// unpremultiply, with libwebp's 24-bit fixed-point alpha maths
// (alpha_processing.c WebPMultARGBRow_C, no tables).
func rescaleARGB(src, dst *image.NRGBA) {
	sw, sh := src.Rect.Dx(), src.Rect.Dy()
	pm := make([]byte, 4*sw*sh)
	for y := range sh {
		copy(pm[4*sw*y:4*sw*(y+1)], src.Pix[y*src.Stride:y*src.Stride+4*sw])
	}
	multRGBA(pm, false)
	out := rescalePlane(pm, 4*sw, sw, sh, dst.Rect.Dx(), dst.Rect.Dy(), 4)
	multRGBA(out, true)
	copy(dst.Pix, out)
}

func multRGBA(p []byte, inverse bool) {
	const mfix = 24
	const half = (1 << mfix) >> 1
	const kinv255 = (1 << mfix) / 255
	mult := func(x uint8, m uint32) uint8 { return uint8((uint32(x)*m + half) >> mfix) }
	for i := 0; i+4 <= len(p); i += 4 {
		a := uint32(p[i+3])
		switch a {
		case 255:
		case 0:
			p[i], p[i+1], p[i+2] = 0, 0, 0
		default:
			scale := a * kinv255
			if inverse {
				scale = (255 << mfix) / a
			}
			p[i], p[i+1], p[i+2] = mult(p[i], scale), mult(p[i+1], scale), mult(p[i+2], scale)
		}
	}
}

// rescalePlane runs libwebp's rescaler (src/utils/rescaler_utils.c and
// src/dsp/rescaler.c, the C versions) over a whole plane of n interleaved
// channels and returns the dw x dh result, rows packed.
func rescalePlane(src []byte, stride, sw, sh, dw, dh, n int) []byte {
	r := newRescaler(sw, sh, dw, dh, n)
	out := make([]byte, 0, dw*dh*n)
	y := 0
	for r.dstY < r.dstHeight {
		for y < sh && !r.hasPendingOutput() {
			r.importRow(src[y*stride : y*stride+sw*n])
			y++
		}
		if !r.hasPendingOutput() {
			break // input exhausted (does not happen for consistent sizes)
		}
		for r.hasPendingOutput() {
			out = append(out, r.exportRow()...)
		}
	}
	return out
}

const (
	rescalerRFix = 32
	rescalerOne  = uint64(1) << rescalerRFix
	rounder      = rescalerOne >> 1
)

func rescalerFrac(x, y uint64) uint32 { return uint32((x << rescalerRFix) / y) }
func multFix(x, y uint32) uint32      { return uint32((uint64(x)*uint64(y) + rounder) >> rescalerRFix) }
func multFixFloor(x, y uint32) uint32 { return uint32((uint64(x) * uint64(y)) >> rescalerRFix) }

type rescaler struct {
	xExpand, yExpand           bool
	numChannels                int
	fxScale, fyScale, fxyScale uint32
	xAdd, xSub                 int
	yAccum, yAdd, ySub         int
	srcWidth, srcHeight        int
	dstWidth, dstHeight        int
	srcY, dstY                 int
	irow, frow                 []uint32
	dst                        []byte
}

// newRescaler is WebPRescalerInit.
func newRescaler(sw, sh, dw, dh, n int) *rescaler {
	r := &rescaler{
		xExpand: sw < dw, yExpand: sh < dh, numChannels: n,
		srcWidth: sw, srcHeight: sh, dstWidth: dw, dstHeight: dh,
		irow: make([]uint32, n*dw), frow: make([]uint32, n*dw), dst: make([]byte, n*dw),
	}
	if r.xExpand {
		r.xAdd, r.xSub = dw-1, sw-1
	} else {
		r.xAdd, r.xSub = sw, dw
		r.fxScale = rescalerFrac(1, uint64(r.xSub))
	}
	if r.yExpand {
		r.yAdd, r.ySub = sh-1, dh-1
		r.yAccum = r.ySub
		r.fyScale = rescalerFrac(1, uint64(r.xAdd))
	} else {
		r.yAdd, r.ySub = sh, dh
		r.yAccum = r.yAdd
		ratio := uint64(dh) * rescalerOne / (uint64(r.xAdd) * uint64(r.yAdd))
		if ratio != uint64(uint32(ratio)) {
			r.fxyScale = 0
		} else {
			r.fxyScale = uint32(ratio)
		}
		r.fyScale = rescalerFrac(1, uint64(r.ySub))
	}
	return r
}

func (r *rescaler) hasPendingOutput() bool { return r.dstY < r.dstHeight && r.yAccum <= 0 }

// importRow is one step of WebPRescalerImport.
func (r *rescaler) importRow(src []byte) {
	if r.yExpand {
		r.irow, r.frow = r.frow, r.irow
	}
	if r.xExpand {
		r.importRowExpand(src)
	} else {
		r.importRowShrink(src)
	}
	if !r.yExpand {
		for x := range r.irow {
			r.irow[x] += r.frow[x]
		}
	}
	r.srcY++
	r.yAccum -= r.ySub
}

// importRowExpand is WebPRescalerImportRowExpand_C (bilinear).
func (r *rescaler) importRowExpand(src []byte) {
	n := r.numChannels
	xOutMax := r.dstWidth * n
	for ch := range n {
		xIn, xOut := ch, ch
		accum := r.xAdd
		left := uint32(src[xIn])
		right := left
		if r.srcWidth > 1 {
			right = uint32(src[xIn+n])
		}
		xIn += n
		for {
			r.frow[xOut] = right*uint32(r.xAdd) + (left-right)*uint32(accum)
			xOut += n
			if xOut >= xOutMax {
				break
			}
			accum -= r.xSub
			if accum < 0 {
				left = right
				xIn += n
				right = uint32(src[xIn])
				accum += r.xAdd
			}
		}
	}
}

// importRowShrink is WebPRescalerImportRowShrink_C (area average).
func (r *rescaler) importRowShrink(src []byte) {
	n := r.numChannels
	xOutMax := r.dstWidth * n
	for ch := range n {
		xIn, xOut := ch, ch
		var sum uint32
		accum := 0
		for xOut < xOutMax {
			var base uint32
			accum += r.xAdd
			for accum > 0 {
				accum -= r.xSub
				base = uint32(src[xIn])
				sum += base
				xIn += n
			}
			frac := base * uint32(-accum)
			r.frow[xOut] = sum*uint32(r.xSub) - frac
			sum = multFix(frac, r.fxScale)
			xOut += n
		}
	}
}

// exportRow is WebPRescalerExportRow; it returns the row written.
func (r *rescaler) exportRow() []byte {
	switch {
	case r.yExpand:
		r.exportRowExpand()
	case r.fxyScale != 0:
		r.exportRowShrink()
	default: // src_height == dst_height && x_add == 1
		for i := range r.dst {
			r.dst[i] = byte(r.irow[i])
			r.irow[i] = 0
		}
	}
	r.yAccum += r.yAdd
	r.dstY++
	return r.dst
}

func clip255(v uint32) byte {
	if v > 255 {
		return 255
	}
	return byte(v)
}

// exportRowExpand is WebPRescalerExportRowExpand_C.
func (r *rescaler) exportRowExpand() {
	if r.yAccum == 0 {
		for x, j := range r.frow {
			r.dst[x] = clip255(multFix(j, r.fyScale))
		}
		return
	}
	b := rescalerFrac(uint64(-r.yAccum), uint64(r.ySub))
	a := uint32(rescalerOne - uint64(b))
	for x := range r.frow {
		i := uint64(a)*uint64(r.frow[x]) + uint64(b)*uint64(r.irow[x])
		j := uint32((i + rounder) >> rescalerRFix)
		r.dst[x] = clip255(multFix(j, r.fyScale))
	}
}

// exportRowShrink is WebPRescalerExportRowShrink_C.
func (r *rescaler) exportRowShrink() {
	yscale := r.fyScale * uint32(-r.yAccum)
	if yscale != 0 {
		for x := range r.frow {
			frac := multFixFloor(r.frow[x], yscale)
			r.dst[x] = clip255(multFix(r.irow[x]-frac, r.fxyScale))
			r.irow[x] = frac
		}
		return
	}
	for x := range r.irow {
		r.dst[x] = clip255(multFix(r.irow[x], r.fxyScale))
		r.irow[x] = 0
	}
}
