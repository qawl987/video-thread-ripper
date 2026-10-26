export const DEFAULTS = Object.freeze({
  enabled: true,
  threads: 4,
  maxCdns: 3,
  probeBytes: 16 * 1024,
  requestBytes: 1024 * 1024,
  minAdaptivePieceBytes: 256 * 1024,
  maxBatchBytes: 4 * 1024 * 1024,
  bufferAheadSeconds: 30,
  resumeAheadSeconds: 10,
});

export function clampInteger(value, minimum, maximum, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(number)));
}

export function parseHeaders(raw = "") {
  const headers = new Map();
  for (const line of raw.split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator < 1) continue;
    headers.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim());
  }
  return headers;
}

export function parseContentRange(value) {
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(value?.trim() ?? "");
  if (!match || match[3] === "*") return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
      !Number.isSafeInteger(total) || start > end || end >= total) return null;
  return { start, end, total };
}

export function splitRange(start, endInclusive, desiredPieces, pieceBytes = DEFAULTS.requestBytes) {
  if (endInclusive < start) return [];
  const length = endInclusive - start + 1;
  const pieces = Math.max(1, Math.min(desiredPieces, Math.ceil(length / pieceBytes)));
  const base = Math.floor(length / pieces);
  const extra = length % pieces;
  const result = [];
  let cursor = start;
  for (let index = 0; index < pieces; index += 1) {
    const size = base + (index < extra ? 1 : 0);
    result.push({ start: cursor, end: cursor + size - 1, index });
    cursor += size;
  }
  return result;
}

export function joinBuffers(buffers) {
  const length = buffers.reduce((sum, buffer) => sum + buffer.byteLength, 0);
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const buffer of buffers) {
    joined.set(new Uint8Array(buffer), offset);
    offset += buffer.byteLength;
  }
  return joined.buffer;
}

export function makeCdnCandidates(url, limit = DEFAULTS.maxCdns) {
  const parsed = new URL(url);
  const match = /^(?<region>[a-z]+)-cdn(?<number>\d{2})-prem\.boomio-cdn\.com$/i.exec(parsed.hostname);
  if (!match) return [url];
  const originalNumber = Number(match.groups.number);
  const order = [originalNumber, originalNumber + 1, originalNumber - 1]
    .filter((number) => number >= 1 && number <= 99)
    .filter((value, index, values) => values.indexOf(value) === index);
  return order.slice(0, Math.max(1, limit)).map((number) => {
    const candidate = new URL(parsed);
    candidate.hostname = `${match.groups.region}-cdn${String(number).padStart(2, "0")}-prem.boomio-cdn.com`;
    return candidate.href;
  });
}

export function splitRangeWeighted(start, endInclusive, weights, minimumBytes = DEFAULTS.minAdaptivePieceBytes) {
  if (endInclusive < start || !weights.length) return [];
  const length = endInclusive - start + 1;
  const count = weights.length;
  const normalized = weights.map((value) => Math.max(0.000001, Number(value) || 0));
  let sizes = new Array(count).fill(0);

  if (length < minimumBytes * count) {
    sizes = splitRange(start, endInclusive, count, 1).map((piece) => piece.end - piece.start + 1);
  } else {
    let remaining = length;
    let active = normalized.map((_value, index) => index);
    while (active.length) {
      const totalWeight = active.reduce((sum, index) => sum + normalized[index], 0);
      const belowMinimum = active.filter((index) => remaining * normalized[index] / totalWeight < minimumBytes);
      if (!belowMinimum.length) {
        let assigned = 0;
        for (const index of active) {
          sizes[index] = Math.floor(remaining * normalized[index] / totalWeight);
          assigned += sizes[index];
        }
        let remainder = remaining - assigned;
        for (const index of active) {
          if (!remainder) break;
          sizes[index] += 1;
          remainder -= 1;
        }
        break;
      }
      for (const index of belowMinimum) {
        sizes[index] = minimumBytes;
        remaining -= minimumBytes;
      }
      active = active.filter((index) => !belowMinimum.includes(index));
    }
  }

  const pieces = [];
  let cursor = start;
  for (let index = 0; index < sizes.length; index += 1) {
    const end = index === sizes.length - 1 ? endInclusive : cursor + sizes[index] - 1;
    pieces.push({ start: cursor, end, index });
    cursor = end + 1;
  }
  return pieces;
}

export class AdaptiveCdnPool {
  constructor(options = {}) {
    this.alphaDown = Number(options.alphaDown) || 0.7;
    this.alphaUp = Number(options.alphaUp) || 0.2;
    this.alphaTtfb = Number(options.alphaTtfb) || 0.35;
    this.measurementTtlMs = Number(options.measurementTtlMs) || 90_000;
    this.exploreEveryBatches = Number(options.exploreEveryBatches) || 4;
    this.slowRatio = Number(options.slowRatio) || 0.75;
    this.minimumSampleBytes = Number(options.minimumSampleBytes) || DEFAULTS.minAdaptivePieceBytes;
    this.states = new Map();
    this.batchNumber = 0;
  }

  setUrls(urls) {
    const unique = urls.filter((url, index, all) => all.indexOf(url) === index);
    const next = new Map();
    for (const url of unique) {
      next.set(url, this.states.get(url) ?? {
        url,
        host: new URL(url).hostname,
        ewmaBps: 0,
        lastBps: 0,
        ewmaTtfbMs: 0,
        samples: 0,
        failures: 0,
        blockedUntil: 0,
        lastMeasuredAt: 0,
        lastAssignedBatch: 0,
        cacheHits: 0,
        cacheMisses: 0,
        credit: 0,
      });
    }
    this.states = next;
  }

  urls() {
    return [...this.states.keys()];
  }

  state(url) {
    return this.states.get(url) ?? null;
  }

  isFresh(state, now) {
    return state.samples > 0 && now - state.lastMeasuredAt < this.measurementTtlMs;
  }

  score(state, now) {
    if (!this.isFresh(state, now)) return 0;
    return Math.min(state.ewmaBps, state.lastBps || state.ewmaBps);
  }

  recordSuccess(url, sample, now = Date.now()) {
    const state = this.state(url);
    if (!state) return null;
    const elapsedMs = Math.max(1, Number(sample.elapsedMs) || 0);
    const bytes = Math.max(0, Number(sample.bytes) || 0);
    const ttfbMs = Math.max(0, Number(sample.ttfbMs) || 0);
    const stale = state.lastMeasuredAt && now - state.lastMeasuredAt >= this.measurementTtlMs;
    state.failures = 0;
    state.blockedUntil = 0;
    state.ewmaTtfbMs = state.ewmaTtfbMs
      ? state.ewmaTtfbMs * (1 - this.alphaTtfb) + ttfbMs * this.alphaTtfb
      : ttfbMs;
    if (bytes >= this.minimumSampleBytes) {
      const bps = bytes * 1_000 / elapsedMs;
      const alpha = state.ewmaBps && bps < state.ewmaBps ? this.alphaDown : this.alphaUp;
      state.ewmaBps = !state.ewmaBps || stale
        ? bps
        : state.ewmaBps * (1 - alpha) + bps * alpha;
      state.lastBps = bps;
      state.samples += 1;
      state.lastMeasuredAt = now;
    }
    const cache = String(sample.cache || "").toUpperCase();
    if (cache === "HIT") state.cacheHits += 1;
    else if (cache === "MISS") state.cacheMisses += 1;
    return this.snapshot(url, now);
  }

  recordFailure(url, error, now = Date.now()) {
    if (error?.name === "AbortError") return;
    const state = this.state(url);
    if (!state) return;
    state.failures += 1;
    state.blockedUntil = now + Math.min(60_000, 3_000 * (2 ** Math.min(state.failures - 1, 4)));
  }

  eligible(now = Date.now()) {
    const all = [...this.states.values()];
    const open = all.filter((state) => state.blockedUntil <= now);
    return open.length ? open : all;
  }

  retryOrder(preferredUrl, now = Date.now()) {
    const candidates = this.eligible(now).slice().sort((left, right) => {
      if (left.url === preferredUrl) return -1;
      if (right.url === preferredUrl) return 1;
      return Number(this.isFresh(right, now)) - Number(this.isFresh(left, now)) || this.score(right, now) - this.score(left, now);
    });
    return candidates.map((state) => state.url);
  }

  pickWeighted(states, now) {
    const fresh = states.filter((state) => this.isFresh(state, now));
    if (!fresh.length) return states[0];
    const top = Math.max(...fresh.map((state) => this.score(state, now)));
    const eligible = fresh.filter((state) => this.score(state, now) >= top * this.slowRatio);
    const pool = eligible.length ? eligible : fresh;
    const total = pool.reduce((sum, state) => sum + this.score(state, now), 0);
    let selected = pool[0];
    for (const state of pool) {
      state.credit += this.score(state, now);
      if (state.credit > selected.credit) selected = state;
    }
    selected.credit -= total;
    return selected;
  }

  plan(count, now = Date.now(), options = {}) {
    this.batchNumber += 1;
    const available = this.eligible(now);
    if (!available.length || count <= 0) return [];
    const selected = [];
    if (options.urgent) {
      const measured = available.filter((state) => this.isFresh(state, now));
      if (measured.length) {
        const fastest = measured.reduce((best, state) => this.score(state, now) > this.score(best, now) ? state : best);
        fastest.lastAssignedBatch = this.batchNumber;
        return Array.from({ length: count }, () => ({
          url: fastest.url,
          host: fastest.host,
          reason: "urgent",
          weight: this.score(fastest, now),
        }));
      }
    }
    const unused = available.filter((state) => state.samples === 0)
      .sort((left, right) => left.lastAssignedBatch - right.lastAssignedBatch);
    while (selected.length < count && unused.length) {
      selected.push({ state: unused.shift(), reason: "warmup" });
    }

    if (selected.length < count && !selected.length) {
      const retest = available
        .filter((state) => !this.isFresh(state, now) || this.batchNumber - state.lastAssignedBatch >= this.exploreEveryBatches)
        .sort((left, right) => left.lastMeasuredAt - right.lastMeasuredAt)[0];
      if (retest) selected.push({ state: retest, reason: "retest" });
    }

    while (selected.length < count) {
      const state = this.pickWeighted(available, now);
      selected.push({ state, reason: "weighted" });
    }

    const freshSpeeds = available.filter((state) => this.isFresh(state, now)).map((state) => this.score(state, now));
    const fallbackSpeed = freshSpeeds.length ? Math.max(...freshSpeeds) : 1;
    return selected.map(({ state, reason }) => {
      state.lastAssignedBatch = this.batchNumber;
      const fresh = this.isFresh(state, now);
      return {
        url: state.url,
        host: state.host,
        reason,
        weight: fresh ? this.score(state, now) : reason === "retest" ? fallbackSpeed * 0.01 : fallbackSpeed * 0.25,
      };
    });
  }

  snapshot(url, now = Date.now()) {
    const state = this.state(url);
    if (!state) return null;
    return {
      host: state.host,
      ewmaBps: this.isFresh(state, now) ? state.ewmaBps : 0,
      lastBps: state.lastBps,
      scoreBps: this.score(state, now),
      ewmaTtfbMs: state.ewmaTtfbMs,
      samples: state.samples,
      failures: state.failures,
      blockedUntil: state.blockedUntil,
      cacheHits: state.cacheHits,
      cacheMisses: state.cacheMisses,
    };
  }

  status(now = Date.now()) {
    return [...this.states.keys()].map((url) => this.snapshot(url, now));
  }
}

export function bufferedAhead(video) {
  const time = video.currentTime;
  for (let index = 0; index < video.buffered.length; index += 1) {
    if (video.buffered.start(index) <= time + 0.05 && video.buffered.end(index) >= time) {
      return video.buffered.end(index) - time;
    }
  }
  return 0;
}

export function isTimeBuffered(video, time, margin = 0.25) {
  for (let index = 0; index < video.buffered.length; index += 1) {
    if (video.buffered.start(index) <= time + margin && video.buffered.end(index) >= time - margin) return true;
  }
  return false;
}

export function commonSegmentSampleCount(tracks, targetSeconds = 2) {
  const timingTrack = tracks.find((track) => track.video) ?? tracks[0];
  if (!timingTrack) return 1;
  const durationSeconds = timingTrack.duration / timingTrack.timescale;
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 1;
  return Math.max(1, Math.round(timingTrack.nb_samples / durationSeconds * targetSeconds));
}

export function mediaDurationSeconds(info) {
  const duration = Number(info?.duration);
  const timescale = Number(info?.timescale);
  if (!Number.isFinite(duration) || !Number.isFinite(timescale) || duration <= 0 || timescale <= 0) return null;
  return duration / timescale;
}

export function maxConcurrentIntervals(intervals) {
  const events = [];
  for (const interval of intervals) {
    if (!Number.isFinite(interval?.start) || !Number.isFinite(interval?.end) || interval.end < interval.start) continue;
    events.push({ time: interval.start, delta: 1 });
    events.push({ time: interval.end, delta: -1 });
  }
  events.sort((left, right) => left.time - right.time || left.delta - right.delta);
  let active = 0;
  let maximum = 0;
  for (const event of events) {
    active += event.delta;
    maximum = Math.max(maximum, active);
  }
  return maximum;
}
