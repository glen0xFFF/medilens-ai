package pipeline

import (
	"encoding/json"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

var happyStages = []Stage{
	StageReceived, StageQuality, StageReading, StageReviewingFields,
	StageCheckingReferences, StageComparing, StageExplaining, StageCompleted,
}

func stagesOf(events []Event) []Stage {
	out := []Stage{}
	for _, e := range events {
		out = append(out, e.Stage)
	}
	return out
}

// drain reads ch until it is closed, failing after a second.
func drain(t *testing.T, ch <-chan Event) []Event {
	t.Helper()
	var out []Event
	timeout := time.After(time.Second)
	for {
		select {
		case e, ok := <-ch:
			if !ok {
				return out
			}
			out = append(out, e)
		case <-timeout:
			t.Fatalf("channel not closed; got %v", stagesOf(out))
			return nil
		}
	}
}

func TestStagesHaveFixedPlainEnglishLabels(t *testing.T) {
	all := append(slices.Clone(happyStages), StageNeedsAttention)
	for _, s := range all {
		label := s.Label()
		if label == "" || !strings.HasSuffix(label, ".") {
			t.Errorf("%s label %q", s, label)
		}
		if lower := strings.ToLower(label); strings.Contains(lower, "fake") || strings.Contains(lower, "counterfeit") {
			t.Errorf("%s label %q", s, label)
		}
	}
	if len(stageOrder) != MaxEvents-1 {
		t.Errorf("MaxEvents %d for %d ordered stages", MaxEvents, len(stageOrder))
	}
}

func TestStageTerminalAndEventNames(t *testing.T) {
	for _, s := range happyStages[:7] {
		if s.Terminal() || (Event{Stage: s}).Name() != "stage" {
			t.Errorf("%s terminal or named %q", s, Event{Stage: s}.Name())
		}
	}
	for s, name := range map[Stage]string{StageCompleted: "completed", StageNeedsAttention: "completed", StageFailed: "failed"} {
		if !s.Terminal() || (Event{Stage: s}).Name() != name {
			t.Errorf("%s terminal %v named %q", s, s.Terminal(), Event{Stage: s}.Name())
		}
	}
}

func TestEventLogNumbersAndTimesEventsInOrder(t *testing.T) {
	c := &clock{t: t0}
	l := NewEventLog(c.now)
	for _, s := range happyStages {
		if !l.Emit(s) {
			t.Fatalf("emit %s refused", s)
		}
		c.advance(time.Second)
	}
	events := l.Events()
	if got := stagesOf(events); !slices.Equal(got, happyStages) {
		t.Fatalf("stages %v", got)
	}
	for i, e := range events {
		if e.Seq != i+1 || e.Label != e.Stage.Label() || e.At != t0.Add(time.Duration(i)*time.Second).Format("2006-01-02T15:04:05.000Z") {
			t.Errorf("event %d: %+v", i, e)
		}
	}
	b, err := json.Marshal(events[0])
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != `{"seq":1,"stage":"received","label":"`+StageReceived.Label()+`","at":"2026-10-27T08:00:00.000Z"}` {
		t.Errorf("json %s", b)
	}
	if !l.Done() {
		t.Error("not done after the terminal event")
	}
}

// A stage is emitted once, after every earlier stage it follows, and
// nothing is emitted after the terminal event: progress can never go back
// or be repeated.
func TestEventLogRefusesOutOfOrderRepeatedOrLateStages(t *testing.T) {
	l := NewEventLog(fixed(t0))
	if !l.Emit(StageReceived) || !l.Emit(StageReading) {
		t.Fatal("a skip forward was refused")
	}
	for _, s := range []Stage{StageReceived, StageQuality, StageReading, Stage("bogus"), StageFailed + "x"} {
		if l.Emit(s) {
			t.Errorf("emit %s accepted", s)
		}
	}
	if !l.Fail("Something went wrong. Please try again.") {
		t.Fatal("fail refused")
	}
	if l.Emit(StageExplaining) || l.Emit(StageCompleted) || l.Fail("again") {
		t.Error("an event after the terminal one was accepted")
	}
	events := l.Events()
	if got := stagesOf(events); !slices.Equal(got, []Stage{StageReceived, StageReading, StageFailed}) {
		t.Fatalf("stages %v", got)
	}
	if events[2].Label != "Something went wrong. Please try again." || events[2].Name() != "failed" {
		t.Errorf("failed event %+v", events[2])
	}
}

func TestEventLogEmitDoesNotAcceptFailedWithoutAMessage(t *testing.T) {
	l := NewEventLog(fixed(t0))
	if l.Emit(StageFailed) || l.Fail("") {
		t.Error("a failed event without a message was accepted")
	}
}

func TestSubscribeReplaysThenStreamsLiveEventsAndClosesAfterTheTerminalOne(t *testing.T) {
	l := NewEventLog(fixed(t0))
	l.Emit(StageReceived)
	l.Emit(StageQuality)
	ch, cancel := l.Subscribe(0)
	defer cancel()
	for _, s := range happyStages[2:] {
		l.Emit(s)
	}
	got := drain(t, ch)
	if !slices.Equal(stagesOf(got), happyStages) {
		t.Errorf("stages %v", stagesOf(got))
	}
	for i, e := range got {
		if e.Seq != i+1 {
			t.Errorf("seq %d at %d", e.Seq, i)
		}
	}
}

func TestSubscribeAfterSeqReplaysOnlyLaterEvents(t *testing.T) {
	l := NewEventLog(fixed(t0))
	for _, s := range happyStages[:4] {
		l.Emit(s)
	}
	ch, cancel := l.Subscribe(2)
	defer cancel()
	l.Emit(StageNeedsAttention)
	got := drain(t, ch)
	if want := []Stage{StageReading, StageReviewingFields, StageNeedsAttention}; !slices.Equal(stagesOf(got), want) {
		t.Errorf("stages %v", stagesOf(got))
	}
	if got[0].Seq != 3 {
		t.Errorf("first seq %d", got[0].Seq)
	}
}

func TestSubscribeToAFinishedLogReplaysAndCloses(t *testing.T) {
	l := NewEventLog(fixed(t0))
	for _, s := range happyStages {
		l.Emit(s)
	}
	if got := drain(t, mustSub(l, -5)); len(got) != len(happyStages) {
		t.Errorf("replayed %d", len(got))
	}
	if got := drain(t, mustSub(l, len(happyStages))); len(got) != 0 {
		t.Errorf("replayed %v after the last seq", stagesOf(got))
	}
	if got := drain(t, mustSub(l, 99)); len(got) != 0 {
		t.Errorf("replayed %v past the last seq", stagesOf(got))
	}
}

func mustSub(l *EventLog, after int) <-chan Event {
	ch, cancel := l.Subscribe(after)
	_ = cancel
	return ch
}

func TestSubscribeCancelClosesTheChannelAndStopsDelivery(t *testing.T) {
	l := NewEventLog(fixed(t0))
	l.Emit(StageReceived)
	ch, cancel := l.Subscribe(0)
	cancel()
	cancel() // safe twice
	l.Emit(StageQuality)
	got := drain(t, ch)
	if !slices.Equal(stagesOf(got), []Stage{StageReceived}) {
		t.Errorf("stages %v", stagesOf(got))
	}
	if n := l.subscribers(); n != 0 {
		t.Errorf("%d subscribers left", n)
	}
	l.Emit(StageCompleted)
	cancel() // safe after the terminal event
}

func TestCloseDropsTheLogAndClosesEverySubscriberWithoutATerminalEvent(t *testing.T) {
	l := NewEventLog(fixed(t0))
	l.Emit(StageReceived)
	a, cancelA := l.Subscribe(0)
	b, cancelB := l.Subscribe(1)
	l.Close()
	l.Close() // safe twice
	if got := drain(t, a); !slices.Equal(stagesOf(got), []Stage{StageReceived}) {
		t.Errorf("a %v", stagesOf(got))
	}
	if got := drain(t, b); len(got) != 0 {
		t.Errorf("b %v", stagesOf(got))
	}
	cancelA()
	cancelB()
	if l.Emit(StageQuality) || l.Fail("x") {
		t.Error("emit after close accepted")
	}
	if !l.Done() || l.subscribers() != 0 {
		t.Errorf("done %v subscribers %d", l.Done(), l.subscribers())
	}
	if got := drain(t, mustSub(l, 0)); !slices.Equal(stagesOf(got), []Stage{StageReceived}) {
		t.Errorf("subscribe after close %v", stagesOf(got))
	}
}

// The publisher never blocks on a subscriber that does not read: every
// subscriber channel can hold every event an analysis can have.
func TestAnIdleSubscriberNeverBlocksThePublisher(t *testing.T) {
	l := NewEventLog(fixed(t0))
	ch, cancel := l.Subscribe(0)
	defer cancel()
	done := make(chan struct{})
	go func() {
		defer close(done)
		for _, s := range happyStages {
			l.Emit(s)
		}
	}()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("publisher blocked")
	}
	if got := drain(t, ch); len(got) != len(happyStages) {
		t.Errorf("got %d events", len(got))
	}
}

func TestEventLogIsSafeForConcurrentUse(t *testing.T) {
	l := NewEventLog(fixed(t0))
	var wg sync.WaitGroup
	for range 20 {
		wg.Go(func() {
			ch, cancel := l.Subscribe(0)
			got := drain(t, ch)
			cancel()
			for i, e := range got {
				if e.Seq != i+1 {
					t.Errorf("seq %d at %d", e.Seq, i)
				}
			}
		})
	}
	wg.Go(func() {
		for _, s := range happyStages {
			l.Emit(s)
			_ = l.Events()
		}
	})
	wg.Wait()
}
