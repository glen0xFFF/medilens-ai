package httpapi

import (
	"bytes"
	"errors"
	"io"
	"mime"
	"net/http"

	"github.com/medilens-ai/medilens/internal/contracts"
	"github.com/medilens-ai/medilens/internal/imaging"
	"github.com/medilens-ai/medilens/internal/pipeline"
)

// Uploads (POST /api/v1/analyses, Go port spec §4): multipart/form-data
// with 1 to 3 files in the "images" field, read in memory as a stream from
// r.MultipartReader() only. ParseMultipartForm, FormFile and FormValue are
// never called (they write file parts to temporary files; a guard test
// checks this package's sources), and calling MultipartReader first makes
// any later call of them fail instead of parsing the body again.
//
// Limits mirror Node's multer setup (fileSize 8 MB, files 3, fields 10,
// fieldSize 1024, fieldNameSize 100): every refusal is 400
// VALIDATION_FAILED "Send 1 to 3 photos...", except a file over 8 MiB or a
// body over the cap, which is 413 IMAGE_TOO_LARGE. A text field (a part
// with no file name) is read and dropped, as multer kept it in req.body,
// which the route never read.

const (
	// maxUploadBody caps the whole body: three images and room for the
	// boundaries, part headers and the allowed text fields.
	maxUploadBody = pipeline.MaxImages*imaging.MaxImageBytes + 64<<10
	// maxFields, maxFieldBytes and maxFieldNameBytes are multer's fields,
	// fieldSize and fieldNameSize.
	maxFields         = 10
	maxFieldBytes     = 1024
	maxFieldNameBytes = 100
)

// sendPhotos is the 400 answer for every malformed upload.
func sendPhotos() *pipeline.Error {
	var pe *pipeline.Error
	if errors.As(pipeline.ValidateUploads(nil), &pe) {
		return pe
	}
	return &pipeline.Error{Code: contracts.ErrValidationFailed, Message: `Send 1 to 3 photos in the "images" field.`}
}

func tooLarge() *pipeline.Error { return pipeline.NewError(contracts.ErrImageTooLarge) }

// readError maps an error reading the body: over the body cap is 413, any
// other (a cut-off or malformed body) is 400.
func readError(err error) *pipeline.Error {
	var mbe *http.MaxBytesError
	if errors.As(err, &mbe) {
		return tooLarge()
	}
	return sendPhotos()
}

// readImages reads the upload's images into memory.
func readImages(w http.ResponseWriter, r *http.Request) ([][]byte, *pipeline.Error) {
	mt, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if (err != nil && err != mime.ErrInvalidMediaParameter) || mt != "multipart/form-data" {
		return nil, sendPhotos()
	}
	if r.ContentLength > maxUploadBody {
		return nil, tooLarge()
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxUploadBody)
	mr, err := r.MultipartReader()
	if err != nil {
		return nil, sendPhotos()
	}
	var images [][]byte
	fields := 0
	for {
		p, err := mr.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, readError(err)
		}
		name := p.FormName()
		if len(name) > maxFieldNameBytes {
			return nil, sendPhotos()
		}
		if p.FileName() == "" {
			fields++
			if fields > maxFields {
				return nil, sendPhotos()
			}
			n, err := io.Copy(io.Discard, io.LimitReader(p, maxFieldBytes+1))
			if err != nil {
				return nil, readError(err)
			}
			if n > maxFieldBytes {
				return nil, sendPhotos()
			}
			continue
		}
		if name != "images" || len(images) == pipeline.MaxImages {
			return nil, sendPhotos()
		}
		var buf bytes.Buffer
		n, err := io.Copy(&buf, io.LimitReader(p, imaging.MaxImageBytes+1))
		if err != nil {
			return nil, readError(err)
		}
		if n > imaging.MaxImageBytes {
			return nil, tooLarge()
		}
		// a copy of exactly the photo's size: the growing buffer can hold up
		// to twice that, and the photo is kept while its job waits (final
		// review M8)
		images = append(images, bytes.Clone(buf.Bytes()))
	}
	if len(images) == 0 {
		return nil, sendPhotos()
	}
	return images, nil
}
