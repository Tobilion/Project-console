/**
 * In-memory metrics store for monitoring the pipeline.
 * Exposes counters, histograms, and a recent-events ring buffer.
 */

const MAX_EVENTS = 200;

class MetricsStore {
  constructor() {
    this._counters = {};
    this._histograms = {};
    this._events = [];
  }

  /** Increment a named counter by 1 (or `by`). */
  inc(name, by = 1) {
    this._counters[name] = (this._counters[name] || 0) + by;
  }

  /** Record a timed observation (ms) for a named histogram. */
  observe(name, ms) {
    if (!this._histograms[name]) this._histograms[name] = [];
    this._histograms[name].push(ms);
    if (this._histograms[name].length > 1000) {
      this._histograms[name] = this._histograms[name].slice(-500);
    }
  }

  /** Push a structured event into the ring buffer. */
  event(e) {
    this._events.push({ ...e, ts: Date.now() });
    if (this._events.length > MAX_EVENTS) {
      this._events = this._events.slice(-MAX_EVENTS);
    }
  }

  /** Compute stats for a histogram (p50, p95, p99, count). */
  _histoStats(name) {
    const vals = this._histograms[name];
    if (!vals || vals.length === 0) return null;
    const sorted = [...vals].sort((a, b) => a - b);
    return {
      count: sorted.length,
      min: sorted[0],
      max: sorted[sorted.length - 1],
      avg: sorted.reduce((a, b) => a + b, 0) / sorted.length,
      p50: sorted[Math.floor(sorted.length * 0.5)],
      p95: sorted[Math.floor(sorted.length * 0.95)],
      p99: sorted[Math.floor(sorted.length * 0.99)],
    };
  }

  snapshot() {
    const histograms = {};
    for (const name of Object.keys(this._histograms)) {
      histograms[name] = this._histoStats(name);
    }
    return {
      counters: { ...this._counters },
      histograms,
      recentEvents: this._events.slice(-50),
    };
  }

  reset() {
    this._counters = {};
    this._histograms = {};
    this._events = [];
  }
}

export const metrics = new MetricsStore();
