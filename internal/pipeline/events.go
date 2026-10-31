package pipeline

import (
	"slices"
	"sync"
	"time"

	"github.com/medilens-ai/medilens/internal/contracts"
)

// Progress events of one analysis (Go port spec §4, "Event stages"). An
// event is emitted only when its stage actually starts; a stage that does
// not run is skipped, never faked. The log enforces that by construction:
// stages only move forward in stageOrder, each at most once, and nothing
// follows the terminal event.

// Stage is a pipeline stage, as named in the events.
type Stage string

const (
	StageReceived           Stage = "received"
	StageQuality            Stage = "quality"
	StageReading            Stage = "reading"
	StageReviewingFields    Stage = "reviewing_fields"
	StageCheckingReferences Stage = "checking_references"
	StageComparing          Stage = "comparing"
	StageExplaining         Stage = "explaining"
	// StageCompleted ends an analysis whose result is explanation_ready.
	StageCompleted Stage = "completed"
	// StageNeedsAttention ends an analysis that completed with a quality
	// failure, a loose pill, no medicine label or an unreadable label: a
	// result, not an error.
	StageNeedsAttention Stage = "needs_attention"
	// StageFailed ends an analysis that failed with an error and has no
	// result.
	StageFailed Stage = "failed"
)

// stageOrder is the order of the non-terminal stages.
var stageOrder = []Stage{
	StageReceived, StageQuality, StageReading, StageReviewingFields,
	StageCheckingReferences, StageComparing, StageExplaining,
}

// MaxEvents is the most events one analysis can have: every ordered stage
// plus the terminal one. Each subscriber channel holds this many, so the
// publisher never waits on a subscriber.
const MaxEvents = 8

// stageLabels are the plain-English labels a client may speak (TTS). A
// failed event's label is the error message instead.
var stageLabels = map[Stage]string{
	StageReceived:           "Request received.",
	StageQuality:            "Checking the photo quality.",
	StageReading:            "Reading the label.",
	StageReviewingFields:    "Reviewing what was read.",
	StageCheckingReferences: "Checking the registry.",
	StageComparing:          "Comparing the label with the registry.",
	StageExplaining:         "Preparing the summary.",
	StageCompleted:          "The result is ready.",
	StageNeedsAttention:     "The result is ready. It needs your attention.",
}

// Label is the stage's fixed label ("" for StageFailed and unknown
// stages).
func (s Stage) Label() string { return stageLabels[s] }

// Terminal reports whether s ends an analysis.
func (s Stage) Terminal() bool {
	return s == StageCompleted || s == StageNeedsAttention || s == StageFailed
}

// Event is one progress event: {seq, stage, label, at}. Seq starts at 1
// and is the SSE event id.
type Event struct {
	Seq   int    `json:"seq"`
	Stage Stage  `json:"stage"`
	Label string `json:"label"`
	At    string `json:"at"`
}

// Name is the SSE event name: "stage", or "completed" (completed and
// needs_attention) or "failed".
func (e Event) Name() string {
	switch e.Stage {
	case StageCompleted, StageNeedsAttention:
		return "completed"
	case StageFailed:
		return "failed"
	}
	return "stage"
}

// EventLog is the ordered event log of one analysis, with its live
// subscribers. It is safe for concurrent use. It starts no goroutines:
// events are delivered into buffered subscriber channels under its lock.
type EventLog struct {
	mu     sync.Mutex
	now    func() time.Time
	events []Event
	// rank of the last stage emitted: its index in stageOrder, -1 before
	// any event.
	rank   int
	done   bool // terminal event emitted, or the log was closed
	subs   map[int]chan Event
	nextID int
}

// NewEventLog makes an empty log whose events are timed with now.
func NewEventLog(now func() time.Time) *EventLog {
	return &EventLog{now: now, rank: -1, subs: map[int]chan Event{}}
}

// Emit appends the event of stage s with its fixed label. It reports
// false, and appends nothing, when s is not after the last stage emitted,
// is StageFailed (use Fail) or unknown, or the log is done.
func (l *EventLog) Emit(s Stage) bool {
	if s == StageFailed || s.Label() == "" {
		return false
	}
	return l.append(s, s.Label())
}

// Fail appends the terminal failed event whose label is message (the
// error message a client may speak). It reports false for an empty
// message or a done log.
func (l *EventLog) Fail(message string) bool {
	if message == "" {
		return false
	}
	return l.append(StageFailed, message)
}

func (l *EventLog) append(s Stage, label string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.done {
		return false
	}
	if !s.Terminal() {
		r := slices.Index(stageOrder, s)
		if r <= l.rank {
			return false
		}
		l.rank = r
	}
	e := Event{Seq: len(l.events) + 1, Stage: s, Label: label, At: contracts.FormatTime(l.now())}
	l.events = append(l.events, e)
	for id, ch := range l.subs {
		select {
		case ch <- e:
		default:
			// unreachable: a channel holds MaxEvents and an analysis has
			// no more. Never block the pipeline: drop the subscriber, which
			// can subscribe again from its last seq.
			close(ch)
			delete(l.subs, id)
		}
	}
	if s.Terminal() {
		l.closeSubs()
		l.done = true
	}
	return true
}

// closeSubs closes and forgets every subscriber. The caller holds mu.
func (l *EventLog) closeSubs() {
	for id, ch := range l.subs {
		close(ch)
		delete(l.subs, id)
	}
}

// Events returns a copy of the events so far, in order.
func (l *EventLog) Events() []Event {
	l.mu.Lock()
	defer l.mu.Unlock()
	return slices.Clone(l.events)
}

// Done reports whether the terminal event was emitted or the log closed.
func (l *EventLog) Done() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.done
}

// Subscribe returns a channel that first replays the events with a seq
// above afterSeq, then receives every later event, and is closed after
// the terminal event, when the log is closed, or by cancel. On a done log
// it holds the replay and is already closed. cancel is safe to call more
// than once and after the channel was closed.
func (l *EventLog) Subscribe(afterSeq int) (<-chan Event, func()) {
	l.mu.Lock()
	defer l.mu.Unlock()
	ch := make(chan Event, MaxEvents)
	for _, e := range l.events {
		if e.Seq > afterSeq {
			ch <- e
		}
	}
	if l.done {
		close(ch)
		return ch, func() {}
	}
	id := l.nextID
	l.nextID++
	l.subs[id] = ch
	return ch, func() {
		l.mu.Lock()
		defer l.mu.Unlock()
		if c, ok := l.subs[id]; ok {
			close(c)
			delete(l.subs, id)
		}
	}
}

// Close drops the log: every subscriber channel is closed with no
// terminal event, and nothing more is appended. Safe to call more than
// once.
func (l *EventLog) Close() {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.closeSubs()
	l.done = true
}

// subscribers is the number of live subscribers (tests).
func (l *EventLog) subscribers() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.subs)
}
