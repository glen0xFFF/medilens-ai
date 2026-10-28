package pipeline

import (
	"math"
	"sync"
	"testing"
	"time"

	"github.com/medilens-ai/medilens/internal/ai"
)

// Ports apps/server/test/pipeline/budget.test.ts.

func at(t *testing.T, iso string) time.Time {
	t.Helper()
	v, err := time.Parse(time.RFC3339Nano, iso)
	if err != nil {
		t.Fatal(err)
	}
	return v
}

type clock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *clock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *clock) set(t time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = t
}

func (c *clock) advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

func fixed(t time.Time) func() time.Time { return func() time.Time { return t } }

func closeTo(a, b float64) bool { return math.Abs(a-b) < 1e-10 }

func TestSpendMeterPricesOneMillionInputAndOutputTokensAt5Dollars50(t *testing.T) {
	m := NewSpendMeter(100, fixed(at(t, "2026-10-27T10:00:00.000Z")))
	m.Record(ai.Usage{PromptTokens: 1_000_000, CompletionTokens: 1_000_000})
	if !closeTo(m.SpentUSD(), 5.5) {
		t.Errorf("spent %v", m.SpentUSD())
	}
}

func TestSpendMeterPricesInputAt1Dollar25AndOutputAt4Dollars25PerMillion(t *testing.T) {
	if InputUSDPerMTok != 1.25 || OutputUSDPerMTok != 4.25 {
		t.Fatalf("prices %v %v", InputUSDPerMTok, OutputUSDPerMTok)
	}
	m := NewSpendMeter(100, fixed(at(t, "2026-10-27T10:00:00.000Z")))
	m.Record(ai.Usage{PromptTokens: 2_000_000})
	if !closeTo(m.SpentUSD(), 2.5) {
		t.Errorf("spent %v", m.SpentUSD())
	}
	m.Record(ai.Usage{CompletionTokens: 2_000_000})
	if !closeTo(m.SpentUSD(), 2.5+8.5) {
		t.Errorf("spent %v", m.SpentUSD())
	}
}

func TestSpendMeterStartsAtZeroAndNotExhausted(t *testing.T) {
	m := NewSpendMeter(5, fixed(at(t, "2026-10-27T10:00:00.000Z")))
	if m.SpentUSD() != 0 || m.Exhausted() {
		t.Errorf("spent %v exhausted %v", m.SpentUSD(), m.Exhausted())
	}
}

func TestSpendMeterIsExhaustedOnceTheDaySpendReachesTheCapNotBefore(t *testing.T) {
	m := NewSpendMeter(5, fixed(at(t, "2026-10-27T10:00:00.000Z")))
	m.Record(ai.Usage{PromptTokens: 3_999_999})
	if m.Exhausted() {
		t.Fatal("exhausted below the cap")
	}
	m.Record(ai.Usage{PromptTokens: 1})
	if !closeTo(m.SpentUSD(), 5) || !m.Exhausted() {
		t.Errorf("spent %v exhausted %v", m.SpentUSD(), m.Exhausted())
	}
}

func TestSpendMeterResetsAfterUTCMidnight(t *testing.T) {
	c := &clock{t: at(t, "2026-10-27T23:59:59.999Z")}
	m := NewSpendMeter(5, c.now)
	m.Record(ai.Usage{PromptTokens: 1_000_000, CompletionTokens: 1_000_000})
	if !m.Exhausted() {
		t.Fatal("not exhausted")
	}
	c.set(at(t, "2026-10-28T00:00:00.000Z"))
	if m.SpentUSD() != 0 || m.Exhausted() {
		t.Errorf("after midnight: spent %v exhausted %v", m.SpentUSD(), m.Exhausted())
	}
	m.Record(ai.Usage{PromptTokens: 1_000_000})
	if !closeTo(m.SpentUSD(), 1.25) {
		t.Errorf("spent %v", m.SpentUSD())
	}
}

func TestSpendMeterDoesNotResetAtManilaMidnight(t *testing.T) {
	c := &clock{t: at(t, "2026-10-27T15:59:00.000Z")}
	m := NewSpendMeter(5, c.now)
	m.Record(ai.Usage{PromptTokens: 1_000_000, CompletionTokens: 1_000_000})
	c.set(at(t, "2026-10-27T16:01:00.000Z"))
	if !closeTo(m.SpentUSD(), 5.5) || !m.Exhausted() {
		t.Errorf("spent %v exhausted %v", m.SpentUSD(), m.Exhausted())
	}
}

func TestSpendMeterCapOfZeroDisablesLiveCalls(t *testing.T) {
	if !NewSpendMeter(0, fixed(at(t, "2026-10-27T10:00:00.000Z"))).Exhausted() {
		t.Error("a cap of 0 is not exhausted")
	}
}

func TestSpendMeterIgnoresNegativeOrNonFiniteTokenCounts(t *testing.T) {
	m := NewSpendMeter(5, fixed(at(t, "2026-10-27T10:00:00.000Z")))
	m.Record(ai.Usage{PromptTokens: 1_000_000})
	m.Record(ai.Usage{PromptTokens: math.NaN(), CompletionTokens: -5})
	m.Record(ai.Usage{PromptTokens: math.Inf(1)})
	if !closeTo(m.SpentUSD(), 1.25) {
		t.Errorf("spent %v", m.SpentUSD())
	}
}

// Go addition: the meter is shared by every request goroutine.
func TestSpendMeterIsSafeForConcurrentUse(t *testing.T) {
	m := NewSpendMeter(1000, fixed(at(t, "2026-10-27T10:00:00.000Z")))
	var wg sync.WaitGroup
	for range 50 {
		wg.Go(func() {
			for range 100 {
				m.Record(ai.Usage{PromptTokens: 1000})
				_ = m.Exhausted()
			}
		})
	}
	wg.Wait()
	// 5,000,000 tokens at $1.25 per 1M
	if !closeTo(m.SpentUSD(), 6.25) {
		t.Errorf("spent %v", m.SpentUSD())
	}
}

// The UTC day is floor(ms / 86,400,000), as Node computes it, also before 1970.
func TestSpendMeterDayIsTheFlooredUTCDay(t *testing.T) {
	c := &clock{t: at(t, "1969-12-31T23:59:59.999Z")}
	m := NewSpendMeter(5, c.now)
	m.Record(ai.Usage{PromptTokens: 1_000_000})
	if !closeTo(m.SpentUSD(), 1.25) {
		t.Fatalf("spent %v before midnight", m.SpentUSD())
	}
	c.set(at(t, "1970-01-01T00:00:00.000Z"))
	if m.SpentUSD() != 0 {
		t.Errorf("no reset across the 1970 midnight: %v", m.SpentUSD())
	}
}
