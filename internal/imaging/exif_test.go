package imaging

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"hash/crc32"
	"image"
	"image/color"
	"testing"
)

func TestOrientationFromSharpFixtures(t *testing.T) {
	for _, c := range []struct {
		file string
		f    Format
		want int
	}{
		{"sharp.jpg", FormatJPEG, 1},
		{"sharp.png", FormatPNG, 1},
		{"sharp.webp", FormatWebP, 1},
		{"orient6.jpg", FormatJPEG, 6},  // APP1 Exif
		{"orient6.png", FormatPNG, 6},   // eXIf chunk
		{"orient6.webp", FormatWebP, 6}, // VP8X EXIF chunk
	} {
		if got := orientation(c.f, fixture(t, c.file)); got != c.want {
			t.Errorf("%s: orientation %d, want %d", c.file, got, c.want)
		}
	}
	for o := 1; o <= 8; o++ {
		file := fmt.Sprintf("cells-o%d.jpg", o)
		if got := orientation(FormatJPEG, fixture(t, file)); got != o {
			t.Errorf("%s: orientation %d, want %d", file, got, o)
		}
	}
}

// tiff builds a minimal TIFF header + IFD0 holding one Orientation entry.
func tiff(order binary.ByteOrder, typ uint16, value uint32) []byte {
	b := make([]byte, 8+2+12+4)
	if order == binary.BigEndian {
		copy(b, "MM")
	} else {
		copy(b, "II")
	}
	order.PutUint16(b[2:], 42)
	order.PutUint32(b[4:], 8)
	order.PutUint16(b[8:], 1)
	order.PutUint16(b[10:], 0x0112)
	order.PutUint16(b[12:], typ)
	order.PutUint32(b[14:], 1)
	if typ == 3 {
		order.PutUint16(b[18:], uint16(value))
	} else {
		order.PutUint32(b[18:], value)
	}
	return b
}

func jpegWithAPP1(payload []byte) []byte {
	b := []byte{0xFF, 0xD8, 0xFF, 0xE1, 0, 0}
	binary.BigEndian.PutUint16(b[4:], uint16(2+len(payload)))
	b = append(b, payload...)
	return append(b, 0xFF, 0xDA, 0, 2, 0xFF, 0xD9)
}

func writePNGChunk(b *bytes.Buffer, typ string, data []byte) {
	var n [4]byte
	binary.BigEndian.PutUint32(n[:], uint32(len(data)))
	b.Write(n[:])
	b.WriteString(typ)
	b.Write(data)
	crc := crc32.NewIEEE()
	crc.Write([]byte(typ))
	crc.Write(data)
	binary.BigEndian.PutUint32(n[:], crc.Sum32())
	b.Write(n[:])
}

func pngWithEXIf(payload []byte) []byte {
	var b bytes.Buffer
	b.Write([]byte{0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A})
	writePNGChunk(&b, "IHDR", make([]byte, 13))
	writePNGChunk(&b, "eXIf", payload)
	writePNGChunk(&b, "IEND", nil)
	return b.Bytes()
}

// webpEXIFFlag is the VP8X flag bit that says an EXIF chunk is present.
const webpEXIFFlag = 0x08

func webpWithEXIF(payload []byte) []byte { return webpWithVP8XFlags(webpEXIFFlag, payload) }

// webpWithVP8XFlags builds RIFF/WEBP with a VP8X chunk carrying flags, then
// an EXIF chunk holding payload.
func webpWithVP8XFlags(flags byte, payload []byte) []byte {
	chunk := func(fcc string, data []byte) []byte {
		c := append([]byte(fcc), 0, 0, 0, 0)
		binary.LittleEndian.PutUint32(c[4:], uint32(len(data)))
		c = append(c, data...)
		if len(data)%2 == 1 {
			c = append(c, 0)
		}
		return c
	}
	vp8x := make([]byte, 10)
	vp8x[0] = flags
	body := append([]byte("WEBP"), chunk("VP8X", vp8x)...)
	body = append(body, chunk("EXIF", payload)...)
	out := append([]byte("RIFF"), 0, 0, 0, 0)
	binary.LittleEndian.PutUint32(out[4:], uint32(len(body)))
	return append(out, body...)
}

func TestOrientationParsesHandBuiltContainers(t *testing.T) {
	exif := func(t []byte) []byte { return append([]byte("Exif\x00\x00"), t...) }
	for _, c := range []struct {
		name string
		f    Format
		b    []byte
		want int
	}{
		{"JPEG little-endian", FormatJPEG, jpegWithAPP1(exif(tiff(binary.LittleEndian, 3, 6))), 6},
		{"JPEG big-endian", FormatJPEG, jpegWithAPP1(exif(tiff(binary.BigEndian, 3, 8))), 8},
		{"JPEG value 9 is out of range", FormatJPEG, jpegWithAPP1(exif(tiff(binary.LittleEndian, 3, 9))), 1},
		{"JPEG value 0 is out of range", FormatJPEG, jpegWithAPP1(exif(tiff(binary.LittleEndian, 3, 0))), 1},
		{"JPEG APP1 without the Exif prefix", FormatJPEG, jpegWithAPP1(tiff(binary.LittleEndian, 3, 6)), 1},
		{"JPEG truncated IFD", FormatJPEG, jpegWithAPP1(exif(tiff(binary.LittleEndian, 3, 6)[:14])), 1},
		{"PNG raw TIFF", FormatPNG, pngWithEXIf(tiff(binary.BigEndian, 3, 3)), 3},
		{"PNG with Exif prefix", FormatPNG, pngWithEXIf(exif(tiff(binary.LittleEndian, 3, 5))), 5},
		{"PNG truncated", FormatPNG, pngWithEXIf(tiff(binary.LittleEndian, 3, 6))[:40], 1},
		{"WebP with Exif prefix", FormatWebP, webpWithEXIF(exif(tiff(binary.LittleEndian, 3, 7))), 7},
		{"WebP raw TIFF", FormatWebP, webpWithEXIF(tiff(binary.BigEndian, 3, 2)), 2},
		{"WebP truncated", FormatWebP, webpWithEXIF(tiff(binary.BigEndian, 3, 2))[:30], 1},
		// final review M14, from the G5 reviewer's sharp probes: libwebp
		// reads the EXIF chunk only when the VP8X EXIF flag says it is
		// there, and libexif reads an Orientation stored as LONG
		{"WebP EXIF chunk without the VP8X EXIF flag", FormatWebP, webpWithVP8XFlags(0, tiff(binary.LittleEndian, 3, 6)), 1},
		{"WebP EXIF chunk with only other VP8X flags", FormatWebP, webpWithVP8XFlags(0x20|0x10, tiff(binary.LittleEndian, 3, 6)), 1},
		{"JPEG Orientation as LONG, little-endian", FormatJPEG, jpegWithAPP1(exif(tiff(binary.LittleEndian, 4, 6))), 6},
		{"JPEG Orientation as LONG, big-endian", FormatJPEG, jpegWithAPP1(exif(tiff(binary.BigEndian, 4, 8))), 8},
		{"JPEG Orientation as LONG out of range", FormatJPEG, jpegWithAPP1(exif(tiff(binary.BigEndian, 4, 1<<16|6))), 1},
		{"JPEG Orientation as BYTE is ignored", FormatJPEG, jpegWithAPP1(exif(tiff(binary.LittleEndian, 1, 6))), 1},
	} {
		if got := orientation(c.f, c.b); got != c.want {
			t.Errorf("%s: orientation %d, want %d", c.name, got, c.want)
		}
	}
}

// orient maps a 3x2 image
//
//	a b c
//	d e f
//
// to its display orientation for each EXIF value.
func TestOrientPixelMapping(t *testing.T) {
	src := image.NewRGBA(image.Rect(0, 0, 3, 2))
	for i, r := range "abcdef" {
		src.Set(i%3, i/3, color.RGBA{uint8(r), 0, 0, 255})
	}
	want := map[int][]string{
		1: {"abc", "def"},
		2: {"cba", "fed"},
		3: {"fed", "cba"},
		4: {"def", "abc"},
		5: {"ad", "be", "cf"},
		6: {"da", "eb", "fc"},
		7: {"fc", "eb", "da"},
		8: {"cf", "be", "ad"},
	}
	for o := 1; o <= 8; o++ {
		got := orient(src, o)
		var rows []string
		for y := 0; y < got.Bounds().Dy(); y++ {
			row := ""
			for x := 0; x < got.Bounds().Dx(); x++ {
				row += string(rune(got.RGBAAt(x, y).R))
			}
			rows = append(rows, row)
		}
		if fmt.Sprint(rows) != fmt.Sprint(want[o]) {
			t.Errorf("orientation %d: %v, want %v", o, rows, want[o])
		}
	}
}

func FuzzOrientation(f *testing.F) {
	f.Add(byte(0), fixture(f, "orient6.jpg")[:256])
	f.Add(byte(1), pngWithEXIf(tiff(binary.BigEndian, 3, 3)))
	f.Add(byte(2), webpWithEXIF(tiff(binary.LittleEndian, 3, 7)))
	formats := []Format{FormatJPEG, FormatPNG, FormatWebP}
	f.Fuzz(func(t *testing.T, which byte, b []byte) {
		if o := orientation(formats[int(which)%3], b); o < 1 || o > 8 {
			t.Fatalf("orientation %d outside 1..8", o)
		}
	})
}
