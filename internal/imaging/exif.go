package imaging

import (
	"bytes"
	"encoding/binary"
	"image"
)

// orientation returns the EXIF Orientation (1 to 8) the way sharp's
// .rotate() finds it: the APP1 Exif segment of a JPEG, the eXIf chunk of a
// PNG, or the EXIF chunk of an extended (VP8X) WebP whose VP8X EXIF flag is
// set (libwebp ignores the chunk otherwise; final review M14). Anything
// missing, malformed or out of range is 1 (no change).
func orientation(f Format, b []byte) int {
	var o int
	switch f {
	case FormatJPEG:
		o = tiffOrientation(jpegExif(b))
	case FormatPNG:
		o = tiffOrientation(stripExifPrefix(pngChunk(b, "eXIf")))
	case FormatWebP:
		if webpVP8XFlags(b)&webpFlagEXIF != 0 {
			o = tiffOrientation(stripExifPrefix(webpChunk(b, "EXIF")))
		}
	}
	if o < 1 || o > 8 {
		return 1
	}
	return o
}

var exifPrefix = []byte("Exif\x00\x00")

func stripExifPrefix(b []byte) []byte {
	return bytes.TrimPrefix(b, exifPrefix)
}

// jpegExif returns the TIFF data of the first APP1 Exif segment before the
// scan, or nil.
func jpegExif(b []byte) []byte {
	if len(b) < 4 || b[0] != 0xFF || b[1] != 0xD8 {
		return nil
	}
	for i := 2; i+4 <= len(b); {
		if b[i] != 0xFF {
			return nil
		}
		marker := b[i+1]
		if marker == 0xFF { // fill byte
			i++
			continue
		}
		if marker == 0xDA || marker == 0xD9 { // SOS, EOI: no metadata after these
			return nil
		}
		n := int(binary.BigEndian.Uint16(b[i+2:]))
		if n < 2 || i+2+n > len(b) {
			return nil
		}
		seg := b[i+4 : i+2+n]
		if marker == 0xE1 && bytes.HasPrefix(seg, exifPrefix) {
			return seg[len(exifPrefix):]
		}
		i += 2 + n
	}
	return nil
}

// pngChunk returns the data of the first chunk of type typ, or nil.
func pngChunk(b []byte, typ string) []byte {
	for i := len(pngSignature); i+8 <= len(b); {
		n := int64(binary.BigEndian.Uint32(b[i:]))
		t := string(b[i+4 : i+8])
		if n > int64(len(b)-i-12) {
			return nil
		}
		if t == typ {
			return b[i+8 : i+8+int(n)]
		}
		if t == "IEND" {
			return nil
		}
		i += 12 + int(n)
	}
	return nil
}

// VP8X flag bits (libwebp's WebPFeatureFlags).
const (
	webpFlagAnimation = 0x02
	webpFlagEXIF      = 0x08
)

// webpVP8XFlags returns the flags byte of an extended WebP's VP8X chunk,
// which is always the first chunk; 0 for a simple (VP8 / VP8L) WebP.
func webpVP8XFlags(b []byte) byte {
	if len(b) < 21 || string(b[12:16]) != "VP8X" || binary.LittleEndian.Uint32(b[16:]) < 10 {
		return 0
	}
	return b[20]
}

// webpChunk returns the data of the first RIFF chunk with FourCC fcc, or
// nil.
func webpChunk(b []byte, fcc string) []byte {
	for i := 12; i+8 <= len(b); {
		n := int64(binary.LittleEndian.Uint32(b[i+4:]))
		if n > int64(len(b)-i-8) {
			return nil
		}
		if string(b[i:i+4]) == fcc {
			return b[i+8 : i+8+int(n)]
		}
		i += 8 + int(n) + int(n&1)
	}
	return nil
}

// tiffOrientation reads tag 0x0112 (Orientation) from IFD0, stored as
// SHORT or, non-standard but read by libexif and so by sharp, as LONG
// (final review M14); anything else, or a value over 8, returns 0.
func tiffOrientation(t []byte) int {
	if len(t) < 8 {
		return 0
	}
	var bo binary.ByteOrder
	switch string(t[:2]) {
	case "II":
		bo = binary.LittleEndian
	case "MM":
		bo = binary.BigEndian
	default:
		return 0
	}
	if bo.Uint16(t[2:]) != 42 {
		return 0
	}
	off := int64(bo.Uint32(t[4:]))
	if off < 8 || off+2 > int64(len(t)) {
		return 0
	}
	entries := int(bo.Uint16(t[off:]))
	for k := range entries {
		e := int(off) + 2 + 12*k
		if e+12 > len(t) {
			return 0
		}
		if bo.Uint16(t[e:]) == 0x0112 {
			var v uint32
			switch bo.Uint16(t[e+2:]) {
			case 3: // SHORT
				v = uint32(bo.Uint16(t[e+8:]))
			case 4: // LONG
				v = bo.Uint32(t[e+8:])
			default:
				return 0
			}
			if v > 8 {
				return 0
			}
			return int(v)
		}
	}
	return 0
}

// orient returns img turned to its display orientation for EXIF value o,
// as sharp's .rotate() does: 2 mirror, 3 rotate 180, 4 flip, 5 transpose,
// 6 rotate 90 clockwise, 7 transverse, 8 rotate 270 clockwise.
func orient(img *image.RGBA, o int) *image.RGBA {
	if o <= 1 || o > 8 {
		return img
	}
	b := img.Bounds()
	w, h := b.Dx(), b.Dy()
	ow, oh := w, h
	if o >= 5 {
		ow, oh = h, w
	}
	dst := image.NewRGBA(image.Rect(0, 0, ow, oh))
	for y := range h {
		row := img.Pix[y*img.Stride : y*img.Stride+4*w]
		for x := range w {
			var dx, dy int
			switch o {
			case 2:
				dx, dy = w-1-x, y
			case 3:
				dx, dy = w-1-x, h-1-y
			case 4:
				dx, dy = x, h-1-y
			case 5:
				dx, dy = y, x
			case 6:
				dx, dy = h-1-y, x
			case 7:
				dx, dy = h-1-y, w-1-x
			case 8:
				dx, dy = y, w-1-x
			}
			d := dy*dst.Stride + 4*dx
			copy(dst.Pix[d:d+4], row[4*x:4*x+4])
		}
	}
	return dst
}
