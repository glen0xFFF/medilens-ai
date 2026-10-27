package references

import (
	"testing"
	"time"
)

// clock is a settable test clock, as the Node tests' `() => t`.
type clock struct{ t time.Time }

func (c *clock) now() time.Time { return c.t }
func (c *clock) set(ms int64)   { c.t = time.UnixMilli(ms) }

func get[K comparable, V any](c *TTLCache[K, V], k K) any {
	v, ok := c.Get(k)
	if !ok {
		return nil
	}
	return v
}

func TestTTLCacheReturnsValuesUntilTheTTLElapses(t *testing.T) {
	clk := &clock{}
	clk.set(0)
	c := NewTTLCache[string, int](1000*time.Millisecond, clk.now, 0)
	c.Set("a", 1)
	if got := get(c, "a"); got != 1 {
		t.Fatalf("t=0: got %v", got)
	}
	clk.set(999)
	if got := get(c, "a"); got != 1 {
		t.Fatalf("t=999: got %v", got)
	}
	clk.set(1000)
	if got := get(c, "a"); got != nil {
		t.Fatalf("t=1000: got %v, want expired", got)
	}
	if got := get(c, "missing"); got != nil {
		t.Fatalf("missing: got %v", got)
	}
}

// final review Minor 15: TtlCache holds at most maxEntries, oldest first out.
func TestTTLCacheDefaultCapIs500(t *testing.T) {
	if DefaultMaxEntries != 500 {
		t.Fatalf("DefaultMaxEntries = %d, want 500", DefaultMaxEntries)
	}
	c := NewTTLCache[int, int](time.Second, func() time.Time { return time.UnixMilli(0) }, 0)
	for i := 0; i < 501; i++ {
		c.Set(i, i)
	}
	if c.Len() != 500 {
		t.Fatalf("Len = %d, want 500", c.Len())
	}
	if got := get(c, 0); got != nil {
		t.Errorf("entry 0 kept: %v", got)
	}
	if got := get(c, 500); got != 500 {
		t.Errorf("entry 500: %v", got)
	}
}

func TestTTLCacheSettingPastTheCapEvictsTheOldest(t *testing.T) {
	c := NewTTLCache[string, int](time.Second, func() time.Time { return time.UnixMilli(0) }, 3)
	c.Set("a", 1)
	c.Set("b", 2)
	c.Set("c", 3)
	c.Set("d", 4)
	if c.Len() != 3 {
		t.Fatalf("Len = %d", c.Len())
	}
	if got := get(c, "a"); got != nil {
		t.Errorf("a kept: %v", got)
	}
	for k, want := range map[string]int{"b": 2, "c": 3, "d": 4} {
		if got := get(c, k); got != want {
			t.Errorf("%s = %v, want %d", k, got, want)
		}
	}
}

func TestTTLCacheSweepsExpiredEntriesBeforeEvictingALiveOne(t *testing.T) {
	clk := &clock{}
	clk.set(0)
	c := NewTTLCache[string, int](1000*time.Millisecond, clk.now, 2)
	c.Set("old", 1)
	clk.set(500)
	c.Set("live", 2)
	clk.set(1000) // "old" has expired, "live" has not
	c.Set("new", 3)
	if got := get(c, "live"); got != 2 {
		t.Errorf("live = %v", got)
	}
	if got := get(c, "new"); got != 3 {
		t.Errorf("new = %v", got)
	}
}

func TestTTLCacheSettingAKeyAgainMakesItTheNewest(t *testing.T) {
	c := NewTTLCache[string, int](time.Second, func() time.Time { return time.UnixMilli(0) }, 2)
	c.Set("a", 1)
	c.Set("b", 2)
	c.Set("a", 10)
	c.Set("c", 3)
	if got := get(c, "a"); got != 10 {
		t.Errorf("a = %v", got)
	}
	if got := get(c, "b"); got != nil {
		t.Errorf("b kept: %v", got)
	}
}

// A get does not make an entry newer (a Map keeps insertion order).
func TestTTLCacheGetDoesNotRefreshOrder(t *testing.T) {
	c := NewTTLCache[string, int](time.Second, func() time.Time { return time.UnixMilli(0) }, 2)
	c.Set("a", 1)
	c.Set("b", 2)
	_ = get(c, "a")
	c.Set("c", 3)
	if got := get(c, "a"); got != nil {
		t.Errorf("a kept after a get: %v", got)
	}
}

// The pipeline runs jobs on more than one goroutine; the cache must be safe
// to share (checked under go vet; -race is unavailable with CGO_ENABLED=0).
func TestTTLCacheConcurrentUse(t *testing.T) {
	c := NewTTLCache[int, int](time.Second, time.Now, 50)
	done := make(chan struct{})
	for g := 0; g < 8; g++ {
		go func(g int) {
			defer func() { done <- struct{}{} }()
			for i := 0; i < 1000; i++ {
				c.Set(g*1000+i, i)
				c.Get(g*1000 + i/2)
			}
		}(g)
	}
	for g := 0; g < 8; g++ {
		<-done
	}
	if c.Len() > 50 {
		t.Errorf("Len = %d, over the cap", c.Len())
	}
}
