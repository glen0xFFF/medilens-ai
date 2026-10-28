package imaging

import (
	"bytes"
	"image"
	"image/color"
	"image/jpeg"
	"testing"
)

// The JPEG decode against sharp's own raw decode, pixel by pixel, on the
// patches-* images: saturated and dark colour runs at odd and tiny sizes,
// so every chroma edge case of libjpeg's fancy upsampling is hit (first and
// last column and row, replication at 2 columns or fewer, 4:4:4). The two
// IDCTs round differently, so a channel may be one or two levels off; a
// wrong upsampling filter or edge rule is off by tens.
func TestJPEGDecodeMatchesSharp(t *testing.T) {
	ref := loadReference(t)
	n := 0
	for _, im := range ref.Images {
		if im.RGB == nil {
			continue
		}
		n++
		raw, err := jpeg.Decode(bytes.NewReader(fixture(t, im.File)))
		if err != nil {
			t.Fatalf("%s: %v", im.File, err)
		}
		px := toRGBA(pixels(raw, FormatJPEG))
		w, h := px.Rect.Dx(), px.Rect.Dy()
		if len(im.RGB) != w*h*3 {
			t.Fatalf("%s: %dx%d, sharp decoded %d values", im.File, w, h, len(im.RGB))
		}
		exact, worst, nearest := 0, 0, 0
		for i := range w * h {
			x, y := i%w, i/w
			o := px.PixOffset(x, y)
			nc := color.NRGBAModel.Convert(raw.At(x, y)).(color.NRGBA)
			for ch, v := range [3]uint8{nc.R, nc.G, nc.B} {
				want := im.RGB[3*i+ch]
				d := int(px.Pix[o+ch]) - want
				if d == 0 {
					exact++
				}
				worst = max(worst, d, -d)
				nearest = max(nearest, int(v)-want, want-int(v))
			}
		}
		t.Logf("%-24s %T %v: exact %d/%d, worst %d (image/color nearest-neighbour: worst %d)",
			im.File, raw, subsampling(raw), exact, w*h*3, worst, nearest)
		if worst > 2 {
			t.Errorf("%s: a channel %d levels from sharp's decode, want at most 2", im.File, worst)
		}
	}
	if n < 8 {
		t.Errorf("%d images with a recorded decode, want at least 8", n)
	}
}

func subsampling(m image.Image) any {
	if yc, ok := m.(*image.YCbCr); ok {
		return yc.SubsampleRatio
	}
	return "-"
}

// Every size from 1x1 to 24x24 at each subsampling Go decodes: the
// upsampler stays in bounds and fills the whole image.
func TestJPEGToRGBAEverySize(t *testing.T) {
	ratios := []image.YCbCrSubsampleRatio{
		image.YCbCrSubsampleRatio444, image.YCbCrSubsampleRatio422, image.YCbCrSubsampleRatio420,
		image.YCbCrSubsampleRatio440, image.YCbCrSubsampleRatio411, image.YCbCrSubsampleRatio410,
	}
	for _, r := range ratios {
		for w := 1; w <= 24; w++ {
			for h := 1; h <= 24; h++ {
				yc := image.NewYCbCr(image.Rect(0, 0, w, h), r)
				for i := range yc.Y {
					yc.Y[i] = 128
				}
				for i := range yc.Cb {
					yc.Cb[i], yc.Cr[i] = 128, 128
				}
				out := jpegToRGBA(yc)
				if out.Rect.Dx() != w || out.Rect.Dy() != h {
					t.Fatalf("%v %dx%d: got %v", r, w, h, out.Rect)
				}
				for i := 0; i < len(out.Pix); i += 4 {
					if out.Pix[i] != 128 || out.Pix[i+1] != 128 || out.Pix[i+2] != 128 || out.Pix[i+3] != 255 {
						t.Fatalf("%v %dx%d: pixel %d is %v, want neutral grey 128", r, w, h, i/4, out.Pix[i:i+4])
					}
				}
			}
		}
	}
}
