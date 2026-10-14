# Bilibili Thread Ripper 架構筆記（供後續移植 rule34video）

> 建立日期：2026-10-14  
> 來源基底：`Bilibili-thread-ripper/`  
> 用途：讓後續開發不必重新通讀整個基底，快速掌握可重用的下載內核、Bilibili 專屬耦合，以及移植到 `rule34video.com` 前必須實測的條件。

## 先說結論

BTR 並不是單純把一個影片 URL 同時下載很多次。它的核心做法是：

1. 先拿到合法、可播放的媒體描述與帶簽名 URL。
2. 把播放器需要的 byte range 再切成互不重疊的小 Range。
3. 經過全頁共享的優先級併發佇列，把小塊分給多個可互換的 CDN URL。
4. 嚴格驗證每個 `206 Content-Range` 的起訖、總長與實收長度。
5. 慢請求按播放 deadline 啟動 hedge（備援副本），中途失敗則保留已驗證前綴、只補剩餘尾段。
6. 按原 byte 順序重組，再交回播放器或 append 進自建的 MSE。

BTR 有兩條點播路徑：

- **全接管**：保留 Bilibili 的 UI，但替換媒體底層。自行建立 `MediaSource` / `SourceBuffer`、讀 DASH representation 的 `SegmentBase`、下載 init/index、解析 MP4 `sidx`、按 segment 預取並 append。
- **相容模式**：Bilibili 原播放器仍掌管解碼、緩衝、seek、畫質切換；BTR 只攔截播放器的 bounded Range `fetch` / async `XMLHttpRequest`，多線下載完後合成語意等價的 `206` 回應。

對 rule34video 的第一版，應優先選「攔截原播放器 Range」還是「直接對單檔 MP4 做 MSE 接管」，不能照搬 Bilibili 的決定。真正的判斷點是該站實際使用 progressive MP4、HLS、DASH 還是 blob/MSE，以及媒體主機是否允許跨來源 Range、CORS、同一路徑換 host。

## 打包與執行邊界

入口配置在 `user_scripts/adapter/meta.json`：

- `@match https://*.bilibili.com/*`
- `@run-at document-start`
- 有 `GM_registerMenuCommand`、`GM_addElement`、`GM.getValue`、`GM.setValue`、`GM_addValueChangeListener`
- 要求 userscript manager 的 JavaScript/content sandbox
- `pageFiles` 按固定順序串接；順序就是全域模組依賴順序

`scripts/build.mjs` 的產物結構是：

```text
userscript header
└─ IIFE
   ├─ function pageCode() {
   │    storage-shim
   │    range-core
   │    cdn-resolver
   │    sidx
   │    idm-downloader
   │    native-mse-player
   │    native-range-transport
   │    runtime-notices
   │    settings-panel
   │    page-hook
   │    live-core
   │    live-hook
   │    notification-view
   │    bridge
   │  }
   └─ loader（決定直接執行或把 pageCode 注入頁面主世界）
```

為什麼一定要進頁面主世界：需要覆寫該頁真正使用的 `window.fetch`、`XMLHttpRequest.prototype`、`history.pushState/replaceState`，並讀取 `window.player`、`__playinfo__`、`__INITIAL_STATE__` 等站內物件。userscript sandbox 裡的 `window` 不一定是頁面的真實 global。

`loader.js` 優先用 `GM_addElement(..., "script")` 注入，處理嚴格 CSP；若 userscript 本來就在 page context，則直接呼叫 `pageCode()`。`data-btr-userscript` 防止重複安裝。除直播 iframe 外，其餘 iframe 會退出。

## 設定的跨邊界設計

頁面主世界拿不到 GM 儲存 API，因此分成兩層：

- `loader.js` 在 manager sandbox 中服務 `btr-userscript-storage-request`，用 GM storage 讀寫 JSON 字串。
- `storage-shim.js` 在頁面主世界模擬 BTR 所需的最小 `chrome.storage`：`sync/local.get/set/remove`、`onChanged`、`runtime.lastError`。
- 兩邊只用 `CustomEvent.detail` 傳 JSON 字串，避免 Firefox 的跨 compartment 物件問題。
- GM storage 無回應 3 秒就退回該子網域的 `localStorage`。
- 支援 GM value-change listener 時即時跨分頁同步；不支援時在 focus / visibility change 重新讀取。
- `bridge.js` 負責 defaults、正規化、保存設定，再用 `window.postMessage` 把設定發給頁面 hook。

目前預設值的重點：啟用、全接管、大陸 CDN、自動併發（8～64）、45 秒前向緩衝；直播預設關閉。

移植時可保留這個 sandbox/page-world 橋接架構，但名稱、storage prefix、channel、DOM id、全域 debug 名稱都必須改成新專案命名，不能讓兩個腳本互相收到訊息。

## 點播資料流

```text
頁面載入（document-start）
  → 注入 pageCode 到頁面主世界
  → page-hook 先保存 nativeFetch，再觀察 playurl fetch/XHR
  → bridge 從 GM storage 發 settings
  → 辨認目前 SPA route / 分 P / 互動分支 / 劇集
  → 從頁面內嵌資料、已觀察回應或官方 API 取得 DASH playinfo
  → 找播放器容器和既有 <video>
  → 依設定與站內核心能力選擇：
      A. native-mse-player（全接管）
      B. native-range-transport（相容模式）
  → cdn-resolver 產生候選 URL、排序、退避與 ban
  → idm-downloader 切 Range、排程、驗證、重試、hedge、重組
  → A: 依 sidx segment 順序 append 到 SourceBuffer
     B: 合成原播放器期待的 206 Response / XHR 狀態與事件
  → stats / notices / debug report
```

### Playinfo 的取得與生命週期

`page-hook.js` 會：

- 在安裝時保存原生 `fetch`，之後覆寫 fetch/XHR 來旁聽 Bilibili 的 playurl 回應。
- 首屏可讀 `__playinfo__` / `__INITIAL_STATE__`，必要時從 script 文字抽 JSON。
- 沒拿到時呼叫官方 view API 取得 CID，再呼叫 playurl API 要最高規格 DASH 清單。
- 以 route key 快取 playinfo；route 包含 BV/av、分 P，互動影片還包含 branch CID，劇集則用 ep id。
- 晚到的舊 route 回應不能污染目前影片；同一 representation 若新回應的簽名 deadline 更早，也不能覆蓋較新的 URL。
- 簽名 URL 距到期兩分鐘時刷新；失敗用指數退避，不中斷現有播放。
- SPA 導航同時監聽 history、popstate、站內項目 click 與每秒健檢；所有非同步工作以 route generation / lifecycle / AbortController 防止舊工作落地。

這整段高度 Bilibili 專屬。rule34video 必須重寫「媒體發現、頁面身份、SPA 導航、URL 更新」部分。

## Range 下載內核

### `range-core.js`

提供無狀態基礎：

- 嚴格解析 `bytes=start-end` 與 `Content-Range: bytes start-end/total`
- 將 Range 均分成最多 512 塊，設最小塊大小
- 按順序合併 Uint8Array，總長不一致就丟錯
- 驗證 Bilibili 媒體 URL 與自訂 CDN host
- 正規化設定

最重要的安全不變量是：只接受 HTTPS、允許清單內的媒體網域/副檔名，且 signed URL 絕不能送到任意第三方 host。移植不能把 allowlist 直接放寬成「任何 URL」。

### `cdn-resolver.js`

Bilibili 的 signed path/query 能在同組 CDN host 間互換，所以 resolver 才能把 donor URL 換 host，並組合：

- 原始 base/backup URL
- 大陸節點、海外節點或使用者選擇的自訂節點
- 節點與檔案路徑層級的速度/成功紀錄
- 暫時 blocked、整段影片 banned 的節點/地址/節點＋地址 pair

節點選擇不是固定挑最快：warm-up 先廣泛測量；之後讓已測快節點主力承擔，同時留 exploration slot 給未測或 90 秒後測量過期的節點。快節點按平滑加權輪詢取得更多 piece；低於最快 1/12 的已測節點暫時不分主 piece。

ban 判斷特別區分：

- 節點對多個地址都失敗 → blame node
- 好節點只拒絕某地址 → blame address
- 某 node/address 組合特別不相容 → blame pair
- 無資料的失敗累積兩次才停用；有收到資料的中途失敗不直接當死節點

這個 host-swapping 能否移植，完全取決於 rule34video 媒體 CDN 的簽名是否與 host 無關。未經探測不得假設可換 host。

### `idm-downloader.js`

全頁 downloader 共用一個可動態調整上限的 `Semaphore`。佇列分三級：

1. critical：init/index、起步 probe
2. startup：起播 piece
3. ordinary：一般媒體 piece

同級再依固定 priority、播放 deadline 的緊迫度與等待 aging 排序，避免遠端預取壓住即將播放的資料，也避免老任務永遠被插隊。

每次 HTTP attempt：

- `GET` + 精確 `Range`
- `credentials: omit`、`cache: no-store`、CORS
- 首字節 5.5 秒、停傳 4 秒、單 attempt 15 秒
- 只接受狀態 206
- `Content-Range.start/end` 必須精確等於要求值
- response body 實收長度必須等於 piece 長度
- 每個讀取中的 reader 會跟 AbortSignal 綁定，取消後即釋放 slot

piece 層級機制：

- 最多 3 輪，整體 retry window 約 25 秒。
- 失敗或 hedge 前已收到的連續前綴若至少 32 KiB，就只請求缺少的尾部，再嚴格拼接。
- hedge 一般一次最多兩個副本競速，贏家回來後取消其餘。
- 有播放 deadline 時持續重算 ETA：沒資料、停傳、明顯慢於常態、估計趕不上播放，才動用有限 rescue slot。
- 沒有 deadline 的相容模式則沿用測得/固定 hedge delay。
- 啟動時先用 64 KiB 以上 probe 找到可用節點，再並行剩餘 piece，且以 `onOrderedChunk` 依序串流交付，不必等整個 segment 全部收完。
- 後續 chunk 大小依單連線速度自適應於 64 KiB～1 MiB，降低高 RTT 下的小請求成本。

自動併發階梯是 `8 → 12 → 16 → 24 → 32 → 48 → 64`：

- 新 session 至少先上 16，前向緩衝到 15 秒後逐級回到原基線。
- 卡頓、低緩衝且滿載、首字節慢會升級。
- 每次升級是 10 秒試驗；吞吐沒成長就退回並讓該檔休息 90 秒。
- 412/429 視為伺服器 pushback，降級且對該檔及以上休息 3 分鐘。
- 同頁換片保留已學到的基線，新 session 重置短期觀測。

## 全接管：`native-mse-player.js`

它重用原頁面的 `<video>` 和 UI，但用自己的 `MediaSource`：

- 從 playinfo 選瀏覽器支援的 video/audio representation。
- 畫面預設 codec 優先 AV1、HEVC、AVC；使用者的 Bilibili 播放策略可覆寫。
- 音訊優先符合站內選項，並處理普通、Hi-Res、Dolby 欄位。
- 讀 representation 的 `SegmentBase.Initialization` 與 `indexRange`。
- 單線競速下載 init/index，`sidx.js` 解析每個媒體 segment 的 byte 與時間範圍。
- video/audio 各一個 SourceBuffer；起播第一 segment 可按已排序 piece 漸進 append。
- 正常播放採滑動下載窗（video 3 segments、audio 4 segments），目標約 45 秒前向緩衝。
- 起播等待量會按實測下載吞吐 / 媒體 bitrate 動態選 2～8 秒；首次 segment 完成後已排下一段，才讓播放啟動。
- 每段 deadline 由 `segment.startTime`、`currentTime`、`playbackRate` 動態換算。
- 75 秒後逐步移除播放頭後 30 秒以前的 buffer。
- `QuotaExceededError` 先清舊 buffer、降低該 session 的 ahead limit；仍放不下則暫存完整 segment，等播放器消耗後再 append。
- seek 若目標不在 buffer，不重建 MediaSource；開新 generation、abort 舊下載/半寫 segment、把每軌 nextIndex 移到目標並重新補緩衝。
- quality/codec 改變才重開 session；保留時間、播放/暫停意圖、音量、靜音、倍速。
- 所有 append/remove 經每軌 Promise queue 串行，並用 session + generation 雙重檢查阻止舊結果落地。
- 致命錯誤會交回原生播放器，之後最多三次指數退避重新接管。

其中 `sidx` 方案只適合有可解析 MP4 sidx 的媒體。rule34video 若是單檔 MP4 且沒有可用 sidx，可考慮保留原生 progressive loader 攔截，或另外解析 MP4 box/sample table；不能假設 `SegmentBase` 存在。

### 與 Bilibili 原內核的協調（不可直接移植）

全接管還做了大量站點專屬修補：

- 等原生 MediaSource 建好 SourceBuffer 再接管，避免 Bilibili 誤記 codec failure。
- 接管期間停止站內 DASH schedule controller，防止重複下載。
- 交回原生時只恢復自己停掉的 scheduler。
- 攔截少數站內播放器殘留錯誤與錯誤 overlay。
- 對站內 quality menu / codec localStorage / audio choice 做同步。
- 真正播到新畫質後，回覆 Bilibili 內核等待的 quality rendered promise。
- 修正站內核心在 metadata 後把 currentTime 拉回舊位置的行為。
- 改寫 Bilibili「影片統計資訊」面板中的下載節點、速度與 segments。

rule34video 版不應攜帶這些 selector、私有 API 或 workaround，除非實測該站有對應問題。

## 相容模式：`native-range-transport.js`

只有建立相容模式 player 後才真正安裝 interception。它只接管非常保守的一小類請求：

- GET
- 已知媒體 URL
- 精確、有限的 `bytes=start-end`
- 沒有 include credentials
- headers 除 `Range` / `Accept` 外沒有別的特殊項
- XHR 必須 async、無 body、`responseType=arraybuffer`
- URL path 能對應到目前 playinfo 的某一 video/audio representation
- Bilibili 原生 DASH core 可取得且 quality guard 已掛上

下載仍走同一 resolver/downloader；完成後一次回傳完整合成 `Response(status=206)`。XHR 路徑保留原物件與 prototype，覆寫 instance accessors，依序模擬 `readystatechange`、`progress`、`load/error/timeout/abort/loadend`，再次 `open()` 時還原。

它之所以先收完整 Range 再 resolve fetch，是因為原播放器的 FetchLoader 可能吞掉 reader 中途錯誤；先驗完能避免把不完整 body 當成功。代價是比串流回傳多記憶體與等待時間。

quality guard 使用 Bilibili 私有 dash core，保證切畫質後已完成的 scheduler 能再啟動並正確發出 rendered 狀態。這部分不能移植；但保守的 fetch/XHR eligibility、206 合成與取消語意值得保留。

## 直播路徑（對 rule34video 點播大多不需要）

`live-core.js` + `live-hook.js` 只處理 fMP4 HLS：

- 屏蔽 Bilibili P2P SDK。
- 解除 smtcdns wrapper、把 P2P URL 改到官方節點。
- 解析 media m3u8、init map 與 `.m4s` segments。
- 依首字節時間和速度維護 host pool；主節點 400 ms、urgent 150 ms 後啟動第二份競速。
- 預取 playlist 已宣告的 segment（最多 3 片並行，播放器急需時降為 1），以及有限度猜下一片。
- 快取最多 32 片 / 45 秒；播放器 fetch segment 時回傳快取 Response，失敗就 fallback native fetch。
- 不接管 master playlist、TS、帶 Range 的 live segment。

除非 rule34video 的實際媒體是 HLS，第一版不要引入這條路徑。

## UI、狀態與診斷

- `settings-panel.js`：Shadow DOM modal、浮動按鈕、亮/暗/自動主題、自訂 CDN、debug 類別、診斷複製。
- `runtime-notices.js`：從播放器事件採樣，將播放/下載事件送到通知層。
- `notification-view.js`：Shadow DOM 卡片堆疊、debug/error 顯示、全螢幕重新掛載。
- `bridge.js`：清洗 stats 與錯誤，建立可重試錯誤卡，協調 storage/message。
- `page-hook.js`：維護 active transfer、總速率、CDN health、buffer ahead、接管錯誤，提供 `__biliThreadRipperDebug.report()`；報告刻意不含 Cookie、token、完整 signed URL。

後續 rule34video 版應一開始就保留最小 debug API：媒體類型、原始/目前 URL 的 host（不含 query）、Range 是否被接管、Range 驗證結果、併發數、總速率、fallback 原因。這比先搬完整 UI 更重要。

## 模組可重用性

| 模組 / 思路 | 可重用程度 | 移植處理 |
| --- | --- | --- |
| userscript build + page-world injection | 高 | 改 metadata、命名與 iframe 規則 |
| GM storage shim / bridge | 高 | 改 prefix、channel、settings schema |
| Range parse/split/concat | 高 | 改媒體 URL allowlist |
| Semaphore、priority、deadline、retry、resume、hedge | 很高 | 抽成站點無關 downloader；先維持驗證不變量 |
| auto concurrency | 高 | 可先關閉，基線穩定後啟用 |
| CDN resolver health / weighted assignment | 中高 | 候選 URL 來源與 host swap 必須由實測決定 |
| fetch/XHR 206 合成 | 高 | 重新定義 eligibility 與 track 對應 |
| MP4 sidx parser | 高但條件式 | 只有檔案真的有 sidx 才用 |
| MSE session/buffer/seek/quota 策略 | 中高 | 需按 rule34video 的容器、格式、codec 重接 |
| Bilibili playinfo/API/route/quality glue | 不可重用 | 全部重寫 |
| Bilibili native scheduler/quality workaround | 不可重用 | 不帶過去 |
| live HLS 模組 | 條件式 | 只有目標站使用 fMP4 HLS 才考慮 |
| settings / notices UI | 中 | 可後移，先做功能與 diagnostics |

## rule34video 開工前必做的實測

不能只看 DOM 裡一個 `<video src>` 就開始寫。要在真實影片頁記錄以下事項：

1. `<video>` 的 `src/currentSrc` 是直鏈、blob，還是空值。
2. DevTools Network 中實際是 MP4 Range、HLS `.m3u8/.ts/.m4s`、DASH `.mpd/.m4s`，或其他 loader。
3. 播放器使用 `fetch`、XHR、原生 `<video src>`，還是 Service Worker。
4. 媒體 response 的 `Accept-Ranges`、`Content-Length`、`Content-Range`、CORS headers。
5. 跨來源 JS `fetch` 帶 Range 是否成功；userscript page context 與 `GM_xmlhttpRequest` 的可用性不同，後者若使用會改變架構。
6. 一個播放器 Range 通常多大、是否 bounded、是否會 open-ended (`bytes=N-`)。
7. URL 是否有時效 token；過期方式、刷新來源、是否和 Cookie / Referer 綁定。
8. 同一媒體有沒有多個 mirror/quality URL；只換 hostname 是否仍 206 且 bytes 完全一致。
9. MP4 是否含 `sidx`；若沒有，原播放器是否本來就能自然 seek/Range。
10. 頁面是否 SPA、切片/換畫質是否重建 video、是否有多個 video（預覽、廣告）。
11. CSP 是否阻擋 script element；Violentmonkey 的 `GM_addElement` 能否注入主世界。
12. 網站條款與負載限制；併發需保守，遇 429/403 立即退避。

探測時不要把帶 token 的完整媒體 URL寫進文件、console dump 或 issue。

## 建議的實作順序

1. 新建獨立的 rule34video userscript 目錄與 build metadata，不修改生成的 BTR userscript。
2. 先只做 `document-start` 媒體探測與安全診斷，不接管流量。
3. 若是 progressive MP4 bounded Range：先做單 host、固定 4～8 併發的 fetch/XHR 相容攔截。
4. 保留嚴格 206/Content-Range/長度驗證，任一異常立刻 fallback 原請求。
5. 驗證 seek、暫停、倍速、切畫質、換頁、abort 與多次 `open()`。
6. 再加入 retry、斷點續傳、hedge 與 priority。
7. 只有確認存在可互換 CDN，才加入多 host resolver；沒有 mirror 時，多線仍可在同一 host 上切不同 Range。
8. 觀察伺服器限流後再加入自動併發，預設上限不應直接照搬 64。
9. 只有原播放器攔截不可行或確有收益時，再做完整 MSE 接管。
10. 最後補設定面板、浮動按鈕、通知與 release 流程。

第一個可驗收版本的最低標準：

- 關閉腳本完全不影響原站。
- 只攔截目標 video 的媒體請求，不碰縮圖、廣告、API 或其他分頁資源。
- seek/換片會取消舊工作，舊 bytes 絕不交給新影片。
- Range 必須逐段精確驗證；不完整資料不交給播放器。
- 失敗可安全 fallback，且不形成「原請求 + 加速請求」長時間雙重下載。
- 不外傳 Cookie、token、影片內容，不把 signed query 放進診斷。

## 基底中的關鍵踩坑清單

- page-world 與 userscript sandbox 不是同一個 global。
- 安裝 hook 的先後順序會影響保存到的 `nativeFetch` / XHR wrapper chain。
- 請求取消後必須取消 reader，否則 slot 看似釋放但網路仍在下載。
- hedge 複本應從真正取得 slot 後才計時，不能把排隊時間當下載慢。
- 不可因為一個 403 就 ban 整個 host；可能只是簽名地址不被該節點接受。
- 重試/hedge 保留的 bytes 必須是連續前綴，而且來源 Range 已經驗證。
- 並行完成不等於可亂序交付；播放器或 SourceBuffer 需要 byte order。
- SPA 中舊非同步回應很容易污染新影片，route generation 與 abort 缺一不可。
- URL 簽名刷新回應可能亂序，deadline 更舊的結果不能覆蓋新的。
- MSE append/remove 必須串行；seek 後舊 generation 的結果不能碰新狀態。
- `QuotaExceededError` 不等於影片壞了，先清理舊 buffer、降低 ahead window。
- 接管原 `<video>` 時要保留播放意圖、currentTime、volume、muted、playbackRate。
- 相容 fetch 的 streaming body 可能讓原 loader 吞掉中途錯誤；完整驗證後再 resolve 較安全。
- 不要假設 CDN hostname 可互換；這是站點/CDN 的性質，不是 Range 技術本身保證的。

## 測試與目前基線

基底沒有 npm dependency；`npm test` 依序跑 Node 單元/模擬測試與 Playwright 瀏覽器測試。2026-10-14 在目前工作環境執行結果：

- 通過：`shared-core-test`、`vod-selection-test`、`auto-concurrency-test`、`live-core-test`、`optimization-test`
- 未能啟動：`notification-smoke-test`、`notification-error-test`、`userscript-test`、`regression-smoke-test`
- 原因：環境缺少 `playwright` module；不是瀏覽器 assertion failure
- 真實 Bilibili 網路測試因沒有設定 `BTR_TEST_BVID` / `BTR_TEST_CID` 而跳過

常用命令：

```powershell
cd Bilibili-thread-ripper
node scripts/build.mjs
npm test
```

不要直接修改 `user_scripts/bilibili-thread-ripper.user.js`，它是打包產物。基底原始碼版本使用 `__BTR_VERSION__` placeholder，build 時才替換。

## 主要檔案索引

- `Bilibili-thread-ripper/user_scripts/adapter/meta.json`：userscript header、模組順序
- `Bilibili-thread-ripper/user_scripts/adapter/loader.js`：sandbox → page-world 注入與 GM storage server
- `Bilibili-thread-ripper/user_scripts/adapter/storage-shim.js`：最小 chrome.storage 相容層
- `Bilibili-thread-ripper/scripts/build.mjs`：零依賴串接打包
- `Bilibili-thread-ripper/src/range-core.js`：Range 與設定基礎
- `Bilibili-thread-ripper/src/cdn-resolver.js`：候選 URL、節點評分與 ban
- `Bilibili-thread-ripper/src/idm-downloader.js`：併發排程、retry/resume/hedge、自動線程
- `Bilibili-thread-ripper/src/sidx.js`：MP4 sidx 解析與時間定位
- `Bilibili-thread-ripper/src/native-mse-player.js`：全接管 MSE 播放
- `Bilibili-thread-ripper/src/native-range-transport.js`：相容模式 fetch/XHR 206 transport
- `Bilibili-thread-ripper/src/page-hook.js`：Bilibili 點播整合、SPA、playinfo、生命週期
- `Bilibili-thread-ripper/src/live-core.js` / `live-hook.js`：fMP4 HLS 直播
- `Bilibili-thread-ripper/src/bridge.js`：設定與狀態橋接
- `Bilibili-thread-ripper/src/settings-panel.js`：設定 UI
- `Bilibili-thread-ripper/src/runtime-notices.js` / `notification-view.js`：通知與採樣
- `Bilibili-thread-ripper/dev/`：單元、模擬、fixture、瀏覽器與網路 smoke tests

## 下一輪工作的起點

下一步不是立刻複製 BTR 並全域替換名稱，而是先對一個 rule34video 真實影片頁做「媒體傳輸剖面」。拿到上面 12 項實測結果後，再決定：

- progressive MP4 + bounded Range → 優先做相容 transport；
- HLS → 做 playlist/segment cache 與有限競速；
- DASH + SegmentBase/sidx → 才考慮沿用完整 MSE 路徑；
- 單一不可跨域媒體 URL → 可能需要 userscript manager 的跨域 request 能力，不能直接使用 BTR 的 page `fetch` 架構。

這份筆記的核心原則：**重用已驗證的 Range 排程與生命週期不變量，重寫所有站點識別與媒體來源假設。**
