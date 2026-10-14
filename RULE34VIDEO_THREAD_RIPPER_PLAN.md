# Rule34video 多線播放插件開發計畫

> 狀態：僅規劃，尚未開始實作  
> 建立日期：2026-10-14  
> 目標環境：Violentmonkey；第一版優先支援 Chromium 系瀏覽器  
> 基底參考：`BILIBILI_THREAD_RIPPER_ARCHITECTURE.md`

## 1. 目標與範圍

只做一件事：在使用者正常播放 `rule34video.com` 單一影片時，以少量並行 Range 請求和少數經驗證的 CDN 候選提高下載穩定度，降低卡頓。

第一版需要：

- 自動辨認目前播放的 MP4。
- 同一檔案分成互不重疊的 byte ranges 並行下載。
- 嘗試少數可信的 Boomio CDN 節點，失敗時切換。
- 執行緒數可由使用者設定並永久保存。
- 只預取有限播放緩衝，不下載整部影片。
- seek、換影片、關閉插件時取消舊請求。
- 出錯時安全恢復網站原生播放。

第一版不做：

- Bilibili 的完整設定面板、浮動球、通知卡、統計面板。
- 自動執行緒演算法、hedge 重複副本、直播、DASH/HLS。
- 搜尋、爬取、索引、批次下載或背景下載。
- 自動掃描大量 CDN hostname。
- 修改帳號、權限、token、地區或付費限制。
- 同時加速多個 `<video>`。

## 2. 已確認的實際媒體特性

只對使用者提供的範例 URL 做了兩次極小唯讀探測，沒有保存完整 URL 或 token 到專案文件。

### HTTP 行為

`Range: bytes=0-0` 的結果：

- `206 Partial Content`
- `Content-Type: video/mp4`
- `Content-Range: bytes 0-0/68244579`
- `Content-Length: 1`
- `Cache-Control: no-store`
- 節點 header 顯示 `eu-cdn03-prem.boomio-cdn.com`
- origin header 顯示一個 `origin-videos.com` 上游
- 回應沒有 `Access-Control-Allow-Origin`

推論：

- 伺服器正確支援 bounded Range，適合切片並行。
- 網站原生 `<video src>` 可以跨來源播放，不代表頁面 JavaScript 可以讀 response body。
- 因為沒有 CORS，普通 page `fetch` / XHR 不足以實作下載器；需要 Violentmonkey 的跨域 request 能力。
- `no-store` 使「先用腳本預抓、再讓原生 video 從瀏覽器 cache 讀」不可行。

### MP4 結構

讀取前 512 KiB 後看到：

```text
0          ftyp       32 bytes
32         moov       470047 bytes
470079     free       8 bytes
470087     mdat       67774492 bytes
```

這是 moov 在前、單一大型 mdat 的 progressive MP4，不是已經由 `moof + mdat` 組成的 fragmented MP4。

因此不能把任意 Range 直接交給 `SourceBuffer.appendBuffer()`。瀏覽器的 ISO BMFF MSE byte stream 要初始化段與可獨立 append 的 movie fragments；必須先把 progressive MP4 即時切成 MSE 可用的 fragmented MP4。計畫使用 [GPAC MP4Box.js](https://github.com/gpac/mp4box.js) 做漸進解析與 segmentation，它官方提供 progressive parsing、MSE segmentation 與 seek 所需能力。

### CDN 候選現況

公開資料可看到至少以下 hostname 存在：

- `eu-cdn01-prem.boomio-cdn.com`
- `eu-cdn02-prem.boomio-cdn.com`
- `eu-cdn03-prem.boomio-cdn.com`

但「hostname 存在」不代表同一個 `file + acctoken` 能跨節點使用。這必須以極小 Range 逐一驗證；未驗證節點絕不拿來下載正文。

## 3. 最小可行架構

```text
rule34video 頁面
  └─ userscript（盡量只用一個 sandbox realm）
      ├─ VideoDetector：找到主要 video 與原始 MP4 URL
      ├─ Settings：GM storage + menu command
      ├─ CdnPool：最多驗證 3 個明確候選
      ├─ RangeScheduler：固定全域並行上限
      ├─ MP4Box.js：progressive MP4 → fMP4 fragments
      ├─ MsePlayer：串行 append、緩衝與 seek
      └─ Fallback：恢復原始 src、時間與播放狀態
```

優先嘗試讓所有程式都在 userscript sandbox 中執行，因為這個方案只需要 GM request、DOM、MediaSource，不需要讀取網站私有 player API，也不需要覆寫頁面 `fetch/XHR`。這樣可刪掉 BTR 的 page-world 注入、bridge、storage shim 與訊息通道。

只有實測發現 sandbox 建立的 MediaSource 無法可靠掛到頁面 `<video>` 時，才增加一個很小的 page-world player bridge。跨 realm 傳大量 binary 的成本高，不能預先採用複雜橋接。

## 4. 使用者設定

最輕巧的 UI 是 Violentmonkey 選單，不建立頁面內設定面板：

- `Rule34video 加速：開/關`
- `設定下載執行緒（目前：4）`
- `顯示目前狀態`

「設定下載執行緒」用一個數字輸入 prompt：

- 最小：1
- 預設：4
- 建議：3～4
- 硬上限：8

這個數字是整個插件的全域同時連線上限，包含正文 Range、重試與 CDN 驗證；不是每個 CDN 各自擁有 N 條。這可避免選 4 卻實際建立 12 條連線。

設定以 `GM_getValue` / `GM_setValue` 保存。第一版不做自動升線程；伺服器回 429 時，安全機制可以暫時把有效並行降為 1，但不會擅自提高到設定值以上。

## 5. 媒體 URL 發現

探測順序：

1. 尋找頁面中面積最大、可見的 `<video>`。
2. 讀 `currentSrc`、`src` 和 `<source src>`。
3. 用 MutationObserver 監看 video/source 新增與 `src` 變更，適應換片或 SPA。
4. 必要時只讀 `performance.getEntriesByType("resource")` 中已發生、符合 allowlist 的 MP4 URL。

只接受：

- HTTPS。
- hostname 是 `rule34video.com` 或嚴格的 `*.boomio-cdn.com`。
- path / query 呈現影片端點，且 response 經驗證為 `video/mp4`。

診斷只記 hostname、檔案大小、狀態碼，不記 `file`、`acctoken` 或完整 query。

每個新 URL 會得到一個 session generation。換片、URL/token 更新或 video 移除時：先 abort 全部舊 request，再允許新 session 寫入 MSE。

## 6. CDN 驗證與選擇

候選來源依優先順序：

1. 網站自己給的原始 hostname。
2. 同一頁已實際出現的其他 Boomio 媒體 hostname。
3. 小型內建 allowlist：`eu-cdn01-prem`、`eu-cdn02-prem`、`eu-cdn03-prem`。

不做 DNS 字典掃描，也不根據流水號無限猜 hostname。每部影片最多三個候選，依序而非同時驗證。

每個替代節點只做一次 16 KiB probe，必須同時滿足：

- HTTP 206。
- `Content-Range` 起訖精確符合。
- 總檔案長度與原節點相同。
- 前 16 KiB 與原始節點雜湊相同。
- `Content-Type` 是 MP4。

通過後才加入 pool。第一次正文傳輸會測實際速度，之後按速度加權分配 Range；仍保留輪替機會，避免單一節點突然變慢。

錯誤處理：

- 401/403：該候選對此 token 不可用，這部影片停用它，不反覆測。
- 404：該候選沒有檔案，停用。
- 429：停止新請求、全 session 降到單線並冷卻至少 60 秒；不立即重試。
- 5xx / timeout：短暫冷卻後允許換另一個已驗證節點重試一次。
- Range 或內容雜湊不一致：永久停用該候選，絕不交資料給播放器。

不保證任何設定能完全避免 IP 限制；插件只能用保守請求數、限速退避與不做重複下載來降低風險。

## 7. 多線 Range 排程

採比 BTR 簡單很多的批次模型：

1. 先單線取得完整 `ftyp + moov`，上限逐步擴張，避免假設 moov 固定為 512 KiB。
2. MP4Box 解析 metadata、tracks、codec、sample table。
3. 從目前需要的 mdat offset 開一個固定大小下載 window。
4. window 依設定的 thread 數切成等長、不重疊 Range。
5. 將 pieces 分配給已驗證 CDN；並行下載。
6. 每片嚴格驗證 206、Content-Range 與 byte length。
7. 全部完成後按 offset 排序、連續交給 MP4Box。
8. MP4Box 產生 fMP4 init/media segments，依序 append 到 MSE。
9. 前向緩衝夠就停止開新 window，低於門檻才繼續。

初始參數：

- media window：4 MiB；實測後可調到 2～8 MiB，但不提供使用者設定。
- 最小 piece：256 KiB，避免高 thread 對小 window 製造太多請求。
- 前向緩衝高水位：30 秒。
- 重新啟動低水位：10 秒。
- 單 request 首字節 timeout：6 秒。
- 停傳 timeout：5 秒。
- 每 piece 最多重試 1 次。

第一版刻意不做 hedge。hedge 會下載重複 bytes、增加同時連線，與「降低 ban 風險」衝突。慢 piece 只在 timeout 或明確失敗後切換節點重試。

排程器的硬性不變量：

- 活躍 GM requests 永不超過使用者設定。
- 只有完全驗證且與預期 offset 連續的 bytes 才能餵給 parser。
- 舊 generation 完成的 callback 一律丟棄。
- abort 必須真的中止 GM request，不只忽略 Promise。
- 相同 byte range 不主動同時下載兩份。

## 8. MP4Box.js 與 MSE 播放

採用 MP4Box.js 是這份計畫唯一明顯增加體積的部分，但範例影片的格式使它不可省略；自行重寫 MP4 sample table、fragmentation、codec init 與 seek 會更大、更危險。

預計流程：

1. `MP4Box.createFile()`。
2. 將每個連續 ArrayBuffer 加上正確 `fileStart` 後 `appendBuffer()`。
3. `onReady` 取得音訊/影片 track、codec 與 duration。
4. 先以 `MediaSource.isTypeSupported()` 驗證 codec；不支援就不接管。
5. 優先試 MP4Box 的 combined segmentation，使用一個包含音訊與影片 codec 的 SourceBuffer，減少同步狀態。
6. append initialization segment。
7. `onSegment` 收到 movie fragments 後放入單一 append queue。
8. append 完的 sample 用 `releaseUsedSamples()` 釋放，限制記憶體。
9. 播放過久後移除過舊 buffer，只保留播放頭後約 30 秒。

若 combined 模式對該檔案/瀏覽器不可靠，再改成 audio/video 各一個 SourceBuffer；不在第一版同時維護兩套路徑。

### Seek

seek 是正式可用前必測，不留到最後才補：

- 目標已在 buffered range：直接交給 `<video>`。
- 目標不在 buffer：abort 目前 window，清除遠離目標的 buffer，使用 MP4Box 的 random-access seek 結果取得新 offset，再從該 offset 開新 generation 下載。
- seek 後仍需等待一小段連續 buffer 才恢復播放。
- 若 MP4Box 在此格式上的 seek/fragment state 不可靠，第一個 fallback 是重建 MP4Box + MediaSource session 並恢復目標時間；不是偷偷讓原生與加速器同時下載。

## 9. 接管與安全回退

接管前保存：

- 原始 `src/currentSrc`。
- `currentTime`。
- 播放或暫停意圖。
- `volume`、`muted`、`playbackRate`、`loop`。

只有以下都成立才取消原生 src 並換上 MSE：

- 原始 URL 已取得。
- 基礎 Range 驗證成功。
- moov 可解析。
- codec 被 MSE 支援。
- 至少一個 CDN 可用。

這樣能縮短「原生下載已取消、加速播放又還沒準備好」的空窗。切換時必須讓原生請求停止，避免雙重下載。

遇到 parser、MSE、Range 連續性或重試耗盡等致命錯誤：

1. abort 所有加速請求。
2. 清 append queue、revoke object URL。
3. 恢復原始 src 與播放屬性。
4. metadata ready 後恢復 currentTime。
5. 原本在播放才呼叫 `play()`。
6. 這部影片本次頁面生命週期不再自動重接管，避免錯誤迴圈。

## 10. 最小檔案結構

實作時預計建立獨立目錄，不改 Bilibili 基底：

```text
rule34video-thread-ripper/
├─ README.md
├─ LICENSES.md
├─ package.json
├─ scripts/
│  └─ build.mjs
├─ src/
│  ├─ core.js          # Range 驗證、session、scheduler、CDN pool
│  ├─ player.js        # MP4Box + MediaSource + seek/fallback
│  └─ userscript.js    # metadata、GM request、DOM detector、menu settings
├─ vendor/
│  └─ mp4box.*         # 固定版本與原授權
├─ dev/
│  ├─ fixtures/
│  └─ run-tests.js
└─ dist/
   └─ rule34video-thread-ripper.user.js
```

執行期仍打包成一個 userscript。MP4Box 固定版本、隨腳本打包，不使用遠端 `@require`，避免第三方 CDN 故障或供應鏈內容無預警改變。保留 MP4Box.js 的 BSD-3-Clause 與 BTR 參考部分的 MIT 聲明。

## 11. 測試計畫

### 離線單元測試

- Range split 不重疊、不漏 byte。
- 206 / Content-Range / length 驗證。
- 全域 semaphore 絕不超過 1～8 的每個設定值。
- out-of-order 完成仍按 offset 交付。
- abort / generation 阻止舊資料落地。
- CDN probe 的 total/hash 驗證。
- 403/404/429/5xx/timeout 的退避規則。
- 完整 URL/token 不進 log。

### 本地瀏覽器 fixture

- progressive MP4、moov 在前。
- 4 個模擬 CDN：快、慢、中途停傳、429。
- 起播、連續播放、暫停、seek、倍速、loop。
- 動態換 src 與移除 video。
- MSE quota 與 fallback。
- 設定 thread 1、2、4、8 時的真實最大請求數。

### 真站手動 smoke test

必須由使用者明確選一個測試影片；每輪只用一部片，不批次測：

- thread 1 基線。
- thread 2。
- thread 4。
- 驗證三個 CDN 候選各只 probe 一次。
- 查看有無 403/429、是否同時存在原生與插件流量。
- 播放 5～10 分鐘、至少一次 seek。

不在自動測試或 CI 放入真實 signed URL。

## 12. 開發里程碑與停止條件

### M0：現場資料確認

取得一個實際影片頁 URL，確認 video DOM、request initiator、是否登入/付費狀態、換畫質行為，以及至少兩次換片後 URL host 規律。

停止條件：若媒體 URL 只能由瀏覽器的受保護/CDM 路徑使用，或 token 明確綁定單一 host 且 GM request 也無法存取，先回報，不硬繞。

### M1：單線 MSE 可播放

先用原始 CDN、thread 1 完成 MP4Box → MSE，驗證音畫、seek、結尾與 fallback。單線不穩之前不加入多線。

### M2：單 CDN 多 Range

加入固定 2/4 thread、window split、ordered feed 與 buffer watermarks。確認請求總量與播放速度真的改善。

### M3：少數多 CDN

加入最多 3 個候選、順序 probe、內容驗證、速度加權與失敗切換。若 token 不能跨 host，保留單 CDN 多 Range，不用偽造「多 CDN」。

### M4：設定與打包

加入 GM menu、1～8 數字設定、啟用開關、狀態摘要與單檔 dist userscript。

### M5：保守實站驗收

用 1/2/4 thread 對比，不先測 8；觀察 429、播放卡頓、重複流量、seek 與 IP/帳號異常。只有 4 穩定且確有必要，才讓使用者自行選 8。

## 13. 風險與政策邊界

Rule34video 的公開條款目前寫有禁止用自動化流程擷取或索引站內內容的條款。這個插件設計為使用者主動播放時，僅取得播放器本來會取得的同一影片 bytes，不做索引、保存或額外影片預抓；但這不能保證站方一定認為它符合條款，也不能保證不觸發限流或封鎖。

因此技術上強制：

- 僅在可見頁面的 active video 工作。
- 最多 30 秒前向緩衝。
- 暫停一段時間後停止新下載。
- 頁面隱藏且影片暫停時停止新下載。
- 不下載播放頭後整部影片。
- 不繞過權限或 token。
- 429 立即大幅退避。
- 不做大量 CDN 探測。

若站方明確禁止這類播放最佳化或實測出現封鎖警告，應停止使用，而不是靠更換身份、代理或規避偵測繼續請求。

## 14. 最終設計判斷

最輕巧的可行版本不是複製 BTR，而是：

```text
約 3 個自有模組
+ 1 個固定版本 MP4Box.js
+ 1 個 userscript 檔
+ 固定 1～8 全域 Range 併發
+ 最多 3 個經小 Range 驗證的 CDN
+ 無 hedge、無自動升線程、無完整頁面 UI
```

最大的未知數不是 Range，而是：

1. Violentmonkey GM request 是否能用該 token 讀完整 Range；
2. `acctoken` 是否允許跨 `eu-cdn01/02/03-prem` 使用；
3. MP4Box combined segmentation 對網站常見影片 codec 與 seek 是否穩定；
4. 影片頁如何建立/替換 `<video>` 與 signed URL。

完成 M0 後才能把這份計畫定稿為實作規格。
