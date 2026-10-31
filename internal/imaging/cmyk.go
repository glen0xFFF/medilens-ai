package imaging

import (
	_ "embed"
	"encoding/binary"
	"image"
)

// CMYK JPEGs are converted to sRGB the way sharp converts them, not with
// image/color's naive formula, which measured 3 to 16 grey levels off and
// flipped BLURRY to ok near the threshold (task G5 review round 1).
// image/jpeg also returns YCCK JPEGs as CMYK, so they take this path too;
// no YCCK parity image exists (sharp cannot write one).
//
// sharp 0.35.5 (pipeline.cc) runs a CMYK image without an embedded profile
// through icc_transform("srgb", input_profile "cmyk", perceptual): lcms2
// with libvips' built-in CMYK profile. For an 8-bit CMYK to 8-bit RGB
// transform lcms precomputes a 17-node 4-D table of 16-bit values
// (cmsReasonableGridpointsByColorspace) and evaluates it with Eval4Inputs
// (cmsintrp.c): tetrahedral in M, Y, K on the two C slices either side,
// then linear in C, in 16.16 fixed point. That reading of the lcms source
// is borne out by the fit below: with 17 nodes the residual is at the
// 8-bit rounding floor, with 23 it is not.
//
// cmyk_srgb.lut holds that table's 16-bit node values (little-endian),
// recovered by scripts/parity/record-cmyk-lut.ts from sharp's own output
// on 5.6 million CMYK pixels (the cube's corners, edges and 2-D faces in
// full, seeded random pixels on its 3-D faces and inside) by least squares
// over lcms' interpolation weights. Evaluated as lcms evaluates it, it
// gives sharp's 8-bit output to within one level, unbiased
// (TestCMYKToSRGBMatchesSharp).

const cmykNodes = 17

//go:embed cmyk_srgb.lut
var cmykLUT []byte

// node is one 16-bit table value; i counts uint16 entries.
func node(i int) int { return int(binary.LittleEndian.Uint16(cmykLUT[2*i:])) }

// lcms2 opta: the table stride of each input, in entries (K fastest).
const (
	optaK = 3
	optaY = optaK * cmykNodes
	optaM = optaY * cmykNodes
	optaC = optaM * cmykNodes
)

// toFixedDomain is lcms _cmsToFixedDomain: a 0..0xffff fraction scaled to
// 16.16 fixed point.
func toFixedDomain(a int) int { return a + (a+0x7fff)/0xffff }

// cmykToSRGB is sharp's CMYK to sRGB conversion of one 8-bit pixel (0 is
// no ink).
func cmykToSRGB(c, m, y, k uint8) (r, g, b uint8) {
	// FROM_8_TO_16, then each input's position in the grid.
	in := [4]int{int(c) * 257, int(m) * 257, int(y) * 257, int(k) * 257}
	var base, next, rest [4]int
	opta := [4]int{optaC, optaM, optaY, optaK}
	for i, v := range in {
		f := toFixedDomain(v * (cmykNodes - 1))
		base[i] = (f >> 16) * opta[i]
		rest[i] = f & 0xffff
		next[i] = base[i]
		if v != 0xffff {
			next[i] += opta[i]
		}
	}
	X0, X1, rx := base[1], next[1], rest[1]
	Y0, Y1, ry := base[2], next[2], rest[2]
	Z0, Z1, rz := base[3], next[3], rest[3]

	var out [3]uint8
	for ch := range 3 {
		var slice [2]int
		for s, k0 := range [2]int{base[0], next[0]} {
			dens := func(x, y, z int) int { return node(k0 + x + y + z + ch) }
			c0 := dens(X0, Y0, Z0)
			var c1, c2, c3 int
			switch {
			case rx >= ry && ry >= rz:
				c1 = dens(X1, Y0, Z0) - c0
				c2 = dens(X1, Y1, Z0) - dens(X1, Y0, Z0)
				c3 = dens(X1, Y1, Z1) - dens(X1, Y1, Z0)
			case rx >= rz && rz >= ry:
				c1 = dens(X1, Y0, Z0) - c0
				c2 = dens(X1, Y1, Z1) - dens(X1, Y0, Z1)
				c3 = dens(X1, Y0, Z1) - dens(X1, Y0, Z0)
			case rz >= rx && rx >= ry:
				c1 = dens(X1, Y0, Z1) - dens(X0, Y0, Z1)
				c2 = dens(X1, Y1, Z1) - dens(X1, Y0, Z1)
				c3 = dens(X0, Y0, Z1) - c0
			case ry >= rx && rx >= rz:
				c1 = dens(X1, Y1, Z0) - dens(X0, Y1, Z0)
				c2 = dens(X0, Y1, Z0) - c0
				c3 = dens(X1, Y1, Z1) - dens(X1, Y1, Z0)
			case ry >= rz && rz >= rx:
				c1 = dens(X1, Y1, Z1) - dens(X0, Y1, Z1)
				c2 = dens(X0, Y1, Z0) - c0
				c3 = dens(X0, Y1, Z1) - dens(X0, Y1, Z0)
			case rz >= ry && ry >= rx:
				c1 = dens(X1, Y1, Z1) - dens(X0, Y1, Z1)
				c2 = dens(X0, Y1, Z1) - dens(X0, Y0, Z1)
				c3 = dens(X0, Y0, Z1) - c0
			}
			rest := c1*rx + c2*ry + c3*rz
			// ROUND_FIXED_TO_INT(_cmsToFixedDomain(Rest)), stored as uint16.
			slice[s] = (c0 + (toFixedDomain(rest)+0x8000)>>16) & 0xffff
		}
		// LinearInterp in C.
		v := ((slice[1]-slice[0])*rest[0]+0x8000)>>16 + slice[0]
		// FROM_16_TO_8.
		out[ch] = uint8(((v&0xffff)*65281 + 8388608) >> 24)
	}
	return out[0], out[1], out[2]
}

// cmykToRGBA converts ink values held four to a pixel in an RGBA buffer
// (C, M, Y, K in place of R, G, B, A: see cmykPlanes) to opaque sRGB.
func cmykToRGBA(p *image.RGBA) *image.RGBA {
	w, h := p.Rect.Dx(), p.Rect.Dy()
	out := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := range h {
		src := p.Pix[y*p.Stride : y*p.Stride+4*w]
		dst := out.Pix[y*out.Stride : y*out.Stride+4*w]
		for x := 0; x < 4*w; x += 4 {
			dst[x], dst[x+1], dst[x+2] = cmykToSRGB(src[x], src[x+1], src[x+2], src[x+3])
			dst[x+3] = 0xff
		}
	}
	return out
}

// cmykPlanes copies a decoded CMYK image's ink values, unconverted, into
// an RGBA buffer at the origin, so the JPEG shrink-on-load box average
// works on ink as libjpeg's scaled IDCT does before libvips converts.
func cmykPlanes(c *image.CMYK) *image.RGBA {
	w, h := c.Rect.Dx(), c.Rect.Dy()
	out := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := range h {
		copy(out.Pix[y*out.Stride:y*out.Stride+4*w], c.Pix[c.PixOffset(c.Rect.Min.X, c.Rect.Min.Y+y):])
	}
	return out
}
