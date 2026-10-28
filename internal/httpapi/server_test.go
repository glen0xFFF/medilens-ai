package httpapi

import (
	"context"
	"net"
	"testing"
	"time"

	"github.com/medilens-ai/medilens/internal/application"
	"github.com/medilens-ai/medilens/internal/pipeline"
)

func TestNewServerTimeouts(t *testing.T) {
	e := newEnv(t, envOptions{})
	srv := NewServer(e.api)
	if srv.ReadHeaderTimeout != 10*time.Second || srv.ReadTimeout != 60*time.Second || srv.WriteTimeout != 120*time.Second ||
		srv.IdleTimeout != 120*time.Second || srv.MaxHeaderBytes != 32<<10 || srv.Handler == nil {
		t.Errorf("server %+v", srv)
	}
}

// Go port spec §4 (Shutdown): readyz turns 503, open SSE streams close,
// Shutdown drains, then the service cancels the analyses in flight.
func TestServeShutsDownGracefully(t *testing.T) {
	gate := newGate(s1Read(t))
	live := liveProviders(gate, scenario(t, "s1-clear").Reference)
	e := newEnv(t, envOptions{providers: &live, heartbeat: time.Hour})
	id := accepted(t, e.upload(sharp(t)))
	gate.waitStarted(t)

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, stop := context.WithCancel(context.Background())
	served := make(chan error, 1)
	go func() { served <- Serve(ctx, NewServer(e.api), ln, e.api, e.svc.Close, 5*time.Second) }()

	resp := openStream(t, context.Background(), "http://"+ln.Addr().String()+"/api/v1/analyses/"+id+"/events", "")
	defer resp.Body.Close()
	readFrames(t, resp.Body, 3)
	if w := e.get("/readyz"); w.Code != 200 {
		t.Fatalf("readyz %d before shutdown", w.Code)
	}
	stop()
	select {
	case err := <-served:
		if err != nil {
			t.Fatalf("serve: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("shutdown did not finish")
	}
	if _, ended := readFrames(t, resp.Body, 100); !ended {
		t.Error("the stream did not end")
	}
	if w := e.get("/readyz"); w.Code != 503 {
		t.Errorf("readyz %d after shutdown", w.Code)
	}
	st, err := e.svc.Status(id)
	if err != nil || st.Status != application.StateFailed || st.Error == nil || st.Error.Code != pipeline.CodeAnalysisFailed {
		t.Errorf("the job in flight: %+v %v", st, err)
	}
}

func TestServeReportsAServeFailure(t *testing.T) {
	e := newEnv(t, envOptions{})
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ln.Close()
	closed := false
	err = Serve(context.Background(), NewServer(e.api), ln, e.api, func(context.Context) error { closed = true; return nil }, time.Second)
	if err == nil || !closed {
		t.Errorf("err %v, service closed %v", err, closed)
	}
}
