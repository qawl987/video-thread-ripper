import { createFile } from "mp4box";
import {
  AdaptiveCdnPool,
  DEFAULTS,
  bufferedAhead,
  clampInteger,
  commonSegmentSampleCount,
  isTimeBuffered,
  joinBuffers,
  makeCdnCandidates,
  maxConcurrentIntervals,
  mediaDurationSeconds,
  parseContentRange,
  parseHeaders,
  splitRange,
  splitRangeWeighted,
} from "./core.js";

const PREFIX = "[R34 Thread Ripper]";
const log = (...values) => console.info(PREFIX, ...values);
const warn = (...values) => console.warn(PREFIX, ...values);
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const toMiB = (bytes) => bytes / (1024 * 1024);
const rateMiBPerSecond = (bytes, milliseconds) => milliseconds > 0 ? toMiB(bytes) / (milliseconds / 1_000) : 0;
const rounded = (value, digits = 2) => Number(value.toFixed(digits));

class HttpError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

class PerformanceStats {
  constructor(video, configuredThreads) {
    this.video = video;
    this.configuredThreads = configuredThreads;
    this.batches = [];
    this.hosts = new Map();
    this.seekRecoveries = [];
    this.stallCount = 0;
    this.stallMilliseconds = 0;
    this.stallStartedAt = null;
    this.seekStartedAt = null;
    this.attached = false;
    this.onWaiting = () => {
      if (this.video.paused || this.video.seeking || this.seekStartedAt !== null || this.stallStartedAt !== null) return;
      this.stallStartedAt = performance.now();
      this.stallCount += 1;
    };
    this.onSeeking = () => {
      if (this.seekStartedAt === null) this.seekStartedAt = performance.now();
    };
    this.onSeeked = () => {
      if (this.video.paused) this.finishSeekRecovery();
    };
    this.onPlaying = () => {
      this.finishStall();
      this.finishSeekRecovery();
    };
  }

  recordBatch({ start, end, pieces, responses, startedAt, completedAt }) {
    const elapsedMilliseconds = completedAt - startedAt;
    const totalBytes = end - start + 1;
    const intervals = responses.map((response) => ({
      start: response.timing.startedAt,
      end: response.timing.completedAt,
    }));
    const peakParallelism = maxConcurrentIntervals(intervals);
    const batch = {
      number: this.batches.length + 1,
      totalBytes,
      elapsedMilliseconds,
      peakParallelism,
      requestedThreads: pieces.length,
    };
    this.batches.push(batch);

    const details = pieces.map((piece, index) => {
      const response = responses[index];
      const host = new URL(response.finalUrl).hostname;
      const bytes = piece.end - piece.start + 1;
      const elapsed = response.timing.completedAt - response.timing.startedAt;
      const ttfb = response.timing.firstByteAt - response.timing.startedAt;
      const cache = response.headers.get("x-stitch-cdn-cache") || "?";
      const aggregate = this.hosts.get(host) ?? {
        host,
        requests: 0,
        bytes: 0,
        transferMilliseconds: 0,
        ttfbMilliseconds: 0,
        cacheHits: 0,
        ewmaBps: 0,
        scoreBps: 0,
      };
      aggregate.requests += 1;
      aggregate.bytes += bytes;
      aggregate.transferMilliseconds += elapsed;
      aggregate.ttfbMilliseconds += ttfb;
      if (cache.toUpperCase() === "HIT") aggregate.cacheHits += 1;
      aggregate.ewmaBps = response.health?.ewmaBps || aggregate.ewmaBps;
      aggregate.scoreBps = response.health?.scoreBps || aggregate.scoreBps;
      this.hosts.set(host, aggregate);
      return {
        CDN: host,
        bytes: `${piece.start}-${piece.end}`,
        MiB: rounded(toMiB(bytes)),
        選擇: response.selectionReason,
        "近似 TTFB (ms)": Math.round(ttfb),
        "耗時 (ms)": Math.round(elapsed),
        "速度 (MiB/s)": rounded(rateMiBPerSecond(bytes, elapsed)),
        "EWMA (MiB/s)": rounded((response.health?.ewmaBps || 0) / (1024 * 1024)),
        "排程分數 (MiB/s)": rounded((response.health?.scoreBps || 0) / (1024 * 1024)),
        cache,
      };
    });

    log(
      `批次 #${batch.number}：${pieces.length} 線程（實際峰值 ${peakParallelism}），` +
      `${rounded(toMiB(totalBytes))} MiB / ${rounded(elapsedMilliseconds / 1_000)} 秒 = ` +
      `${rounded(rateMiBPerSecond(totalBytes, elapsedMilliseconds))} MiB/s`,
    );
    console.table(details);
  }

  attach() {
    if (this.attached) return;
    this.attached = true;
    this.video.addEventListener("waiting", this.onWaiting);
    this.video.addEventListener("seeking", this.onSeeking);
    this.video.addEventListener("seeked", this.onSeeked);
    this.video.addEventListener("playing", this.onPlaying);
  }

  finishStall() {
    if (this.stallStartedAt === null) return;
    this.stallMilliseconds += performance.now() - this.stallStartedAt;
    this.stallStartedAt = null;
  }

  finishSeekRecovery() {
    if (this.seekStartedAt === null) return;
    this.seekRecoveries.push(performance.now() - this.seekStartedAt);
    this.seekStartedAt = null;
  }

  detach() {
    if (!this.attached) return;
    this.finishStall();
    this.attached = false;
    this.video.removeEventListener("waiting", this.onWaiting);
    this.video.removeEventListener("seeking", this.onSeeking);
    this.video.removeEventListener("seeked", this.onSeeked);
    this.video.removeEventListener("playing", this.onPlaying);
  }

  snapshot() {
    const totalBytes = this.batches.reduce((sum, batch) => sum + batch.totalBytes, 0);
    const activeMilliseconds = this.batches.reduce((sum, batch) => sum + batch.elapsedMilliseconds, 0);
    const averageSeek = this.seekRecoveries.length
      ? this.seekRecoveries.reduce((sum, milliseconds) => sum + milliseconds, 0) / this.seekRecoveries.length
      : 0;
    return {
      configuredThreads: this.configuredThreads,
      batches: this.batches.length,
      downloadedMiB: rounded(toMiB(totalBytes)),
      activeDownloadSeconds: rounded(activeMilliseconds / 1_000),
      aggregateMiBPerSecond: rounded(rateMiBPerSecond(totalBytes, activeMilliseconds)),
      peakParallelism: Math.max(0, ...this.batches.map((batch) => batch.peakParallelism)),
      stalls: this.stallCount,
      stallSeconds: rounded(this.stallMilliseconds / 1_000),
      seeks: this.seekRecoveries.length,
      averageSeekRecoverySeconds: rounded(averageSeek / 1_000),
    };
  }

  printSummary() {
    const overall = this.snapshot();
    const hosts = [...this.hosts.values()].map((host) => ({
      CDN: host.host,
      requests: host.requests,
      MiB: rounded(toMiB(host.bytes)),
      "平均 TTFB (ms)": Math.round(host.ttfbMilliseconds / host.requests),
      "平均速度 (MiB/s)": rounded(rateMiBPerSecond(host.bytes, host.transferMilliseconds)),
      "目前 EWMA (MiB/s)": rounded(host.ewmaBps / (1024 * 1024)),
      "目前排程分數 (MiB/s)": rounded(host.scoreBps / (1024 * 1024)),
      "cache HIT": `${host.cacheHits}/${host.requests}`,
    }));
    log("本次播放效能摘要", overall);
    if (hosts.length) console.table(hosts);
    return { overall, hosts };
  }
}

class RangeClient {
  constructor(referrer, stats) {
    this.referrer = referrer;
    this.stats = stats;
    this.urls = [];
    this.pool = new AdaptiveCdnPool();
    this.active = new Set();
    this.cooldownUntil = 0;
    this.effectiveThreads = settings.threads;
    this.rateLimited = false;
  }

  abortAll() {
    for (const request of this.active) request.abort();
    this.active.clear();
  }

  setUrls(urls) {
    this.urls = urls;
    this.pool.setUrls(urls);
  }

  request(url, start, end) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const startedAt = performance.now();
      let firstByteAt = null;
      const request = GM_xmlhttpRequest({
        method: "GET",
        url,
        headers: {
          Range: `bytes=${start}-${end}`,
          Referer: this.referrer,
        },
        responseType: "arraybuffer",
        timeout: 20_000,
        onprogress: () => {
          if (firstByteAt === null) firstByteAt = performance.now();
        },
        onload: (response) => {
          const completedAt = performance.now();
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
            timing: {
              startedAt,
              firstByteAt: firstByteAt ?? completedAt,
              completedAt,
            },
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

  async fetchPiece(piece, preferredUrl, selectionReason) {
    let lastError;
    const candidates = this.pool.retryOrder(preferredUrl);
    const attempts = Math.min(3, Math.max(1, candidates.length));
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const url = candidates[attempt];
      try {
        const response = await this.request(url, piece.start, piece.end);
        const elapsedMs = response.timing.completedAt - response.timing.startedAt;
        const ttfbMs = response.timing.firstByteAt - response.timing.startedAt;
        const health = this.pool.recordSuccess(url, {
          bytes: response.buffer.byteLength,
          elapsedMs,
          ttfbMs,
          cache: response.headers.get("x-stitch-cdn-cache"),
        });
        return {
          ...response,
          health,
          selectionReason: attempt ? `retry-${attempt}` : selectionReason,
        };
      } catch (error) {
        lastError = error;
        if (error?.name === "AbortError") throw error;
        this.pool.recordFailure(url, error);
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

  async fetchBatch(start, end, options = {}) {
    if (Date.now() >= this.cooldownUntil) this.effectiveThreads = settings.threads;
    const threads = Math.min(this.effectiveThreads, settings.threads);
    const rangeLength = end - start + 1;
    const pieceCount = options.urgent
      ? Math.max(1, Math.min(threads, Math.ceil(rangeLength / DEFAULTS.minAdaptivePieceBytes)))
      : splitRange(start, end, threads, DEFAULTS.requestBytes).length;
    const plan = this.pool.plan(pieceCount, Date.now(), options);
    if (!plan.length) throw new Error("No verified CDN is available");
    const pieces = splitRangeWeighted(
      start,
      end,
      plan.map((item) => item.weight),
      DEFAULTS.minAdaptivePieceBytes,
    ).map((piece, index) => ({
      ...piece,
      preferredUrl: plan[index].url,
      selectionReason: plan[index].reason,
    }));
    const startedAt = performance.now();
    const responses = await Promise.all(pieces.map((piece) =>
      this.fetchPiece(piece, piece.preferredUrl, piece.selectionReason)));
    const completedAt = performance.now();
    this.stats.recordBatch({ start, end, pieces, responses, startedAt, completedAt });
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
    this.stats = new PerformanceStats(video, settings.threads);
    this.client = new RangeClient(location.href, this.stats);
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
    this.urgentBatches = 0;
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
    this.client.setUrls(valid);
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
    this.urgentBatches = 2;
    log(`跳轉到 ${requestedTime.toFixed(1)} 秒，從 byte ${this.nextOffset} 續傳`);
    return true;
  }

  async pump() {
    while (!this.stopped && this.nextOffset < this.totalBytes) {
      await this.handleSeek();
      await this.waitForRoom();
      if (this.stopped) break;
      const urgent = this.urgentBatches > 0;
      const batchBytes = urgent
        ? DEFAULTS.requestBytes
        : Math.min(
          DEFAULTS.maxBatchBytes,
          Math.max(DEFAULTS.requestBytes, this.client.effectiveThreads * DEFAULTS.requestBytes),
        );
      const end = Math.min(this.totalBytes - 1, this.nextOffset + batchBytes - 1);
      const offset = this.nextOffset;
      try {
        const buffer = await this.client.fetchBatch(offset, end, { urgent });
        if (this.seekRequest !== null) continue;
        this.appendToMp4(buffer, offset);
        this.nextOffset = end + 1;
        if (urgent) this.urgentBatches -= 1;
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
    this.stats.attach();
    if (!this.wasPaused) this.video.play().catch(() => {});
    log(`接管完成：${settings.threads} 線程、${this.client.urls.length} 個 CDN`);
    await this.pump();
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.client.abortAll();
    this.video.removeEventListener("seeking", this.onSeeking);
    this.stats.detach();
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
let lastStats = null;
let attemptedUrl = null;

GM_registerMenuCommand("輸出本次效能統計", () => {
  const stats = activeSession?.stats ?? lastStats;
  if (!stats) return alert("目前還沒有可輸出的播放統計。");
  stats.printSummary();
});

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
    lastStats = activeSession?.stats ?? lastStats;
    activeSession = null;
  }
}

if (settings.enabled) {
  maybeStart();
  const observer = new MutationObserver(() => maybeStart());
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["src"] });
  window.addEventListener("pagehide", () => activeSession?.stop(), { once: true });
}
