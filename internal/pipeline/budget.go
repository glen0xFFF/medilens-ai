package pipeline

import (
	"math"
	"sync"
	"time"

	"github.com/medilens-ai/medilens/internal/ai"
)

// The daily spend cap for live Muse Spark calls (base spec §5.1, public
// live access), a port of apps/server/src/pipeline/budget.ts. Each
// completion's usage is priced and summed per UTC day; the service checks
// Exhausted() before it accepts a live analysis or answers a live
// question, and answers LIVE_BUDGET_EXHAUSTED instead. In memory only: a
// restart starts the day at zero again.
//
// The check runs when a job is accepted, and the usage is recorded after
// the call (controller ruling for task G7). So, as the Node README says:
// requests already in flight when the cap is reached can each still finish
// one call. In the Go service "in flight" includes analyses accepted into
// the queue and not yet started.

const (
	// InputUSDPerMTok is USD per 1M input tokens.
	InputUSDPerMTok = 1.25
	// OutputUSDPerMTok is USD per 1M output tokens; hidden reasoning is
	// billed as output.
	OutputUSDPerMTok = 4.25
)

const dayMS = 24 * 60 * 60 * 1000

// SpendMeter sums priced token usage per UTC day. It is safe for
// concurrent use.
type SpendMeter struct {
	mu  sync.Mutex
	now func() time.Time
	day int64
	// spentMicro is summed in micro-dollars (USD per 1M tokens =
	// micro-dollars per token): token counts times quarter-dollar prices
	// add up exactly, with no drift around the cap.
	spentMicro float64
	capMicro   float64
}

// NewSpendMeter makes a meter with a cap of capUSD a day. A cap of 0
// disables live calls.
func NewSpendMeter(capUSD float64, now func() time.Time) *SpendMeter {
	return &SpendMeter{now: now, day: utcDay(now()), capMicro: capUSD * 1_000_000}
}

// utcDay is Math.floor(ms / DAY_MS).
func utcDay(t time.Time) int64 {
	ms := t.UnixMilli()
	d := ms / dayMS
	if ms%dayMS < 0 {
		d--
	}
	return d
}

// tokens is a token count that can be priced; anything else counts as 0.
func tokens(n float64) float64 {
	if math.IsNaN(n) || math.IsInf(n, 0) || n <= 0 {
		return 0
	}
	return n
}

// roll starts a new total when the UTC day has changed since the last
// call. The caller holds mu.
func (m *SpendMeter) roll() {
	if today := utcDay(m.now()); today != m.day {
		m.day = today
		m.spentMicro = 0
	}
}

// Record adds the price of one call's usage to the day's total.
func (m *SpendMeter) Record(u ai.Usage) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.roll()
	m.spentMicro += tokens(u.PromptTokens)*InputUSDPerMTok + tokens(u.CompletionTokens)*OutputUSDPerMTok
}

// Exhausted reports whether the day's spend has reached the cap.
func (m *SpendMeter) Exhausted() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.roll()
	return m.spentMicro >= m.capMicro
}

// SpentUSD is the day's spend so far.
func (m *SpendMeter) SpentUSD() float64 {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.roll()
	return m.spentMicro / 1_000_000
}
