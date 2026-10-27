package pipeline

import (
	"fmt"
	"slices"
	"sync"
	"testing"
	"time"
)

// Ports the createResultStore cases of apps/server/test/pipeline/analyze.test.ts
// (TTL, custom TTL, cap and sweep), for the Go store of analyses.

var t0 = time.Date(2026, 10, 27, 8, 0, 0, 0, time.UTC)

const fifteenMin = 15 * time.Minute

type evictions struct {
	mu  sync.Mutex
	ids []string
}

func (e *evictions) add(v string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.ids = append(e.ids, v)
}

func (e *evictions) list() []string {
	e.mu.Lock()
	defer e.mu.Unlock()
	return slices.Clone(e.ids)
}

func newTestStore(c *clock, ttl time.Duration, max int) (*Store[string], *evictions) {
	ev := &evictions{}
	return NewStore(c.now, ttl, max, ev.add), ev
}

func TestStoreDefaultsAre15MinutesAnd500Entries(t *testing.T) {
	if ResultTTL != 15*time.Minute || MaxEntries != 500 {
		t.Fatalf("ResultTTL %v MaxEntries %d", ResultTTL, MaxEntries)
	}
	s := NewStore[string](fixed(t0), 0, 0, nil)
	if s.TTL() != ResultTTL {
		t.Errorf("ttl %v", s.TTL())
	}
	for i := range MaxEntries + 1 {
		s.Put(fmt.Sprint("r", i), "v")
	}
	if s.Len() != MaxEntries {
		t.Errorf("len %d", s.Len())
	}
	if _, ok := s.Get("r0"); ok {
		t.Error("r0 not evicted")
	}
	if _, ok := s.Get("r1"); !ok {
		t.Error("r1 evicted")
	}
}

func TestStoreReturnsAnEntryUntilItsTTLHasPassed(t *testing.T) {
	c := &clock{t: t0}
	s, ev := newTestStore(c, fifteenMin, 10)
	s.Put("a", "A")
	c.advance(fifteenMin - time.Millisecond)
	if v, ok := s.Get("a"); !ok || v != "A" {
		t.Fatalf("got %q %v", v, ok)
	}
	c.advance(time.Millisecond)
	if _, ok := s.Get("a"); ok {
		t.Fatal("still there at the TTL")
	}
	if got := ev.list(); !slices.Equal(got, []string{"A"}) {
		t.Errorf("evicted %v", got)
	}
	if s.Len() != 0 {
		t.Errorf("len %d", s.Len())
	}
}

func TestStoreUnknownIDIsAbsent(t *testing.T) {
	s, _ := newTestStore(&clock{t: t0}, fifteenMin, 10)
	if _, ok := s.Get("nope"); ok {
		t.Error("found")
	}
}

func TestStoreHonoursACustomTTL(t *testing.T) {
	c := &clock{t: t0}
	s, _ := newTestStore(c, time.Second, 10)
	if s.TTL() != time.Second {
		t.Fatalf("ttl %v", s.TTL())
	}
	s.Put("x", "X")
	c.advance(999 * time.Millisecond)
	if _, ok := s.Get("x"); !ok {
		t.Fatal("expired early")
	}
	c.advance(time.Millisecond)
	if _, ok := s.Get("x"); ok {
		t.Fatal("not expired")
	}
}

func TestStoreCustomCapEvictsTheOldestFirst(t *testing.T) {
	s, ev := newTestStore(&clock{t: t0}, fifteenMin, 2)
	s.Put("a", "A")
	s.Put("b", "B")
	s.Put("c", "C")
	if _, ok := s.Get("a"); ok {
		t.Error("a kept")
	}
	for _, id := range []string{"b", "c"} {
		if _, ok := s.Get(id); !ok {
			t.Errorf("%s evicted", id)
		}
	}
	if got := ev.list(); !slices.Equal(got, []string{"A"}) {
		t.Errorf("evicted %v", got)
	}
}

func TestStoreSweepsExpiredEntriesBeforeEvictingALiveOne(t *testing.T) {
	c := &clock{t: t0}
	s, ev := newTestStore(c, time.Second, 2)
	s.Put("old", "OLD")
	c.advance(500 * time.Millisecond)
	s.Put("live", "LIVE")
	c.advance(500 * time.Millisecond) // old has expired
	s.Put("new", "NEW")
	for _, id := range []string{"live", "new"} {
		if _, ok := s.Get(id); !ok {
			t.Errorf("%s evicted", id)
		}
	}
	if got := ev.list(); !slices.Equal(got, []string{"OLD"}) {
		t.Errorf("evicted %v", got)
	}
}

// Refresh is the Node put at completion: a new expiry, and the entry
// becomes the newest.
func TestStoreRefreshSetsANewExpiryAndMakesTheEntryNewest(t *testing.T) {
	c := &clock{t: t0}
	s, ev := newTestStore(c, time.Second, 2)
	s.Put("a", "A")
	s.Put("b", "B")
	c.advance(900 * time.Millisecond)
	if !s.Refresh("a", c.now().Add(time.Second)) {
		t.Fatal("refresh failed")
	}
	s.Put("c", "C") // evicts b, now the oldest
	if got := ev.list(); !slices.Equal(got, []string{"B"}) {
		t.Errorf("evicted %v", got)
	}
	c.advance(500 * time.Millisecond) // past a's first expiry, before the new one
	if _, ok := s.Get("a"); !ok {
		t.Error("a expired at its old time")
	}
}

// An expired entry is never brought back by a late Refresh (a job that
// finishes after its analysis expired).
func TestStoreRefreshOfAnExpiredOrMissingEntryFails(t *testing.T) {
	c := &clock{t: t0}
	s, ev := newTestStore(c, time.Second, 10)
	s.Put("a", "A")
	c.advance(time.Second)
	if s.Refresh("a", c.now().Add(time.Hour)) {
		t.Error("refreshed an expired entry")
	}
	if _, ok := s.Get("a"); ok {
		t.Error("expired entry resurrected")
	}
	if got := ev.list(); !slices.Equal(got, []string{"A"}) {
		t.Errorf("evicted %v", got)
	}
	if s.Refresh("missing", c.now().Add(time.Hour)) {
		t.Error("refreshed a missing entry")
	}
}

func TestStoreDeleteRemovesWithoutTheEvictHook(t *testing.T) {
	s, ev := newTestStore(&clock{t: t0}, time.Second, 10)
	s.Put("a", "A")
	v, ok := s.Delete("a")
	if !ok || v != "A" {
		t.Fatalf("delete %q %v", v, ok)
	}
	if _, ok := s.Get("a"); ok {
		t.Error("still there")
	}
	if _, ok := s.Delete("a"); ok {
		t.Error("deleted twice")
	}
	if len(ev.list()) != 0 {
		t.Errorf("evict hook called: %v", ev.list())
	}
}

func TestStoreClearReturnsEveryEntry(t *testing.T) {
	c := &clock{t: t0}
	s, _ := newTestStore(c, time.Second, 10)
	s.Put("a", "A")
	s.Put("b", "B")
	got := s.Clear()
	slices.Sort(got)
	if !slices.Equal(got, []string{"A", "B"}) || s.Len() != 0 {
		t.Errorf("clear %v len %d", got, s.Len())
	}
}

// The evict hook runs outside the store lock, so it may use the store.
func TestStoreEvictHookMayCallTheStore(t *testing.T) {
	c := &clock{t: t0}
	var s *Store[string]
	calls := 0
	s = NewStore(c.now, time.Second, 1, func(string) {
		calls++
		_ = s.Len()
		_, _ = s.Get("x")
	})
	s.Put("a", "A")
	s.Put("b", "B")
	if calls != 1 {
		t.Errorf("calls %d", calls)
	}
}

func TestStoreIsSafeForConcurrentUse(t *testing.T) {
	c := &clock{t: t0}
	s, _ := newTestStore(c, time.Second, 20)
	var wg sync.WaitGroup
	for g := range 8 {
		wg.Go(func() {
			for i := range 200 {
				id := fmt.Sprint(g, "-", i)
				s.Put(id, id)
				_, _ = s.Get(id)
				_ = s.Refresh(id, c.now().Add(time.Second))
				if i%3 == 0 {
					_, _ = s.Delete(id)
				}
				c.advance(time.Millisecond)
			}
		})
	}
	wg.Wait()
	if s.Len() > 20 {
		t.Errorf("len %d over the cap", s.Len())
	}
}
