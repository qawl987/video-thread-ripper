export const DEFAULTS = Object.freeze({
  enabled: true,
  threads: 4,
  maxCdns: 3,
  probeBytes: 16 * 1024,
  requestBytes: 1024 * 1024,
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
  const nextNumber = originalNumber >= 4 ? 1 : originalNumber + 1;
  const previousNumber = originalNumber <= 1 ? 4 : originalNumber - 1;
  const order = [originalNumber, nextNumber, previousNumber, 1, 2, 3, 4]
    .filter((value, index, values) => values.indexOf(value) === index);
  return order.slice(0, Math.max(1, limit)).map((number) => {
    const candidate = new URL(parsed);
    candidate.hostname = `${match.groups.region}-cdn${String(number).padStart(2, "0")}-prem.boomio-cdn.com`;
    return candidate.href;
  });
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
