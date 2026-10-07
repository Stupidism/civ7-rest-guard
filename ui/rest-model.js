import { DEFAULTS } from './defaults.js';

export const STAGE_LENGTH = 20;

function numberInRange(value, fallback, min, max, integer = false) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const result = Math.max(min, Math.min(max, value));
  return integer ? Math.round(result) : Math.round(result * 10) / 10;
}

export function normalizeConfig(value = {}) {
  if (!value || typeof value !== 'object') value = {};
  return {
    turnEnabled: typeof value.turnEnabled === 'boolean' ? value.turnEnabled : DEFAULTS.turnEnabled,
    timeEnabled: typeof value.timeEnabled === 'boolean' ? value.timeEnabled : DEFAULTS.timeEnabled,
    playMinutes: numberInRange(value.playMinutes, DEFAULTS.playMinutes, 1, 240),
    restMinutes: numberInRange(value.restMinutes, DEFAULTS.restMinutes, 0.1, 120),
    intervals: DEFAULTS.intervals.map((fallback, i) =>
      numberInRange(value.intervals?.[i], fallback, 1, 100, true)),
  };
}

// Game.turn is the displayed turn being ended. Zero is the starting baseline,
// not a completed turn: end turns 1..20 use stage 0, 21..40 use stage 1, etc.
// Each finite stage starts a fresh cadence; the final stage continues after 80.
export function scheduleAt(turn, config) {
  const t = Math.max(0, Math.floor(Number(turn) || 0));
  const stage = Math.min(4, Math.floor(Math.max(0, t - 1) / STAGE_LENGTH));
  const start = stage * STAGE_LENGTH;
  const interval = config.intervals[stage];
  const position = t - start;
  return { turn: t, stage, start, interval, due: position > 0 && position % interval === 0 };
}

export function nextRestTurn(turn, config) {
  let t = Math.max(1, Math.floor(Number(turn) || 0));
  // At most four finite stage boundaries, then one final-stage interval.
  for (let i = 0; i < 5; i++) {
    const rule = scheduleAt(t, config);
    const candidate = t + (rule.interval - (t - rule.start) % rule.interval) % rule.interval;
    const end = (rule.stage + 1) * STAGE_LENGTH;
    if (rule.stage === 4 || candidate <= end) return candidate;
    t = end + 1;
  }
  return t;
}

export class RestGate {
  constructor() {
    // Current in-memory lock only; never count turns or persist runtime state.
    this.state = { paidToken: null, pending: null };
  }

  attempt(token, turn, config, now) {
    // An existing rest must finish even if config or the current turn changes.
    if (this.state.pending) return false;
    if (this.state.paidToken === token || !scheduleAt(turn, config).due) return true;
    this.begin(token, turn, 'turn', config, now);
    return false;
  }

  begin(token, turn, reason, config, now) {
    if (this.state.pending) return;
    this.state.pending = {
      token, turn, reason,
      durationMs: Math.round(config.restMinutes * 60000),
      deadline: now + Math.round(config.restMinutes * 60000),
    };
  }

  remaining(now) {
    const pending = this.state.pending;
    if (!pending) return 0;
    // Clock rollback must not turn a five-minute break into a multi-hour lock.
    if (pending.deadline > now + pending.durationMs) {
      pending.deadline = now + pending.durationMs;
    }
    return Math.max(0, pending.deadline - now);
  }

  complete(now) {
    if (!this.state.pending || this.remaining(now) > 0) return false;
    this.state.paidToken = this.state.pending.token;
    this.state.pending = null;
    return true;
  }
}

export function formatTime(milliseconds) {
  const seconds = Math.ceil(Math.max(0, milliseconds) / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
