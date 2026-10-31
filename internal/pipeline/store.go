package pipeline

import (
	"container/list"
	"sync"
	"time"
)

const (
	// ResultTTL is how long an analysis stays retrievable for follow-up
	// calls (Node RESULT_TTL_MS: 15 minutes, memory only).
	ResultTTL = 15 * time.Minute
	// MaxEntries is the most analyses a store holds (Node
	// MAX_CACHE_ENTRIES, final review Minor 15): past it the oldest goes
	// first, so memory stays bounded whatever the request rate.
	MaxEntries = 500
)

// Store is the in-memory TTL store of analyses (base spec §3 privacy, a
// port of apps/server/src/pipeline/store.ts): entries live only in process
// memory, only long enough for follow-up calls, and are never written to
// disk. An entry expires ttl after it was put (or at the time Refresh
// set). At most maxEntries are held: a Put first sweeps every expired
// entry, then evicts the oldest. Expired entries are also dropped by the
// Get, Refresh or Delete that finds them.
//
// onEvict is called for every entry the store drops by itself (expiry or
// the cap), never for Delete or Clear, and always after the store lock is
// released, so it may call the store and may take other locks. It is safe
// for concurrent use.
type Store[V any] struct {
	mu      sync.Mutex
	now     func() time.Time
	ttl     time.Duration
	max     int
	onEvict func(V)
	entries map[string]*list.Element
	order   *list.List // of *storeEntry[V], oldest first
}

type storeEntry[V any] struct {
	id        string
	value     V
	expiresAt time.Time
}

// NewStore makes a store. ttl <= 0 means ResultTTL; maxEntries <= 0 means
// MaxEntries; onEvict may be nil.
func NewStore[V any](now func() time.Time, ttl time.Duration, maxEntries int, onEvict func(V)) *Store[V] {
	if ttl <= 0 {
		ttl = ResultTTL
	}
	if maxEntries <= 0 {
		maxEntries = MaxEntries
	}
	if onEvict == nil {
		onEvict = func(V) {}
	}
	return &Store[V]{
		now:     now,
		ttl:     ttl,
		max:     maxEntries,
		onEvict: onEvict,
		entries: map[string]*list.Element{},
		order:   list.New(),
	}
}

// TTL is how long a Put entry lives.
func (s *Store[V]) TTL() time.Duration { return s.ttl }

// Len is the number of entries held, expired ones not yet dropped
// included.
func (s *Store[V]) Len() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.order.Len()
}

// expired is Node's `now() >= expiresAt`.
func expired(now, expiresAt time.Time) bool { return !now.Before(expiresAt) }

// remove drops el and returns its value. The caller holds mu.
func (s *Store[V]) remove(el *list.Element) V {
	e := el.Value.(*storeEntry[V])
	s.order.Remove(el)
	delete(s.entries, e.id)
	return e.value
}

// evicted calls onEvict for each value, outside the lock.
func (s *Store[V]) evicted(values []V) {
	for _, v := range values {
		s.onEvict(v)
	}
}

// Put stores v under id until now + TTL, as the newest entry, replacing
// any entry with that id (which is not evicted: the caller replaced it).
func (s *Store[V]) Put(id string, v V) {
	var dropped []V
	defer func() { s.evicted(dropped) }()
	s.mu.Lock()
	defer s.mu.Unlock()
	t := s.now()
	for el := s.order.Front(); el != nil; {
		next := el.Next()
		if expired(t, el.Value.(*storeEntry[V]).expiresAt) {
			dropped = append(dropped, s.remove(el))
		}
		el = next
	}
	if el, ok := s.entries[id]; ok {
		s.remove(el)
	}
	for s.order.Len() >= s.max {
		dropped = append(dropped, s.remove(s.order.Front()))
	}
	s.entries[id] = s.order.PushBack(&storeEntry[V]{id: id, value: v, expiresAt: t.Add(s.ttl)})
}

// live returns the element for id unless it is missing or expired; an
// expired one is removed and its value returned for eviction. The caller
// holds mu.
func (s *Store[V]) live(id string) (*list.Element, []V) {
	el, ok := s.entries[id]
	if !ok {
		return nil, nil
	}
	if expired(s.now(), el.Value.(*storeEntry[V]).expiresAt) {
		return nil, []V{s.remove(el)}
	}
	return el, nil
}

// Get returns the value for id, unless it is missing or expired.
func (s *Store[V]) Get(id string) (V, bool) {
	var dropped []V
	defer func() { s.evicted(dropped) }()
	s.mu.Lock()
	defer s.mu.Unlock()
	el, d := s.live(id)
	dropped = d
	if el == nil {
		var zero V
		return zero, false
	}
	return el.Value.(*storeEntry[V]).value, true
}

// Refresh gives a live entry a new expiry and makes it the newest, as the
// Node store's put of a finished result does. It reports false, and
// changes nothing, for a missing or expired entry: an expired entry is
// never brought back.
func (s *Store[V]) Refresh(id string, expiresAt time.Time) bool {
	var dropped []V
	defer func() { s.evicted(dropped) }()
	s.mu.Lock()
	defer s.mu.Unlock()
	el, d := s.live(id)
	dropped = d
	if el == nil {
		return false
	}
	el.Value.(*storeEntry[V]).expiresAt = expiresAt
	s.order.MoveToBack(el)
	return true
}

// Delete removes the entry for id and returns its value, without calling
// onEvict. It reports false for a missing or expired entry (an expired
// one is evicted).
func (s *Store[V]) Delete(id string) (V, bool) {
	var dropped []V
	defer func() { s.evicted(dropped) }()
	s.mu.Lock()
	defer s.mu.Unlock()
	el, d := s.live(id)
	dropped = d
	if el == nil {
		var zero V
		return zero, false
	}
	return s.remove(el), true
}

// Clear removes every entry and returns their values, oldest first,
// without calling onEvict.
func (s *Store[V]) Clear() []V {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []V
	for s.order.Len() > 0 {
		out = append(out, s.remove(s.order.Front()))
	}
	return out
}
