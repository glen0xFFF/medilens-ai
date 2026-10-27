package middleware

import (
	"math"
	"net"
	"net/http"
	"net/netip"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/time/rate"

	"github.com/medilens-ai/medilens/internal/contracts"
)

const (
	// WriteRequestsPerMinute is the write-route budget (POST, DELETE and
	// any other method that is not a read) per client (Go port spec §4).
	WriteRequestsPerMinute = 30
	// ReadRequestsPerMinute is the read-route budget (GET, HEAD, OPTIONS)
	// per client, so status polling every 750 ms is never throttled.
	ReadRequestsPerMinute = 240

	// apiPrefix scopes the limits, as Node's app.use('/api', rateLimit):
	// /healthz and /readyz are never limited.
	apiPrefix = "/api"
	// idleAfter drops a client's bucket once it has been idle this long; a
	// bucket refills completely within a minute, so dropping it changes
	// nothing, and memory stays bounded by recent clients.
	idleAfter  = 10 * time.Minute
	sweepEvery = time.Minute
	// ipv6Subnet keys an IPv6 client by its /56, as express-rate-limit v8
	// does by default: one host usually holds a whole /64 or more.
	ipv6Subnet = 56
)

// rateLimitedMessage is ERROR_MESSAGES.RATE_LIMITED.
const rateLimitedMessage = "Too many requests. Please wait a minute and try again."

// RateLimitOptions configure NewRateLimiter. Zero values take the
// defaults.
type RateLimitOptions struct {
	WritePerMinute int
	ReadPerMinute  int
	// TrustedProxies are the proxies whose X-Forwarded-For is honoured
	// (config TRUSTED_PROXIES); see ClientIP.
	TrustedProxies []netip.Prefix
	// Now is the clock; nil is time.Now.
	Now func() time.Time
}

type bucketKey struct {
	write  bool
	client netip.Addr
}

type bucket struct {
	lim  *rate.Limiter
	seen time.Time
}

// RateLimiter holds a token bucket per client and route class, in memory
// (per process, as Node's express-rate-limit memory store). Node counted a
// fixed 60 s window of 30 requests across every /api route; this is a
// token bucket per class (spec §4): a full burst is allowed, then one token
// comes back every 60 s / limit.
type RateLimiter struct {
	mu        sync.Mutex
	limits    [2]rate.Limit // [read, write]
	bursts    [2]int
	trusted   []netip.Prefix
	now       func() time.Time
	buckets   map[bucketKey]*bucket
	lastSweep time.Time
}

// NewRateLimiter makes a limiter. It starts no goroutine: idle buckets are
// swept as requests arrive.
func NewRateLimiter(opts RateLimitOptions) *RateLimiter {
	write, read := opts.WritePerMinute, opts.ReadPerMinute
	if write <= 0 {
		write = WriteRequestsPerMinute
	}
	if read <= 0 {
		read = ReadRequestsPerMinute
	}
	now := opts.Now
	if now == nil {
		now = time.Now
	}
	perMinute := func(n int) rate.Limit { return rate.Limit(float64(n) / 60) }
	return &RateLimiter{
		limits:  [2]rate.Limit{perMinute(read), perMinute(write)},
		bursts:  [2]int{read, write},
		trusted: opts.TrustedProxies,
		now:     now,
		buckets: map[bucketKey]*bucket{},
	}
}

// isRead reports whether the method uses the read budget.
func isRead(method string) bool {
	return method == http.MethodGet || method == http.MethodHead || method == http.MethodOptions
}

// take spends one token of the client's bucket for the class. When none
// is left it returns false and the whole seconds until one is back.
func (l *RateLimiter) take(write bool, client netip.Addr) (bool, int) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	if now.Sub(l.lastSweep) >= sweepEvery {
		cut := now.Add(-idleAfter)
		for k, b := range l.buckets {
			if !b.seen.After(cut) {
				delete(l.buckets, k)
			}
		}
		l.lastSweep = now
	}
	class := 0
	if write {
		class = 1
	}
	k := bucketKey{write: write, client: client}
	b, ok := l.buckets[k]
	if !ok {
		b = &bucket{lim: rate.NewLimiter(l.limits[class], l.bursts[class])}
		l.buckets[k] = b
	}
	b.seen = now
	if b.lim.AllowN(now, 1) {
		return true, 0
	}
	need := 1 - b.lim.TokensAt(now)
	return false, max(1, int(math.Ceil(need/float64(l.limits[class]))))
}

// clients is the number of buckets held (tests).
func (l *RateLimiter) clients() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.buckets)
}

// Middleware limits every /api request: past the budget it answers 429
// RATE_LIMITED with Retry-After. Other paths pass untouched.
func (l *RateLimiter) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		if p != apiPrefix && !strings.HasPrefix(p, apiPrefix+"/") {
			next.ServeHTTP(w, r)
			return
		}
		ok, retry := l.take(!isRead(r.Method), clientKey(ClientIP(r, l.trusted)))
		if !ok {
			w.Header().Set("Retry-After", strconv.Itoa(retry))
			WriteError(w, r, http.StatusTooManyRequests, contracts.ErrRateLimited, rateLimitedMessage)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// clientKey is the bucket key of a client address: an IPv6 address masked
// to its /56, an IPv4 address as it is.
func clientKey(a netip.Addr) netip.Addr {
	if a.Is6() {
		return netip.PrefixFrom(a, ipv6Subnet).Masked().Addr()
	}
	return a
}

// ClientIP is the address the rate limits key on: the socket peer, or,
// only when the peer is one of the trusted proxies, the rightmost
// X-Forwarded-For entry that is not itself a trusted proxy (the entries to
// its left can be anything a client wrote). A malformed entry, or a chain
// of trusted proxies only, gives the peer. IPv4-mapped IPv6 addresses are
// unmapped. With no trusted proxies (the default) X-Forwarded-For is never
// read.
func ClientIP(r *http.Request, trusted []netip.Prefix) netip.Addr {
	peer := remoteAddr(r.RemoteAddr)
	if !inAny(trusted, peer) {
		return peer
	}
	var hops []string
	for _, v := range r.Header.Values("X-Forwarded-For") {
		hops = append(hops, strings.Split(v, ",")...)
	}
	for i := len(hops) - 1; i >= 0; i-- {
		a, err := netip.ParseAddr(strings.TrimSpace(hops[i]))
		if err != nil {
			return peer
		}
		a = a.Unmap()
		if !inAny(trusted, a) {
			return a
		}
	}
	return peer
}

func remoteAddr(s string) netip.Addr {
	if ap, err := netip.ParseAddrPort(s); err == nil {
		return ap.Addr().Unmap()
	}
	host, _, err := net.SplitHostPort(s)
	if err != nil {
		host = s
	}
	a, _ := netip.ParseAddr(host)
	return a.Unmap()
}

func inAny(prefixes []netip.Prefix, a netip.Addr) bool {
	if !a.IsValid() {
		return false
	}
	for _, p := range prefixes {
		if p.Contains(a) {
			return true
		}
	}
	return false
}
