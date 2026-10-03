package main

import (
	"sync"
	"unicode/utf8"
)

// ── Bounded auth-event queue ──────────────────────────────────────────────────
//
// The LogWatcher buffer is drained into this queue as soon as it signals new
// events (pumpEvents in cmd_ws.go), whether or not the command channel is
// connected. The WS session takes batches of at most eventBatchMax events every
// cmdWSEventFlushInterval. The queue never holds more than its capacity: under
// a flood, or while the server is unreachable, the OLDEST events are dropped
// (the newest are the ones that can still lead to a ban) and counted; the count
// rides the next events frame as "dropped" (servers that ignore the field stay
// compatible).

const (
	// eventQueueCap bounds the events held in memory (about 10 MB worst case
	// with eventRawLogMax-byte raw lines).
	eventQueueCap = 10000
	// eventBatchMax is the maximum number of events per WS events frame.
	eventBatchMax = 500
	// eventRawLogMax bounds the raw log line kept with each event (bytes, cut
	// on a UTF-8 boundary): a 1 MB line must not pin 1 MB per queued event.
	eventRawLogMax = 1024
)

type eventQueue struct {
	mu       sync.Mutex
	capacity int
	// items[head:] are the queued events, oldest first. Popped and dropped
	// slots before head are zeroed and compacted away (amortized O(1)).
	items   []AgentIpEvent
	head    int
	dropped int
}

func newEventQueue(capacity int) *eventQueue {
	if capacity <= 0 {
		capacity = eventQueueCap
	}
	return &eventQueue{capacity: capacity}
}

// Len returns the number of queued events.
func (q *eventQueue) Len() int {
	q.mu.Lock()
	defer q.mu.Unlock()
	return len(q.items) - q.head
}

// Push appends events (newest last). When the queue is full the oldest events
// are dropped and counted.
func (q *eventQueue) Push(evts ...AgentIpEvent) {
	if len(evts) == 0 {
		return
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	for _, e := range evts {
		e.RawLog = truncateUTF8(e.RawLog, eventRawLogMax)
		q.items = append(q.items, e)
	}
	q.trimLocked()
}

// Requeue puts back, in front of the queue, a batch taken by PopBatch that
// could not be sent, together with the dropped count taken with it. The batch
// is older than everything queued since, so it is the first to go if the
// queue overflowed in the meantime.
func (q *eventQueue) Requeue(batch []AgentIpEvent, dropped int) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if dropped > 0 {
		q.dropped += dropped
	}
	if len(batch) == 0 {
		return
	}
	merged := make([]AgentIpEvent, 0, len(batch)+len(q.items)-q.head)
	merged = append(merged, batch...)
	merged = append(merged, q.items[q.head:]...)
	q.items = merged
	q.head = 0
	q.trimLocked()
}

// PopBatch removes and returns up to max of the oldest events (nil when empty).
func (q *eventQueue) PopBatch(max int) []AgentIpEvent {
	if max <= 0 {
		max = eventBatchMax
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	n := len(q.items) - q.head
	if n == 0 {
		return nil
	}
	if n > max {
		n = max
	}
	out := make([]AgentIpEvent, n)
	copy(out, q.items[q.head:q.head+n])
	q.advanceLocked(n)
	return out
}

// TakeDropped returns the number of events dropped since the last call and
// resets the counter.
func (q *eventQueue) TakeDropped() int {
	q.mu.Lock()
	defer q.mu.Unlock()
	d := q.dropped
	q.dropped = 0
	return d
}

// trimLocked drops the oldest events beyond the capacity. Called with q.mu held.
func (q *eventQueue) trimLocked() {
	if over := len(q.items) - q.head - q.capacity; over > 0 {
		q.dropped += over
		q.advanceLocked(over)
	}
}

// advanceLocked releases the n oldest events and compacts the backing slice
// once the released prefix outweighs the live part. Called with q.mu held.
func (q *eventQueue) advanceLocked(n int) {
	for i := q.head; i < q.head+n; i++ {
		q.items[i] = AgentIpEvent{} // release the strings for the GC
	}
	q.head += n
	live := len(q.items) - q.head
	switch {
	case live == 0:
		q.items = q.items[:0]
		q.head = 0
	case q.head > live && q.head > 64:
		total := len(q.items)
		copy(q.items, q.items[q.head:])
		clear(q.items[live:total]) // stale copies of the moved events
		q.items = q.items[:live]
		q.head = 0
	}
}

// truncateUTF8 cuts s to at most max bytes without splitting a rune.
func truncateUTF8(s string, max int) string {
	if len(s) <= max {
		return s
	}
	cut := max
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut]
}
