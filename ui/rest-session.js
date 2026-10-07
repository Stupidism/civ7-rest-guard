import { RestGate, scheduleAt, nextRestTurn, STAGE_LENGTH } from './rest-model.js';

export const IDLE_HINT_MS = 60000;
export const IDLE_REST_MS = 300000;

// One live session, shared across UI navigation. No saved-game or turn history.
export class RestSession {
  constructor(saved = null) {
    this.gate = new RestGate();
    this.startedAt = null;
    this.lastInputAt = null;
    this.idleRested = false;
    this.loading = false;
    this.anchor = null;
    this.anchorOnNext = false;
    if (saved?.version === 1) {
      for (const key of ['startedAt', 'lastInputAt']) {
        if (Number.isFinite(saved[key]) && saved[key] >= 0) this[key] = saved[key];
      }
      for (const key of ['idleRested', 'loading', 'anchorOnNext']) this[key] = saved[key] === true;
      if (typeof saved.anchor?.context === 'string' && Number.isInteger(saved.anchor.turn) && saved.anchor.turn >= 0) {
        this.anchor = { context: saved.anchor.context, turn: saved.anchor.turn };
      }
      if (typeof saved.paidToken === 'string') this.gate.state.paidToken = saved.paidToken;
      const p = saved.pending;
      if (p && typeof p.token === 'string' && Number.isInteger(p.turn) && p.turn >= 0 &&
          ['time', 'turn'].includes(p.reason) && Number.isFinite(p.deadline) &&
          Number.isFinite(p.durationMs) && p.durationMs > 0 && p.durationMs <= 7200000) {
        this.gate.state.pending = { token: p.token, turn: p.turn, reason: p.reason,
          durationMs: p.durationMs, deadline: p.deadline };
      }
    }
  }

  get pending() { return this.gate.state.pending; }

  export() {
    return { version: 1, startedAt: this.startedAt, lastInputAt: this.lastInputAt,
      idleRested: this.idleRested, loading: this.loading, anchor: this.anchor,
      anchorOnNext: this.anchorOnNext, ...this.gate.state };
  }

  start(now) {
    if (this.startedAt === null) {
      this.startedAt = now;
      this.lastInputAt = now;
    }
    this.startedAt = Math.min(this.startedAt, now);
    this.lastInputAt = Math.min(this.lastInputAt ?? now, now);
  }

  beginLoading(now) {
    this.start(now);
    if (this.idleRested) this.startedAt = now;
    this.idleRested = false;
    this.loading = true;
    this.lastInputAt = now;
  }

  finishLoading(now) {
    if (this.loading) {
      // Time spent loading counts as play time, never as five idle minutes.
      this.lastInputAt = now;
      this.loading = false;
    }
  }

  syncTurn(current) {
    if (!current) return;
    if (this.anchorOnNext) {
      this.anchor = { context: current.context, turn: current.turn };
      this.gate.state.paidToken = current.token;
      this.anchorOnNext = false;
    }
    if (this.anchor && (this.anchor.context !== current.context || current.turn < this.anchor.turn)) {
      this.anchor = null;
      this.gate.state.paidToken = null;
    }
  }

  reset(current, now, idle = false) {
    this.startedAt = now;
    this.idleRested = idle;
    this.anchor = current ? { context: current.context, turn: current.turn } : null;
    this.anchorOnNext = !current;
    this.gate.state.paidToken = current?.token ?? null;
    if (!idle) this.lastInputAt = now;
  }

  elapsed(now) { return this.startedAt === null || this.idleRested ? 0 : Math.max(0, now - this.startedAt); }
  idle(now) { return this.lastInputAt === null || this.loading ? 0 : Math.max(0, now - this.lastInputAt); }

  tick(current, config, now) {
    if (current) this.start(now);
    this.syncTurn(current);
    if (this.pending) {
      // A full idle break also satisfies the shared break, including idle time
      // immediately before the forced overlay appeared.
      if (config.timeEnabled && this.idle(now) >= IDLE_REST_MS) {
        this.pending.deadline = Math.min(this.pending.deadline, now);
      }
      return;
    }
    if (config.timeEnabled && !this.loading && this.startedAt !== null &&
        !this.idleRested && this.idle(now) >= IDLE_REST_MS) {
      this.reset(current, now, true);
    }
    if (current && config.timeEnabled && !this.loading && !this.idleRested &&
        this.elapsed(now) >= config.playMinutes * 60000) {
      this.gate.begin(current.token, current.turn, 'time', config, now);
    }
  }

  activity(current, config, now) {
    // Credit a completed idle break before replacing its last-input timestamp.
    this.tick(current, config, now);
    if (this.idleRested) { this.startedAt = now; this.idleRested = false; }
    this.lastInputAt = now;
  }

  targetTurn(current, config) {
    this.syncTurn(current);
    if (!this.anchor) return nextRestTurn(current.turn, config);
    let t = Math.max(current.turn, this.anchor.turn + 1, 1);
    for (let i = 0; i < 5; i++) {
      const rule = scheduleAt(t, config);
      const target = Math.max(t, Math.max(this.anchor.turn, rule.start) + rule.interval);
      const end = (rule.stage + 1) * STAGE_LENGTH;
      if (rule.stage === 4 || target <= end) return target;
      t = end + 1;
    }
    return t;
  }

  requestTurn(current, config, now) {
    this.tick(current, config, now);
    if (this.pending) return false;
    if (!config.turnEnabled || this.gate.state.paidToken === current.token) return true;
    const due = this.anchor ? this.targetTurn(current, config) <= current.turn : scheduleAt(current.turn, config).due;
    if (!due) return true;
    this.gate.begin(current.token, current.turn, 'turn', config, now);
    return false;
  }

  remaining(now) { return this.gate.remaining(now); }

  complete(current, now) {
    if (!this.gate.complete(now)) return false;
    this.reset(current, now);
    return true;
  }
}
