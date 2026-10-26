# Rule34Video Thread Ripper：目前進度與後續開發

更新日期：2026-10-27

## 1. 專案目標

以 `Bilibili-thread-ripper` 為技術參考，製作 Edge／Violentmonkey 優先的輕量 Rule34Video 播放加速插件。

核心目標：

- 用多個 HTTP Range 請求提高影片下載吞吐量。
- 在多個 Boomio CDN 之間分散請求。
- 保留網站原有播放器介面、播放控制與跳轉能力。
- 避免爬站、整片預抓和大量 CDN 掃描，以降低限流或封鎖 IP 的風險。
- 插件失敗時自動回退網站原生播放器。

## 2. 目前穩定基底

目前開發版本：`0.4.0`

上一個經實際播放確認並提交的基底：`0.3.0`（commit `85da8dd`）

安裝檔：

`rule34video-thread-ripper/dist/rule34video-thread-ripper.user.js`

原始碼：

- `rule34video-thread-ripper/src/main.js`
- `rule34video-thread-ripper/src/core.js`

目前已經可以：

- 從網站 `<video>` 取得 `/get_file/...` 原始網址及有效 token。
- 追蹤轉址後的 Boomio CDN 真實網址。
- 驗證最多 3 個候選 CDN。
- 以 `206 Content-Range`、總檔案長度及首段 SHA-256 確認 CDN 回傳同一檔案。
- 使用 1–8 個可調 Range 線程，預設 4。
- 每個子 Range 約 1 MiB，單批最多 4 MiB。
- 使用 MP4Box.js 將 progressive MP4 即時轉為 MediaSource 可播放片段。
- 正確設定 MediaSource duration。
- 支援未緩衝位置的跳轉。
- 維持約 30 秒向前緩衝，不刻意下載整部影片。
- 收到 HTTP 429 時中止同批請求，等待後暫時降為單線程。
- 接管或分段失敗時回復網站原始影片網址。

## 3. 已修正的重要問題

### MP4Box 音影分段不一致

MP4Box combined 模式要求所有 fragmented tracks 使用相同的 `nbSamples`。原本依影音各自採樣率計算，導致：

```text
Cannot set segment options ... nbSamples ... does not match existing tracks
MediaSource SourceBuffer failed
```

目前改為使用影片軌約 2 秒的樣本數，並套用到所有影音軌。

### 播放時間顯示 Infinity／NaN

MediaSource 原本沒有寫入 MP4 的有限時長，造成原站時間列顯示 `Infinity:NaN`，也無法正確拖曳。

目前以：

```text
duration seconds = MP4 duration / MP4 timescale
```

設定 `MediaSource.duration`，播放時間和跳轉已恢復正常。

## 4. 目前 CDN 行為

已觀察到的候選 hostname：

- `eu-cdn01-prem.boomio-cdn.com`
- `eu-cdn02-prem.boomio-cdn.com`
- `eu-cdn03-prem.boomio-cdn.com`
- `eu-cdn04-prem.boomio-cdn.com`
- `eu-cdn10-prem.boomio-cdn.com`
- `eu-cdn11-prem.boomio-cdn.com`

實際可用性依影片而異。例如某部影片可能在 `cdn01` 回 404、`cdn02` 發生 Network error，但 `cdn03`、`cdn04` 可正常提供相同檔案。

目前策略：

1. 先從 `/get_file/` 的實際轉址取得 primary CDN。
2. 只嘗試 `N`、`N+1`、`N-1` 三個相鄰候選，不假設 CDN 只到 04。
3. 候選探測依序執行，不同時掃描所有節點。
4. 最多保留 3 個驗證成功的 CDN。
5. `0.3.0` 的正式 Range 依單一影片內的 EWMA 速度自適應分配。

## 5. 效能量測功能

`0.2.0` 新增效能紀錄，而且不會產生額外網路請求。它只量測原本需要的正式 Range。

每批 Console 紀錄包含：

- 設定線程數。
- 實際並行峰值。
- 批次資料量、耗時與合計 MiB/s。
- 每個子 Range 使用的 CDN。
- 近似 TTFB。
- 個別 Range 速度。
- `x-stitch-cdn-cache` 狀態。

Violentmonkey 選單「輸出本次效能統計」包含：

- `configuredThreads`
- `batches`
- `downloadedMiB`
- `activeDownloadSeconds`
- `aggregateMiBPerSecond`
- `peakParallelism`
- `stalls`／`stallSeconds`
- `seeks`／`averageSeekRecoverySeconds`
- 各 CDN 平均 TTFB、平均速度和 cache HIT 次數。

## 6. 已完成的 1 線程／2 線程實測

同一環境下，各進行一次跳轉：

| 設定 | 批次 | 下載量 | 活躍下載時間 | 合計速度 |
|---|---:|---:|---:|---:|
| 1 線程 | 16 | 15.5 MiB | 19.13 秒 | 0.81 MiB/s |
| 2 線程 | 11 | 20.5 MiB | 13.31 秒 | 1.54 MiB/s |

結論：

- 雙線程速度為單線程的約 `1.90×`。
- 相對理想 2 倍速度的並行效率約為 `95%`。
- 下載同樣 20.5 MiB，單線程依實測速度約需 25.3 秒，雙線程實際為 13.31 秒。
- 正規化後，下載等待時間約減少 47%。
- 多線程確實同時工作，而不是只有請求數增加。

各 CDN 的表現：

| CDN | 1 線程速度 | 2 線程速度 | TTFB | cache |
|---|---:|---:|---:|---:|
| `eu-cdn03-prem` | 0.83 MiB/s | 0.83 MiB/s | 約 234–237 ms | 全部 HIT |
| `eu-cdn04-prem` | 0.79 MiB/s | 0.79 MiB/s | 約 230–231 ms | 全部 HIT |

兩個節點速度很接近。`cdn03` 吞吐量略高，`cdn04` TTFB 略低，目前沒有理由完全淘汰任何一個。兩個節點同時提供 Range，明顯優於只使用單一節點。

## 7. Bilibili Thread Ripper 的 CDN 策略

BTR 的 VOD 策略可作為下一階段參考，但不應原封不動搬到 Rule34Video。

### 候選來源

- Bilibili playinfo 提供的 `baseUrl` 和 `backupUrl`。
- 程式內建的官方大陸／海外 CDN hostname。
- 保留原始 pathname 和簽名，只替換 hostname。

### 啟動測試

- 初始化資料最多競速 3 個候選。
- 第一段媒體 head piece 至少 64 KiB。
- 最多可同時向 8 個 CDN 請求相同 head piece。
- 最先成功者勝出，其餘取消。
- 已收到至少 48 KiB 的取消請求仍可作為速度樣本。

這種策略較激進，會產生少量重複下載，不適合直接照搬到可能較敏感的 Rule34Video。

### 速度紀錄

BTR 以實際傳輸速度更新 EWMA：

```text
新速度 = 舊速度 × 0.65 + 本次速度 × 0.35
```

速度 key 為：

```text
CDN host + media pathname
```

query/token 不列入 key，因此同一檔案更新簽名後仍保留測量；另一部影片或另一個媒體檔案不會沿用。

### 分配方式

- 快節點分配較多 piece。
- 使用平滑加權輪詢，不把所有工作集中在同一節點。
- 低於最快節點 `1/12` 的已知慢節點暫時不分配正式 piece。
- 未測量或超過 90 秒未更新的節點，偶爾取得 trial piece。
- 失敗節點使用約 3–60 秒的指數退避。
- 同一節點兩次完全沒收到資料後，在當前影片停用。
- piece 中途失敗會保留已收到的前綴，只向其他 CDN 下載剩餘部分。
- 預測來不及播放時才啟動 hedge/rescue 副本。

### 紀錄生命週期

- CDN 速度屬於單一 media file／resolver。
- 同一影片的 signature 更新可沿用。
- 換影片後速度與 cache 判斷重置。
- 當前影片的失敗 ban list 可在影音軌及畫質 session 間共享。
- 跨影片只保存使用者設定和已知 hostname，不保存影片 cache 評分。

這符合 Rule34Video 的需求：每部影片在每個 CDN 是否 cache HIT 是獨立事件，不應把上一部影片的速度直接套到下一部影片。

## 8. 2026-10-18 發現：cache HIT 不代表速度足夠

實測 `cdn10`、`cdn11` 都回報 `x-stitch-cdn-cache: HIT`，但速度差距可超過十倍：

| CDN | Range 大小 | TTFB | 耗時 | 速度 | cache |
|---|---:|---:|---:|---:|---:|
| `eu-cdn11-prem` | 1 MiB | 約 240 ms | 約 3.54 秒 | 0.28 MiB/s | HIT |
| `eu-cdn10-prem` | 1 MiB | 約 224 ms | 約 0.30–0.89 秒 | 1.12–3.30 MiB/s | HIT |

舊版每批固定讓兩個 CDN 各下載 1 MiB，整批必須等待最慢請求，因此 2 MiB 批次仍耗時約 3.54 秒，只有約 0.57 MiB/s。快線早已完成但無法繼續領取工作，體感退化成單線程。

同時觀察到 `cdn11` 並非永久緩慢：播放約一小時後速度恢復。因此不能因早期慢速而整部影片永久排除，必須持續但低成本地重新測試。

## 9. `0.3.0`：單一影片內的 CDN 自適應分配

本版已實作每個 PlaybackSession 獨立的 CDN health state；換影片後重置，不跨影片保存 cache 或速度評分。

每個 CDN 記錄：

```text
EWMA throughput
EWMA approximate TTFB
samples
cache HIT/MISS counts
consecutive failures
blockedUntil
lastMeasuredAt
lastAssignedBatch
```

目前規則：

1. EWMA 使用 `old × 0.65 + sample × 0.35`。
2. 只有至少 256 KiB 的正式播放 Range 更新吞吐量。
3. `cache HIT` 只作觀察，不參與主要速度評分。
4. 速度仍未知的 CDN 先透過正常播放資料完成 warmup。
5. 速度不到最快節點 50% 的 CDN 不再固定取得完整 1 MiB piece。
6. 若某 CDN 明顯更快，多個線程可以同時使用該 CDN。
7. 接近速度的 CDN 使用平滑加權輪詢，繼續利用多 CDN 合計頻寬。
8. 慢節點每隔 8 批取得一次 retest；piece 依速度加權，最低為 256 KiB。
9. 測量超過 90 秒視為過期；重新測試成功時直接以新速度開始，讓恢復節點快速回歸。
10. Network error／timeout 進入 3–60 秒指數 cooldown。
11. HTTP 429 仍會中止同批並全域暫降單線程。
12. 沒有增加 benchmark request，也沒有加入相同 Range 的競速／hedge。

候選來源亦已修正：從實際轉址的 `cdnN` 嘗試 `N`、`N+1`、`N-1`，最多三個。例如 `cdn11` 現在會測試 `11、12、10`，不再錯誤繞回 `cdn01`。

Console 每個 Range 現在額外顯示：

- `選擇`：`warmup`、`weighted`、`retest` 或 `retry-N`。
- `EWMA (MiB/s)`：該 CDN 更新後的單一影片內速度估計。

## 10. `0.3.0` 實測項目（已完成一輪）

`0.3.0` 曾以 `cdn10` 快、`cdn11` 慢的影片進行下列驗證：

1. warmup 後，普通批次應多數把兩個線程交給快節點。
2. 慢節點不應每批取得完整 1 MiB。
3. 約每 8 批應看到一次 `retest`，通常只分到約 256 KiB。
4. 慢節點恢復後，其 EWMA 應更新並重新取得 `weighted` 工作。
5. 比較 `0.2.0` 的約 0.57 MiB/s，確認批次合計速度和跳轉恢復時間提升。
6. 確認同一 CDN 同時承擔兩個請求時，總速度是否仍高於一快一慢；若單一 hostname 有共享頻寬上限，下一版要加入 per-host 並行飽和度估計。

## 11. 驗證狀態

目前 `npm run check` 已通過：

- 13 項單元測試（以目前 `0.4.0` 計）。
- userscript 建置。
- JavaScript 語法檢查。

`0.3.0` 已在 commit `85da8dd`（`feat: v1.04 ewma weight chose CDN`）中。其實測顯示固定 35% EWMA 對 CDN 突然降速反應仍太慢，且未緩衝跳轉會等待整個一般批次。

## 12. `0.4.0`：快速降權與跳轉 urgent 模式

2026-10-27 實測顯示 `cdn05` 的單次速度會在約 1.3–3.3 MiB/s 間變動；舊 EWMA 仍約 2.2–3.1 MiB/s，因此排程繼續給它較大的 piece。雖然批次合計可達 2.3–6.5 MiB/s，向前快進約 5 秒仍有可感停頓。

本版修改：

1. 速度下降使用 70% 新樣本權重，快速反映壅塞。
2. 速度回升只使用 20% 新樣本權重，避免一次突發高速立即取得大量工作。
3. 實際排程分數取 `min(EWMA, 最近一次速度)`，單次慢尾端會立即影響下一批。
4. 慢節點門檻從最快速度的 50% 提高為 75%。
5. 慢節點重測週期由每 8 批縮短為每 4 批，仍只使用正常播放資料。
6. 未緩衝跳轉後設定兩個 urgent 批次。
7. urgent 批次總量為 1 MiB；2 線程時切成兩個 512 KiB Range，全部交給當前最快 CDN。
8. urgent 結束後恢復一般自適應分配與慢節點重測。
9. Console 會顯示 `選擇: urgent` 及 `排程分數 (MiB/s)`。

下一次實測應確認：

- 快進到未緩衝位置後，前兩批顯示 `urgent`。
- 2 線程時兩個 urgent Range 都是約 0.5 MiB，且使用相同的最佳 CDN。
- `cdn05` 出現一次明顯慢速後，EWMA 應比 `0.3.0` 更快下降。
- 一般批次不再因近期不穩定節點長時間維持高分而持續卡頓。
- 若仍只有快進 5 秒會卡，但目標時間其實位於 `video.buffered` 內，下一步應調查 MP4 keyframe／SourceBuffer 跳轉，而不是繼續調 CDN 公式。

`0.4.0` 已通過 13 項單元測試、userscript 建置與語法檢查，尚待實際 Violentmonkey 播放驗證，也尚未 commit。
