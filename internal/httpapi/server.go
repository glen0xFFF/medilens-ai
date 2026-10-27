package httpapi

import (
	"context"
	"errors"
	"net"
	"net/http"
	"time"
)

// DefaultShutdownGrace is how long a shutdown waits for requests in
// flight (Go port spec §4: Shutdown(10s)).
const DefaultShutdownGrace = 10 * time.Second

// NewServer is the API's http.Server. Timeouts: 10 s to read the request
// headers (slow clients), 60 s for the whole request (three 8 MiB photos
// over a phone link), 120 s to answer (an explanation can wait on two
// 45 s model calls; event streams clear it), 120 s idle, 32 KiB of
// headers. Shutdown closes the event streams (RegisterOnShutdown), which
// it would otherwise wait for.
func NewServer(a *API) *http.Server {
	srv := &http.Server{
		Handler:           a.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       60 * time.Second,
		WriteTimeout:      120 * time.Second,
		IdleTimeout:       120 * time.Second,
		MaxHeaderBytes:    32 << 10,
	}
	srv.RegisterOnShutdown(a.CloseStreams)
	return srv
}

// Serve serves srv on ln until ctx ends (SIGINT or SIGTERM in main), then
// shuts down (Go port spec §4): GET /readyz turns 503, srv.Shutdown closes
// the listener and the event streams and waits up to grace for the
// requests in flight (then closes their connections), and closeService
// cancels the analyses still running and waits for its workers. A serve
// failure is returned after the same steps.
func Serve(ctx context.Context, srv *http.Server, ln net.Listener, a *API, closeService func(context.Context) error, grace time.Duration) error {
	served := make(chan error, 1)
	go func() { served <- srv.Serve(ln) }()
	var serveErr error
	select {
	case serveErr = <-served:
	case <-ctx.Done():
	}
	a.SetNotReady()

	sctx, cancel := context.WithTimeout(context.Background(), grace)
	defer cancel()
	shutdownErr := srv.Shutdown(sctx)
	if shutdownErr != nil {
		// requests still running after the grace period lose their
		// connections; their contexts end with them
		_ = srv.Close()
	}
	if serveErr == nil {
		if err := <-served; !errors.Is(err, http.ErrServerClosed) {
			serveErr = err
		}
	}
	cctx, ccancel := context.WithTimeout(context.Background(), grace)
	defer ccancel()
	closeErr := closeService(cctx)
	return errors.Join(serveErr, shutdownErr, closeErr)
}
