import test from "node:test";
import assert from "node:assert/strict";
import {
  AdaptiveCdnPool,
  clampInteger,
  commonSegmentSampleCount,
  joinBuffers,
  makeCdnCandidates,
  maxConcurrentIntervals,
  mediaDurationSeconds,
  parseContentRange,
  parseHeaders,
  splitRange,
  splitRangeWeighted,
} from "../src/core.js";

test("parses case-insensitive response headers and a valid partial range", () => {
  const headers = parseHeaders("Content-Type: video/mp4\r\nContent-Range: bytes 10-19/100\r\n");
  assert.equal(headers.get("content-type"), "video/mp4");
  assert.deepEqual(parseContentRange(headers.get("content-range")), { start: 10, end: 19, total: 100 });
});

test("rejects malformed or impossible Content-Range values", () => {
  assert.equal(parseContentRange("bytes 20-10/100"), null);
  assert.equal(parseContentRange("bytes 0-100/100"), null);
  assert.equal(parseContentRange("items 0-1/2"), null);
});

test("splits and rejoins byte ranges without gaps", () => {
  assert.deepEqual(splitRange(10, 19, 3, 1), [
    { start: 10, end: 13, index: 0 },
    { start: 14, end: 16, index: 1 },
    { start: 17, end: 19, index: 2 },
  ]);
  assert.deepEqual([...new Uint8Array(joinBuffers([
    Uint8Array.from([1, 2]).buffer,
    Uint8Array.from([3]).buffer,
  ]))], [1, 2, 3]);
});

test("builds a bounded same-region Boomio candidate list", () => {
  const source = "https://eu-cdn03-prem.boomio-cdn.com/remote_control.php?file=x&acctoken=y";
  assert.deepEqual(makeCdnCandidates(source, 3).map((url) => new URL(url).hostname), [
    "eu-cdn03-prem.boomio-cdn.com",
    "eu-cdn04-prem.boomio-cdn.com",
    "eu-cdn02-prem.boomio-cdn.com",
  ]);
});

test("discovers adjacent CDN numbers without wrapping newer nodes back to cdn01", () => {
  const source = "https://eu-cdn11-prem.boomio-cdn.com/remote_control.php?file=x&acctoken=y";
  assert.deepEqual(makeCdnCandidates(source, 3).map((url) => new URL(url).hostname), [
    "eu-cdn11-prem.boomio-cdn.com",
    "eu-cdn12-prem.boomio-cdn.com",
    "eu-cdn10-prem.boomio-cdn.com",
  ]);
});

test("normalizes the user thread setting", () => {
  assert.equal(clampInteger("4", 1, 8, 3), 4);
  assert.equal(clampInteger(99, 1, 8, 3), 8);
  assert.equal(clampInteger("nope", 1, 8, 3), 3);
});

test("uses one video-derived sample count for combined A/V segmentation", () => {
  const tracks = [
    { id: 1, video: { width: 1280 }, duration: 10_000, timescale: 1_000, nb_samples: 300 },
    { id: 2, audio: { sample_rate: 48_000 }, duration: 10_000, timescale: 1_000, nb_samples: 469 },
  ];
  assert.equal(commonSegmentSampleCount(tracks, 2), 60);
});

test("converts MP4 movie duration from timescale units to seconds", () => {
  assert.equal(mediaDurationSeconds({ duration: 425_900, timescale: 1_000 }), 425.9);
  assert.equal(mediaDurationSeconds({ duration: 0, timescale: 1_000 }), null);
  assert.equal(mediaDurationSeconds({ duration: 10, timescale: 0 }), null);
});

test("calculates actual peak overlap between request intervals", () => {
  assert.equal(maxConcurrentIntervals([
    { start: 0, end: 100 },
    { start: 5, end: 80 },
    { start: 100, end: 120 },
  ]), 2);
  assert.equal(maxConcurrentIntervals([{ start: 0, end: 1 }]), 1);
  assert.equal(maxConcurrentIntervals([]), 0);
});

test("splits a batch by measured speed while bounding a slow trial", () => {
  const pieces = splitRangeWeighted(0, 2 * 1024 * 1024 - 1, [3.3, 0.28], 256 * 1024);
  assert.equal(pieces.length, 2);
  assert.equal(pieces[1].end - pieces[1].start + 1, 256 * 1024);
  assert.equal(pieces[0].end + 1, pieces[1].start);
  assert.equal(pieces[1].end, 2 * 1024 * 1024 - 1);
});

test("adaptive CDN pool favors the fast node and periodically retests the slow one", () => {
  const first = "https://eu-cdn10-prem.boomio-cdn.com/file.mp4?t=x";
  const second = "https://eu-cdn11-prem.boomio-cdn.com/file.mp4?t=x";
  const pool = new AdaptiveCdnPool({ exploreEveryBatches: 8, measurementTtlMs: 90_000 });
  pool.setUrls([first, second]);
  assert.deepEqual(pool.plan(2, 0).map((item) => item.reason), ["warmup", "warmup"]);
  pool.recordSuccess(first, { bytes: 1024 * 1024, elapsedMs: 300, ttfbMs: 220, cache: "HIT" }, 100);
  pool.recordSuccess(second, { bytes: 1024 * 1024, elapsedMs: 3500, ttfbMs: 240, cache: "HIT" }, 100);
  assert.deepEqual(pool.plan(2, 200).map((item) => item.url), [first, first]);
  for (let index = 0; index < 6; index += 1) pool.plan(2, 300 + index);
  const retest = pool.plan(2, 400);
  assert.equal(retest[0].url, second);
  assert.equal(retest[0].reason, "retest");
  assert.equal(retest[1].url, first);
});

test("adaptive CDN score reacts faster to slowdowns than recoveries", () => {
  const url = "https://eu-cdn05-prem.boomio-cdn.com/file.mp4?t=x";
  const pool = new AdaptiveCdnPool();
  pool.setUrls([url]);
  pool.recordSuccess(url, { bytes: 3 * 1024 * 1024, elapsedMs: 1_000, ttfbMs: 200 }, 1);
  const initial = pool.snapshot(url, 2).ewmaBps;
  pool.recordSuccess(url, { bytes: 1024 * 1024, elapsedMs: 1_000, ttfbMs: 200 }, 3);
  const afterSlowdown = pool.snapshot(url, 4).ewmaBps;
  const slowdownScore = pool.snapshot(url, 4).scoreBps;
  pool.recordSuccess(url, { bytes: 3 * 1024 * 1024, elapsedMs: 1_000, ttfbMs: 200 }, 5);
  const afterRecovery = pool.snapshot(url, 6).ewmaBps;
  assert.equal(Math.round(initial / 1024), 3072);
  assert.equal(Math.round(afterSlowdown / 1024), 1638);
  assert.equal(Math.round(slowdownScore / 1024), 1024);
  assert.equal(Math.round(afterRecovery / 1024), 1925);
});

test("urgent planning sends every slot to the currently fastest CDN", () => {
  const fast = "https://eu-cdn06-prem.boomio-cdn.com/file.mp4?t=x";
  const variable = "https://eu-cdn05-prem.boomio-cdn.com/file.mp4?t=x";
  const pool = new AdaptiveCdnPool();
  pool.setUrls([fast, variable]);
  pool.recordSuccess(fast, { bytes: 3 * 1024 * 1024, elapsedMs: 1_000, ttfbMs: 200 }, 1);
  pool.recordSuccess(variable, { bytes: 1024 * 1024, elapsedMs: 1_000, ttfbMs: 200 }, 1);
  const plan = pool.plan(2, 2, { urgent: true });
  assert.deepEqual(plan.map((item) => item.url), [fast, fast]);
  assert.deepEqual(plan.map((item) => item.reason), ["urgent", "urgent"]);
});
