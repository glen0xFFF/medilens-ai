package references

import (
	"container/list"
	"sync"
	"time"
)

// DefaultMaxEntries is the most entries a cache holds unless told
// otherwise (Node MAX_CACHE_ENTRIES, final review Minor 15): past it the
// oldest entry goes first, so memory stays bounded whatever the request rate.
const DefaultMaxEntries = 500

// TTLCache is an in-memory cache whose entries expire ttl after they were
// set (apps/server/src/providers/cache.ts). It holds at most its maximum:
// setting past it first sweeps every expired entry, then evicts the oldest.
// Setting a key again makes it the newest; a Get does not. It is safe for
// concurrent use.
type TTLCache[K comparable, V any] struct {
	mu      sync.Mutex
	ttl     time.Duration
	now     func() time.Time
	max     int
	entries map[K]*list.Element
	order   *list.List // of *ttlEntry, oldest first
}

type ttlEntry[K comparable, V any] struct {
	key       K
	value     V
	expiresAt time.Time
}

// NewTTLCache makes a cache. maxEntries <= 0 means DefaultMaxEntries.
func NewTTLCache[K comparable, V any](ttl time.Duration, now func() time.Time, maxEntries int) *TTLCache[K, V] {
	if maxEntries <= 0 {
		maxEntries = DefaultMaxEntries
	}
	return &TTLCache[K, V]{
		ttl:     ttl,
		now:     now,
		max:     maxEntries,
		entries: map[K]*list.Element{},
		order:   list.New(),
	}
}

// Len is the number of entries held, expired ones not yet swept included.
func (c *TTLCache[K, V]) Len() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.order.Len()
}

// Get returns the value for k, unless it is missing or expired (an expired
// entry is dropped).
func (c *TTLCache[K, V]) Get(k K) (V, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	var zero V
	el, ok := c.entries[k]
	if !ok {
		return zero, false
	}
	e := el.Value.(*ttlEntry[K, V])
	if !c.now().Before(e.expiresAt) {
		c.remove(el)
		return zero, false
	}
	return e.value, true
}

// Set stores v under k as the newest entry, expiring ttl from now.
func (c *TTLCache[K, V]) Set(k K, v V) {
	c.mu.Lock()
	defer c.mu.Unlock()
	t := c.now()
	if el, ok := c.entries[k]; ok {
		c.remove(el)
	}
	if c.order.Len() >= c.max {
		for el := c.order.Front(); el != nil; {
			next := el.Next()
			if !t.Before(el.Value.(*ttlEntry[K, V]).expiresAt) {
				c.remove(el)
			}
			el = next
		}
	}
	for c.order.Len() >= c.max {
		c.remove(c.order.Front())
	}
	c.entries[k] = c.order.PushBack(&ttlEntry[K, V]{key: k, value: v, expiresAt: t.Add(c.ttl)})
}

func (c *TTLCache[K, V]) remove(el *list.Element) {
	delete(c.entries, el.Value.(*ttlEntry[K, V]).key)
	c.order.Remove(el)
}
