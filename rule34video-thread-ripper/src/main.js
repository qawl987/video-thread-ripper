import { createFile } from "mp4box";
import {
  DEFAULTS,
  bufferedAhead,
  clampInteger,
  commonSegmentSampleCount,
  isTimeBuffered,
  joinBuffers,
  makeCdnCandidates,
  mediaDurationSeconds,
  parseContentRange,
  parseHeaders,
  splitRange,
} from "./core.js";

const PREFIX = "[R34 Thread Ripper]";
const log = (...values) => console.info(PREFIX, ...values);
const warn = (...values) => console.warn(PREFIX, ...values);
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

class HttpError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

class RangeClient {
  constructor(referrer) {
    this.referrer = referrer;
    this.urls = [];
    this.cursor = 0;
    this.active = new Set();
    this.cooldownUntil = 0;
    this.effectiveThreads = settings.threads;
    this.rateLimited = false;
  }

  abortAll() {
    for (const request of this.active) request.abort();
    this.active.clear();
  }

  request(url, start, end) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const request = GM_xmlhttpRequest({
        method: "GET",
        url,
        headers: {
          Range: `bytes=${start}-${end}`,
          Referer: this.referrer,
        },
        responseType: "arraybuffer",
        timeout: 20_000,
        onload: (response) => {
          settled = true;
          this.active.delete(request);
          const headers = parseHeaders(response.responseHeaders);
          const range = parseContentRange(headers.get("content-range"));
          if (response.status === 429) return reject(new HttpError("CDN rate limited the request", 429));
          if (response.status !== 206 || !range || range.start !== start || range.end !== end) {
            return reject(new HttpError(`Invalid range response (${response.status})`, response.status));
          }
          if (!(response.response instanceof ArrayBuffer) || response.response.byteLength !== end - start + 1) {
            return reject(new HttpError("Range body length did not match Content-Range", response.status));
          }
          resolve({
            buffer: response.response,
            range,
            finalUrl: response.finalUrl || url,
            headers,
          });
        },
        onerror: () => {
          settled = true;
          this.active.delete(request);
          reject(new HttpError("Network error"));
        },
        ontimeout: () => {
          settled = true;
          this.active.delete(request);
          reject(new HttpError("Request timed out"));
        },
        onabort: () => {
          settled = true;
          this.active.delete(request);
          reject(new DOMException("Request aborted", "AbortError"));
        },
      });
      if (!settled) this.active.add(request);
    });
  }

  async fetchPiece(piece, preferredIndex) {
    let lastError;
    const attempts = Math.min(3, Math.max(1, this.urls.length));
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const url = this.urls[(preferredIndex + attempt) % this.urls.length];
      try {
        return await this.request(url, piece.start, piece.end);
      } catch (error) {
        lastError = error;
        if (error?.name === "AbortError") throw error;
        if (error?.status === 429) {
          this.effectiveThreads = 1;
          this.cooldownUntil = Date.now() + 15_000;
          this.rateLimited = true;
          warn("收到 429，暫時降為單線程 15 秒");
          this.abortAll();
          throw error;
        }
      }
    }
    throw lastError;
  }

  async fetchBatch(start, end) {
    if (Date.now() >= this.cooldownUntil) this.effectiveThreads = settings.threads;
    const threads = Math.min(this.effectiveThreads, settings.threads);
    const pieces = splitRange(start, end, threads, DEFAULTS.requestBytes);
    const responses = await Promise.all(pieces.map((piece, index) =>
      this.fetchPiece(piece, this.cursor + index)));
    log(`Range 批次：${pieces.length} 線程`, pieces.map((piece, index) => ({
      bytes: `${piece.start}-${piece.end}`,
      cdn: new URL(responses[index].finalUrl).hostname,
    })));
    this.cursor = (this.cursor + pieces.length) % this.urls.length;
    return joinBuffers(responses.map((response) => response.buffer));
  }
}

class AppendQueue {
  constructor(sourceBuffer) {
    this.sourceBuffer = sourceBuffer;
    this.items = [];
    this.failed = null;
    this.waiters = [];
    sourceBuffer.addEventListener("updateend", () => this.pump());
    sourceBuffer.addEventListener("error", () => {
      this.failed = new Error("MediaSource SourceBuffer failed");
      this.settle();
    });
  }

  push(buffer) {
    this.items.push(buffer);
    this.pump();
  }

  clear() {
    this.items.length = 0;
  }

  pump() {
    if (this.failed || this.sourceBuffer.updating || this.items.length === 0) {
      this.settle();
      return;
    }
    try {
      this.sourceBuffer.appendBuffer(this.items.shift());
    } catch (error) {
      this.failed = error;
      this.settle();
    }
  }

  settle() {
    if ((this.items.length === 0 && !this.sourceBuffer.updating) || this.failed) {
      for (const waiter of this.waiters.splice(0)) {
        this.failed ? waiter.reject(this.failed) : waiter.resolve();
      }
    }
  }

  idle() {
    if (this.failed) return Promise.reject(this.failed);
    if (this.items.length === 0 && !this.sourceBuffer.updating) return Promise.resolve();
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }
}

async function sha256(buffer) {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function waitForEvent(target, name, timeout = 10_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${name}`));
    }, timeout);
    const cleanup = () => {
      clearTimeout(timer);
      target.removeEventListener(name, onEvent);
      target.removeEventListener("error", onError);
    };
    const onEvent = (event) => { cleanup(); resolve(event); };
    const onError = () => { cleanup(); reject(new Error(`Error while waiting for ${name}`)); };
    target.addEventListener(name, onEvent, { once: true });
    target.addEventListener("error", onError, { once: true });
  });
}

class PlaybackSession {
  constructor(video, originalUrl) {
    this.video = video;
    this.originalUrl = originalUrl;
    this.originalTime = video.currentTime || 0;
    this.wasPaused = video.paused;
    this.client = new RangeClient(location.href);
    this.mediaSource = new MediaSource();
    this.objectUrl = URL.createObjectURL(this.mediaSource);
    this.mp4 = createFile();
    this.totalBytes = 0;
    this.nextOffset = 0;
    this.contiguousEnd = 0;
    this.stopped = false;
    this.ready = false;
    this.readyError = null;
    this.durationSeconds = null;
    this.seekRequest = null;
    this.appendQueue = null;
    this.onSeeking = () => {
      if (!this.ready || isTimeBuffered(this.video, this.video.currentTime)) return;
      this.seekRequest = this.video.currentTime;
      this.client.abortAll();
    };
  }

  async discoverCdns() {
    const initialEnd = 64 * 1024 - 1;
    const primary = await this.client.request(this.originalUrl, 0, initialEnd);
    this.totalBytes = primary.range.total;
    const directUrl = primary.finalUrl;
    const referenceHash = await sha256(primary.buffer.slice(0, DEFAULTS.probeBytes));
    const valid = [directUrl];
    for (const candidate of makeCdnCandidates(directUrl, DEFAULTS.maxCdns)) {
      if (valid.length >= DEFAULTS.maxCdns) break;
      if (new URL(candidate).hostname === new URL(directUrl).hostname) continue;
      try {
        const probe = await this.client.request(candidate, 0, DEFAULTS.probeBytes - 1);
        if (probe.range.total !== this.totalBytes) continue;
        if (await sha256(probe.buffer) !== referenceHash) continue;
        valid.push(candidate);
      } catch (error) {
        warn("略過無法驗證的 CDN", new URL(candidate).hostname, error.message);
      }
    }
    this.client.urls = valid;
    log("已驗證 CDN", valid.map((url) => new URL(url).hostname));
    return primary.buffer;
  }

  setupMp4() {
    let resolveReady;
    let rejectReady;
    const readyPromise = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    this.mp4.onError = (error) => {
      this.readyError = new Error(`MP4Box: ${error}`);
      rejectReady(this.readyError);
    };
    this.mp4.onReady = (info) => {
      try {
        const tracks = info.tracks.filter((track) => track.video || track.audio);
        const codecs = tracks.map((track) => track.codec).filter(Boolean).join(",");
        const mime = `video/mp4; codecs="${codecs}"`;
        if (!tracks.length || !MediaSource.isTypeSupported(mime)) {
          throw new Error(`Unsupported MediaSource type: ${mime}`);
        }
        const sourceBuffer = this.mediaSource.addSourceBuffer(mime);
        this.appendQueue = new AppendQueue(sourceBuffer);
        this.durationSeconds = mediaDurationSeconds(info);
        if (!this.durationSeconds) throw new Error("MP4 metadata did not contain a finite duration");
        this.mediaSource.duration = this.durationSeconds;
        // MP4Box combined mode requires one shared nbSamples value for every
        // fragmented track. Base it on the video cadence so video fragments
        // stay close to two seconds; audio fragments may be shorter.
        const samplesPerSegment = commonSegmentSampleCount(tracks, 2);
        for (const track of tracks) {
          this.mp4.setSegmentOptions(track.id, sourceBuffer, {
            nbSamples: samplesPerSegment,
            rapAlignement: true,
          });
        }
        this.mp4.onSegment = (id, _user, buffer, sampleNumber) => {
          this.appendQueue.push(buffer);
          this.mp4.releaseUsedSamples(id, sampleNumber);
        };
        const init = this.mp4.initializeSegmentation("combined");
        this.appendQueue.push(init.buffer);
        this.mp4.start();
        this.ready = true;
        resolveReady(info);
      } catch (error) {
        this.readyError = error;
        rejectReady(error);
      }
    };
    return readyPromise;
  }

  appendToMp4(buffer, offset) {
    buffer.fileStart = offset;
    const suggestedOffset = this.mp4.appendBuffer(buffer);
    if (offset === this.contiguousEnd) this.contiguousEnd += buffer.byteLength;
    return suggestedOffset;
  }

  async waitForRoom() {
    while (!this.stopped && bufferedAhead(this.video) >= DEFAULTS.bufferAheadSeconds) {
      await new Promise((resolve) => {
        const wake = () => { cleanup(); resolve(); };
        const timer = setTimeout(wake, 1_000);
        const cleanup = () => {
          clearTimeout(timer);
          this.video.removeEventListener("timeupdate", wake);
          this.video.removeEventListener("seeking", wake);
        };
        this.video.addEventListener("timeupdate", wake, { once: true });
        this.video.addEventListener("seeking", wake, { once: true });
      });
    }
  }

  async handleSeek() {
    if (this.seekRequest === null) return false;
    const requestedTime = this.seekRequest;
    this.seekRequest = null;
    this.appendQueue?.clear();
    const seek = this.mp4.seek(requestedTime, true);
    this.nextOffset = seek.offset;
    log(`跳轉到 ${requestedTime.toFixed(1)} 秒，從 byte ${this.nextOffset} 續傳`);
    return true;
  }

  async pump() {
    while (!this.stopped && this.nextOffset < this.totalBytes) {
      await this.handleSeek();
      await this.waitForRoom();
      if (this.stopped) break;
      const batchBytes = Math.min(
        DEFAULTS.maxBatchBytes,
        Math.max(DEFAULTS.requestBytes, this.client.effectiveThreads * DEFAULTS.requestBytes),
      );
      const end = Math.min(this.totalBytes - 1, this.nextOffset + batchBytes - 1);
      const offset = this.nextOffset;
      try {
        const buffer = await this.client.fetchBatch(offset, end);
        if (this.seekRequest !== null) continue;
        this.appendToMp4(buffer, offset);
        this.nextOffset = end + 1;
      } catch (error) {
        if (error?.name === "AbortError" && this.seekRequest !== null) continue;
        if (this.client.rateLimited) {
          this.client.rateLimited = false;
          await sleep(2_000);
          continue;
        }
        throw error;
      }
    }
    if (!this.stopped && this.nextOffset >= this.totalBytes) {
      this.mp4.flush();
      await this.appendQueue.idle();
      if (this.mediaSource.readyState === "open") this.mediaSource.endOfStream();
    }
  }

  async start() {
    const firstBuffer = await this.discoverCdns();
    if (this.stopped) return;
    const readyPromise = this.setupMp4();
    this.video.pause();
    this.video.src = this.objectUrl;
    this.video.load();
    if (this.mediaSource.readyState !== "open") await waitForEvent(this.mediaSource, "sourceopen");

    let suggested = this.appendToMp4(firstBuffer, 0);
    while (!this.ready) {
      if (this.readyError) throw this.readyError;
      const offset = Number.isSafeInteger(suggested) ? suggested : this.contiguousEnd;
      const end = Math.min(this.totalBytes - 1, offset + 512 * 1024 - 1);
      if (end < offset) throw new Error("Could not find MP4 metadata");
      const buffer = await this.client.fetchBatch(offset, end);
      suggested = this.appendToMp4(buffer, offset);
    }
    await readyPromise;
    const seek = this.mp4.seek(this.originalTime, true);
    this.nextOffset = Math.max(seek.offset, this.contiguousEnd);
    this.video.addEventListener("seeking", this.onSeeking);
    await this.appendQueue.idle();
    this.video.currentTime = Math.min(this.originalTime, this.durationSeconds);
    if (!this.wasPaused) this.video.play().catch(() => {});
    log(`接管完成：${settings.threads} 線程、${this.client.urls.length} 個 CDN`);
    await this.pump();
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.client.abortAll();
    this.video.removeEventListener("seeking", this.onSeeking);
    this.mp4.stop();
  }

  async fallback(error) {
    warn("加速失敗，已回退原站播放器", error);
    const time = this.video.currentTime || this.originalTime;
    const shouldPlay = !this.video.paused || !this.wasPaused;
    this.stop();
    try {
      this.video.src = this.originalUrl;
      this.video.load();
      await waitForEvent(this.video, "loadedmetadata");
      this.video.currentTime = Math.min(time, this.video.duration || time);
      if (shouldPlay) await this.video.play().catch(() => {});
    } finally {
      URL.revokeObjectURL(this.objectUrl);
    }
  }
}

const settings = {
  enabled: GM_getValue("enabled", DEFAULTS.enabled),
  threads: clampInteger(GM_getValue("threads", DEFAULTS.threads), 1, 8, DEFAULTS.threads),
};

GM_registerMenuCommand(`加速：${settings.enabled ? "已開啟" : "已關閉"}（點擊切換）`, () => {
  GM_setValue("enabled", !settings.enabled);
  location.reload();
});
GM_registerMenuCommand(`線程數：${settings.threads}（1–8）`, () => {
  const value = prompt("Rule34Video Thread Ripper 線程數（1–8）\n建議 3–4；過高可能觸發 CDN 限流。", String(settings.threads));
  if (value === null) return;
  const parsed = clampInteger(value, 1, 8, NaN);
  if (!Number.isFinite(parsed)) return alert("請輸入 1 到 8 的整數。");
  GM_setValue("threads", parsed);
  location.reload();
});

let activeSession = null;
let attemptedUrl = null;

function findVideo() {
  return [...document.querySelectorAll("video")]
    .filter((video) => video.currentSrc && !video.currentSrc.startsWith("blob:"))
    .sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0] ?? null;
}

async function maybeStart() {
  if (!settings.enabled || activeSession) return;
  const video = findVideo();
  if (!video) return;
  const source = video.currentSrc;
  if (source === attemptedUrl || !/^https:\/\/rule34video\.com\/get_file\//i.test(source)) return;
  attemptedUrl = source;
  activeSession = new PlaybackSession(video, source);
  try {
    await activeSession.start();
  } catch (error) {
    await activeSession.fallback(error);
  } finally {
    activeSession = null;
  }
}

if (settings.enabled) {
  maybeStart();
  const observer = new MutationObserver(() => maybeStart());
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["src"] });
  window.addEventListener("pagehide", () => activeSession?.stop(), { once: true });
}
