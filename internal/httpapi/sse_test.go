package httpapi

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/medilens-ai/medilens/internal/application"
	"github.com/medilens-ai/medilens/internal/pipeline"
)

// sseEvent is one parsed SSE frame; a comment frame has only Comment.
type sseEvent struct {
	ID, Name, Data, Comment string
}

// readFrames reads SSE frames until n were read, the stream ends or the
// deadline passes; ended reports a clean end of stream.
func readFrames(t *testing.T, body io.Reader, n int) (frames []sseEvent, ended bool) {
	t.Helper()
	type res struct {
		frames []sseEvent
		ended  bool
	}
	done := make(chan res, 1)
	go func() {
		sc := bufio.NewScanner(body)
		var cur sseEvent
		var out []sseEvent
		for sc.Scan() {
			line := sc.Text()
			switch {
			case line == "":
				out = append(out, cur)
				cur = sseEvent{}
				if len(out) == n {
					done <- res{out, false}
					return
				}
			case strings.HasPrefix(line, ":"):
				cur.Comment = strings.TrimSpace(line[1:])
			case strings.HasPrefix(line, "id: "):
				cur.ID = line[4:]
			case strings.HasPrefix(line, "event: "):
				cur.Name = line[7:]
			case strings.HasPrefix(line, "data: "):
				cur.Data = line[6:]
			default:
				t.Errorf("unexpected SSE line %q", line)
			}
		}
		done <- res{out, sc.Err() == nil}
	}()
	select {
	case r := <-done:
		return r.frames, r.ended
	case <-time.After(15 * time.Second):
		t.Fatal("the stream did not deliver in time")
		return nil, false
	}
}

func openStream(t *testing.T, ctx context.Context, url string, lastEventID string) *http.Response {
	t.Helper()
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		t.Fatal(err)
	}
	if lastEventID != "" {
		req.Header.Set("Last-Event-ID", lastEventID)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != 200 || resp.Header.Get("Content-Type") != "text/event-stream" ||
		resp.Header.Get("Cache-Control") != "no-cache" || resp.Header.Get("X-Accel-Buffering") != "no" {
		t.Fatalf("stream response %d %v", resp.StatusCode, resp.Header)
	}
	return resp
}

func checkEvent(t *testing.T, f sseEvent, want pipeline.Event) {
	t.Helper()
	if f.ID != strconv.Itoa(want.Seq) || f.Name != want.Name() {
		t.Errorf("frame %+v, want seq %d name %s", f, want.Seq, want.Name())
	}
	var got pipeline.Event
	if err := json.Unmarshal([]byte(f.Data), &got); err != nil || got != want {
		t.Errorf("data %s, want %+v (%v)", f.Data, want, err)
	}
	var raw map[string]any
	_ = json.Unmarshal([]byte(f.Data), &raw)
	if len(raw) != 4 {
		t.Errorf("payload keys %v", raw)
	}
}

// A finished analysis's stream replays every stored event and ends.
func TestEventsReplayAndEndAfterTheTerminalEvent(t *testing.T) {
	e := newEnv(t, envOptions{})
	id := e.demoResult(t, "s1-clear")
	st, _ := e.svc.Status(id)
	srv := httptest.NewServer(e.h)
	defer srv.Close()

	resp := openStream(t, context.Background(), srv.URL+"/api/v1/analyses/"+id+"/events", "")
	defer resp.Body.Close()
	frames, ended := readFrames(t, resp.Body, 100)
	if !ended || len(frames) != len(st.Events) {
		t.Fatalf("ended %v, %d frames for %d events", ended, len(frames), len(st.Events))
	}
	for i, f := range frames {
		checkEvent(t, f, st.Events[i])
	}
	if frames[len(frames)-1].Name != "completed" {
		t.Errorf("last frame %+v", frames[len(frames)-1])
	}
}

// Last-Event-ID resumes after that event; a bad value replays everything.
func TestEventsHonourLastEventID(t *testing.T) {
	e := newEnv(t, envOptions{})
	id := e.demoResult(t, "s1-clear")
	st, _ := e.svc.Status(id)
	srv := httptest.NewServer(e.h)
	defer srv.Close()
	for header, from := range map[string]int{"3": 3, " 2 ": 2, "0": 0, "-4": 0, "x": 0, "99": len(st.Events)} {
		resp := openStream(t, context.Background(), srv.URL+"/api/v1/analyses/"+id+"/events", header)
		frames, ended := readFrames(t, resp.Body, 100)
		resp.Body.Close()
		if !ended || len(frames) != len(st.Events)-from {
			t.Errorf("Last-Event-ID %q: ended %v, %d frames", header, ended, len(frames))
			continue
		}
		for i, f := range frames {
			checkEvent(t, f, st.Events[from+i])
		}
	}
}

// Live events follow the replay as the stages start; heartbeats keep the
// stream open in between (injectable interval); the stream ends after the
// terminal event.
func TestEventsAreLiveWithHeartbeats(t *testing.T) {
	gate := newGate(s1Read(t))
	live := liveProviders(gate, scenario(t, "s1-clear").Reference)
	e := newEnv(t, envOptions{providers: &live, heartbeat: 20 * time.Millisecond})
	id := accepted(t, e.upload(sharp(t)))
	gate.waitStarted(t)
	srv := httptest.NewServer(e.h)
	defer srv.Close()

	resp := openStream(t, context.Background(), srv.URL+"/api/v1/analyses/"+id+"/events", "")
	defer resp.Body.Close()
	// received, quality, reading, then a heartbeat while the read waits
	frames, _ := readFrames(t, resp.Body, 4)
	if len(frames) != 4 || frames[2].Name != "stage" || frames[3].Comment != "heartbeat" || frames[3].ID != "" {
		t.Fatalf("frames %+v", frames)
	}
	close(gate.release)
	rest, ended := readFrames(t, resp.Body, 100)
	st, _ := e.svc.Status(id)
	var events []sseEvent
	for _, f := range rest {
		if f.Comment == "" {
			events = append(events, f)
		}
	}
	if !ended || len(events) != len(st.Events)-3 {
		t.Fatalf("ended %v, %d events after the read, %d in all", ended, len(events), len(st.Events))
	}
	for i, f := range events {
		checkEvent(t, f, st.Events[3+i])
	}
	if events[len(events)-1].Name != "completed" {
		t.Errorf("last %+v", events[len(events)-1])
	}
}

// subscribeSpy records whether each subscription was cancelled.
type subscribeSpy struct {
	*application.Service
	cancelled chan struct{}
}

func (s *subscribeSpy) Subscribe(id string, after int) (<-chan pipeline.Event, func(), error) {
	ch, cancel, err := s.Service.Subscribe(id, after)
	once := sync.Once{}
	return ch, func() {
		cancel()
		once.Do(func() { s.cancelled <- struct{}{} })
	}, err
}

// A client that goes away frees its subscriber at once.
func TestAClientDisconnectFreesTheSubscriber(t *testing.T) {
	gate := newGate(s1Read(t))
	live := liveProviders(gate, scenario(t, "s1-clear").Reference)
	spy := &subscribeSpy{cancelled: make(chan struct{}, 4)}
	e := newEnv(t, envOptions{providers: &live, heartbeat: time.Hour})
	spy.Service = e.svc
	api, err := New(Options{Service: spy, Logger: e.api.log, Heartbeat: time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	id := accepted(t, e.upload(sharp(t)))
	gate.waitStarted(t)
	srv := httptest.NewServer(api.Handler())
	defer srv.Close()

	ctx, cancel := context.WithCancel(context.Background())
	resp := openStream(t, ctx, srv.URL+"/api/v1/analyses/"+id+"/events", "")
	readFrames(t, resp.Body, 3)
	cancel()
	resp.Body.Close()
	select {
	case <-spy.cancelled:
	case <-time.After(5 * time.Second):
		t.Fatal("the subscriber was not freed after the client left")
	}
	close(gate.release)
}

// Shutdown closes open streams (RegisterOnShutdown), so Server.Shutdown
// does not wait for them; the stream also ignores Server.WriteTimeout.
func TestShutdownClosesStreams(t *testing.T) {
	gate := newGate(s1Read(t))
	live := liveProviders(gate, scenario(t, "s1-clear").Reference)
	e := newEnv(t, envOptions{providers: &live, heartbeat: 30 * time.Millisecond})
	id := accepted(t, e.upload(sharp(t)))
	gate.waitStarted(t)
	srv := httptest.NewUnstartedServer(e.h)
	srv.Config.WriteTimeout = 100 * time.Millisecond
	srv.Config.RegisterOnShutdown(e.api.CloseStreams)
	srv.Start()
	defer srv.Close()

	resp := openStream(t, context.Background(), srv.URL+"/api/v1/analyses/"+id+"/events", "")
	defer resp.Body.Close()
	// heartbeats keep arriving well past the server's write timeout
	start := time.Now()
	frames, _ := readFrames(t, resp.Body, 3+10)
	if len(frames) != 13 || time.Since(start) < 250*time.Millisecond {
		t.Fatalf("%d frames in %v", len(frames), time.Since(start))
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	begun := time.Now()
	if err := srv.Config.Shutdown(ctx); err != nil {
		t.Fatalf("shutdown: %v", err)
	}
	if d := time.Since(begun); d > 2*time.Second {
		t.Errorf("shutdown took %v", d)
	}
	if _, ended := readFrames(t, resp.Body, 100); !ended {
		t.Error("the stream did not end")
	}
	// a stream opened after shutdown began ends at once (the recorder call
	// returns), with no heartbeat
	w := e.get("/api/v1/analyses/" + id + "/events")
	if w.Code != 200 || strings.Contains(w.Body.String(), "heartbeat") {
		t.Errorf("late stream %d %q", w.Code, w.Body.String())
	}
	close(gate.release)
}

func TestEventsOfAnUnknownAnalysisAreA404(t *testing.T) {
	e := newEnv(t, envOptions{})
	w := e.get("/api/v1/analyses/no-such-id/events")
	wantError(t, w, 404, "NOT_FOUND")
	if w.Header().Get("Content-Type") == "text/event-stream" {
		t.Error("an error was sent as a stream")
	}
}

func TestEventsHEADSendsHeadersOnly(t *testing.T) {
	gate := newGate(s1Read(t))
	live := liveProviders(gate, scenario(t, "s1-clear").Reference)
	e := newEnv(t, envOptions{providers: &live})
	id := accepted(t, e.upload(sharp(t)))
	gate.waitStarted(t)
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() { done <- e.do(newRequest("HEAD", "/api/v1/analyses/"+id+"/events")) }()
	select {
	case w := <-done:
		if w.Code != 200 || w.Header().Get("Content-Type") != "text/event-stream" {
			t.Errorf("%d %v", w.Code, w.Header())
		}
	case <-time.After(5 * time.Second):
		t.Error("HEAD held the stream open")
	}
	close(gate.release)
}
