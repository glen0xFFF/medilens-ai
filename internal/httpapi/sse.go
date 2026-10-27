package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/medilens-ai/medilens/internal/pipeline"
)

// events is GET /analyses/{id}/events, a Server-Sent Events stream (Go
// port spec §4):
//
//   - the stored events are replayed first, then live events follow as
//     their stages start; each frame is "id: <seq>", "event: stage",
//     "completed" or "failed", and "data: {seq, stage, label, at}";
//   - Last-Event-ID resumes after that seq (a value that is not a whole
//     number of 0 or more replays everything);
//   - a ": heartbeat" comment is sent every heartbeat interval (15 s);
//   - the stream ends after the terminal event, when the analysis is
//     deleted or expires, when the client goes away (its subscriber is
//     freed at once) and on shutdown (CloseStreams);
//   - the server's write timeout is cleared for the stream.
//
// An unknown id is a JSON 404, not a stream. HEAD sends the headers only.
func (a *API) events(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	ch, cancel, err := a.svc.Subscribe(id, lastEventID(r.Header.Get("Last-Event-ID")))
	if err != nil {
		a.fail(w, r, err)
		return
	}
	defer cancel()

	rc := http.NewResponseController(w)
	// Server.WriteTimeout would otherwise cut the stream off silently
	_ = rc.SetWriteDeadline(time.Time{})
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache")
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	if r.Method == http.MethodHead {
		return
	}
	if err := rc.Flush(); err != nil {
		return
	}
	heartbeat := time.NewTicker(a.heartbeat)
	defer heartbeat.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-a.streamsDone:
			return
		case <-heartbeat.C:
			if _, err := fmt.Fprint(w, ": heartbeat\n\n"); err != nil || rc.Flush() != nil {
				return
			}
		case e, open := <-ch:
			if !open {
				return
			}
			if writeEvent(w, e) != nil || rc.Flush() != nil {
				return
			}
		}
	}
}

// writeEvent writes one event frame. The JSON payload is one line.
func writeEvent(w http.ResponseWriter, e pipeline.Event) error {
	data, err := json.Marshal(e)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(w, "id: %d\nevent: %s\ndata: %s\n\n", e.Seq, e.Name(), data)
	return err
}

// lastEventID is the seq to resume after: the Last-Event-ID header as a
// whole number, else 0 (replay everything).
func lastEventID(v string) int {
	n, err := strconv.Atoi(strings.TrimSpace(v))
	if err != nil || n < 0 {
		return 0
	}
	return n
}
