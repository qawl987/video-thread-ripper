import test from "node:test";
import assert from "node:assert/strict";
import {
  clampInteger,
  commonSegmentSampleCount,
  joinBuffers,
  makeCdnCandidates,
  maxConcurrentIntervals,
  mediaDurationSeconds,
  parseContentRange,
  parseHeaders,
  splitRange,
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
