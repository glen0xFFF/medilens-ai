package imaging

import "image"

// JPEG YCbCr to RGB as libjpeg-turbo does it for libvips (and so sharp):
// "fancy" chroma upsampling (jdsample.c, do_fancy_upsampling is on by
// default) and the jdcolor.c fixed-point conversion.
//
// image/jpeg leaves subsampled chroma at its own resolution, and
// image/color reads it nearest-neighbour. On coloured content with sharp
// edges that differs from libjpeg's triangle filter by several levels per
// pixel; where a dark colour clips a channel at 0 the error no longer
// averages out, and a 4:2:0 re-encode of a dark CMYK parity image measured
// 0.56 grey levels darker than sharp (task G5 review round 1). With this
// conversion 98.9% of its channels decode equal to sharp's, the rest
// within the IDCT's rounding.

const jScaleBits = 16

func jFix(x float64) int { return int(x*(1<<jScaleBits) + 0.5) }

// jdcolor.c build_ycc_rgb_table.
var jCrR, jCbB, jCrG, jCbG [256]int

func init() {
	const oneHalf = 1 << (jScaleBits - 1)
	for i := range 256 {
		x := i - 128
		jCrR[i] = (jFix(1.40200)*x + oneHalf) >> jScaleBits
		jCbB[i] = (jFix(1.77200)*x + oneHalf) >> jScaleBits
		jCrG[i] = -jFix(0.71414) * x
		jCbG[i] = -jFix(0.34414)*x + oneHalf
	}
}

func clamp8(v int) uint8 { return uint8(min(max(v, 0), 255)) }

// jpegToRGBA converts a decoded JPEG's YCbCr to opaque RGB the libjpeg
// way, at the origin.
func jpegToRGBA(yc *image.YCbCr) *image.RGBA {
	w, h := yc.Rect.Dx(), yc.Rect.Dy()
	cbAt, crAt := chromaUpsampler(yc, w, h)
	y0 := yc.YOffset(yc.Rect.Min.X, yc.Rect.Min.Y)
	out := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := range h {
		yrow := yc.Y[y0+y*yc.YStride:]
		cb, cr := cbAt(y), crAt(y)
		o := out.Pix[y*out.Stride:]
		for x := range w {
			Y := int(yrow[x])
			b, r := int(cb[x]), int(cr[x])
			o[4*x] = clamp8(Y + jCrR[r])
			o[4*x+1] = clamp8(Y + (jCbG[b]+jCrG[r])>>jScaleBits)
			o[4*x+2] = clamp8(Y + jCbB[b])
			o[4*x+3] = 0xff
		}
	}
	return out
}

// chromaUpsampler returns, for Cb and Cr, the full-width chroma row of
// output row y, upsampled as jinit_upsampler chooses: fancy h2v1 and h2v2
// when the chroma is wider than 2 samples, fancy h1v2, and plain
// replication for everything else (4:1:1, 4:1:0).
func chromaUpsampler(yc *image.YCbCr, w, h int) (func(int) []byte, func(int) []byte) {
	var hs, vs int
	switch yc.SubsampleRatio {
	case image.YCbCrSubsampleRatio444:
		hs, vs = 1, 1
	case image.YCbCrSubsampleRatio422:
		hs, vs = 2, 1
	case image.YCbCrSubsampleRatio420:
		hs, vs = 2, 2
	case image.YCbCrSubsampleRatio440:
		hs, vs = 1, 2
	case image.YCbCrSubsampleRatio411:
		hs, vs = 4, 1
	case image.YCbCrSubsampleRatio410:
		hs, vs = 4, 2
	}
	// downsampled_width / height: ceil(w / hs), ceil(h / vs).
	dw, dh := (w+hs-1)/hs, (h+vs-1)/vs
	c0 := yc.COffset(yc.Rect.Min.X, yc.Rect.Min.Y)
	up := func(plane []byte) func(int) []byte {
		row := func(r int) []byte {
			r = min(max(r, 0), dh-1) // libjpeg's context rows repeat the edge rows
			return plane[c0+r*yc.CStride : c0+r*yc.CStride+dw]
		}
		buf := make([]byte, dw*hs)
		fancyH := hs == 2 && dw > 2
		return func(y int) []byte {
			switch {
			case vs == 2 && (hs == 1 || fancyH):
				// h1v2 / h2v2 fancy: 3/4 of the nearer row, 1/4 of the further.
				r := y / 2
				in0, in1 := row(r), row(r-1)
				if y%2 == 1 {
					in1 = row(r + 1)
				}
				if hs == 1 {
					bias := 1
					if y%2 == 1 {
						bias = 2
					}
					for x := range dw {
						buf[x] = uint8((int(in0[x])*3 + int(in1[x]) + bias) >> 2)
					}
					return buf
				}
				sum := func(x int) int { return int(in0[x])*3 + int(in1[x]) }
				this, next := sum(0), sum(1)
				buf[0] = uint8((this*4 + 8) >> 4)
				buf[1] = uint8((this*3 + next + 7) >> 4)
				last := this
				this = next
				for x := 1; x < dw-1; x++ {
					next = sum(x + 1)
					buf[2*x] = uint8((this*3 + last + 8) >> 4)
					buf[2*x+1] = uint8((this*3 + next + 7) >> 4)
					last, this = this, next
				}
				buf[2*dw-2] = uint8((this*3 + last + 8) >> 4)
				buf[2*dw-1] = uint8((this*4 + 7) >> 4)
				return buf
			case vs == 1 && fancyH:
				// h2v1 fancy.
				in := row(y)
				buf[0] = in[0]
				buf[1] = uint8((int(in[0])*3 + int(in[1]) + 2) >> 2)
				for x := 1; x < dw-1; x++ {
					v := int(in[x]) * 3
					buf[2*x] = uint8((v + int(in[x-1]) + 1) >> 2)
					buf[2*x+1] = uint8((v + int(in[x+1]) + 2) >> 2)
				}
				buf[2*dw-2] = uint8((int(in[dw-1])*3 + int(in[dw-2]) + 1) >> 2)
				buf[2*dw-1] = in[dw-1]
				return buf
			default:
				// Replication (int_upsample, h2v1/h2v2_upsample, 4:4:4).
				in := row(y / vs)
				for x := range dw * hs {
					buf[x] = in[x/hs]
				}
				return buf
			}
		}
	}
	return up(yc.Cb), up(yc.Cr)
}
