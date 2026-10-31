package middleware

import "net/http"

// CORS answers CORS for exactly one origin (CORS_ORIGIN, config.Config
// CORSOrigin, already reduced to scheme://host[:port]), as Node's corsFor.
// The Android app does not need CORS; this is for a browser client such as
// Expo web. With no origin configured it adds nothing. Otherwise every
// response varies on Origin; a request from that exact origin gets
// Access-Control-Allow-Origin and the exposed headers, and its preflight
// (OPTIONS) is answered 204 here, before the rate limit and the mux (whose
// method patterns would answer it 405). Other origins get no CORS headers.
//
// Go additions to Node's lists: DELETE (DELETE /analyses/{id}), the
// Last-Event-ID request header (an EventSource reconnecting) and the
// Retry-After response header (429 and 503).
func CORS(origin string, next http.Handler) http.Handler {
	if origin == "" {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Add("Vary", "Origin")
		if r.Header.Get("Origin") != origin {
			next.ServeHTTP(w, r)
			return
		}
		h.Set("Access-Control-Allow-Origin", origin)
		h.Set("Access-Control-Expose-Headers", "X-Request-Id, Retry-After")
		if r.Method == http.MethodOptions {
			h.Set("Access-Control-Allow-Methods", "GET, POST, DELETE")
			h.Set("Access-Control-Allow-Headers", "Content-Type, Last-Event-ID")
			h.Set("Access-Control-Max-Age", "600")
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}
