# Rule34Video Thread Ripper

這是一個以 Violentmonkey／Edge 為第一目標的輕量 userscript。它沿用網站播放器已取得的有效影片網址，逐一驗證最多三個 Boomio CDN，並以有限並行的 HTTP Range 請求填充 MediaSource。

## 安裝開發版

1. 執行 `npm install`。
2. 執行 `npm run check`。
3. 在 Violentmonkey 建立新腳本，貼入 `dist/rule34video-thread-ripper.user.js` 全文並儲存。

預設為 4 線程。可從 Violentmonkey 的腳本選單調為 1–8；建議保持 3–4。收到 HTTP 429 時，當次播放會自動暫降為單線程。插件只緩衝播放所需資料，不做爬站或批次下載。

選擇 Violentmonkey 選單中的「輸出本次效能統計」，可在 Console 查看總下載量、只計下載中的合計速度、實際並行峰值、播放停頓、跳轉恢復時間，以及各 CDN 的近似 TTFB、速度和 cache HIT 次數。這些統計完全沿用正常播放請求，不會額外探測 CDN。

`0.3.0` 起，CDN 分配會在單一影片內依正式 Range 的實際速度自適應：明顯較快的節點可同時承擔多個線程；慢節點不會永久排除，而是每隔數批取得最少 256 KiB 的播放資料重新測試。速度樣本超過 90 秒後失效，恢復的節點可立即重新加入。`cache HIT` 只供觀察，不會蓋過實際速度。

## 行為與限制

- 只匹配 `https://rule34video.com/video/*`。
- 只採用通過 `206`、總長度與首段雜湊驗證的 CDN。
- 候選為實際轉址節點及其相鄰編號 `N+1`、`N-1`，最多驗證三個，不掃描整個 CDN 編號空間。
- 只保留約 30 秒的向前緩衝；若流程失敗，會自動還原網站原生播放。
- Console 的每批訊息會列出合計速度、實際並行峰值，以及各 range 使用的 CDN、近似 TTFB、速度與 cache 狀態。
- CDN、token 或網站播放器日後改版都可能影響相容性。降低線程只能減少請求壓力，無法保證網站不會限流或封鎖 IP。

## 授權

本專案程式碼採 MIT License。產出的 userscript 內含 [MP4Box.js](https://github.com/gpac/mp4box.js) 2.4.1（BSD-3-Clause）；完整第三方聲明見 `THIRD_PARTY_NOTICES.md`。
