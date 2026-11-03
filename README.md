# 里程碑請款權信託（Ethereum Sepolia）

業主把工程款全額鎖進信託，每一期里程碑是一張請款權 NFT。承包商可以把某一期整張賣斷給投資人提前周轉；監造方核准後，合約自動撥款給當下的持有人。

完整規則見 `SPEC.md`。

| 結果 | 持有人拿到 | 業主拿到 |
|---|---|---|
| 如期完工 | 全額 | 0 |
| 延誤完工（寬限期內申報） | 全額 − 違約金（每日 0.1%，上限 20%） | 違約金 |
| 工程終止（超過寬限期） | 全額 × 完成比例 | 剩餘款項 |

## 檔案

```
contracts/MockUSDC.sol        本地測試用代幣（Sepolia 上的交易幣種是 MTK），手寫 ERC-20，任何人可 mint，6 位小數
contracts/MilestoneTrust.sol  信託 + 手寫 ERC-721 + 市集 + 狀態機
frontend/index.html           單一 HTML 前端（ethers.js v6 + MetaMask）
test/contract.test.js         合約測試：跑規格 12.1 的 13 步與邊界情況
test/frontend.e2e.js          前端端到端測試：用瀏覽器實際操作頁面
```

## 一、準備 MetaMask（約 15 分鐘）

1. **另外建立一個測試專用錢包**，不要用存有真實資產的錢包。
2. 建立 6 個帳號並改名：E 機率來源（兼部署者與 demo 管理員）、A 業主、B 承包商、C 監造方、D 投資人、F 二號投資人。
3. 網路切換到 Sepolia（chain ID 11155111）。
4. 到 Sepolia faucet（例如 Google Cloud Web3 Faucet 或 Alchemy）領 Sepolia ETH 到帳號 E（留約 0.05 ETH），再從 E 轉約 0.02 ETH 給其他 4 個帳號付 gas。

## 二、部署

交易幣種是課堂代幣 MTK（`0x9cDF42E5680b0ac33ce51B1132Cb1856684Fd208`，18 位小數）。MTK 只有 owner 能 mint，請先從持有 MTK 的錢包轉給 A、D，並在 MetaMask 匯入這個代幣地址。

**建議用腳本**（需要先 `cd test && npm install`，並把 `.env.example` 複製成 `.env` 後填入）：

```bash
node scripts/deploy.js --local   # 先在本地 ganache 跑一次，不花錢
node scripts/deploy.js           # 部署到 Sepolia，完成後自動執行 prepare.js
node scripts/deploy.js --practice  # 另外部署實操用合約，寫入 deployment.practice.json，不動正式版
node scripts/deploy.js --env live_2  # 另外部署備用合約，網址 ?env=live_2，不動其他版本
node scripts/prepare.js          # prepare 中斷時可單獨重跑，已完成的步驟會略過
```

地址、部署區塊和前端網址會寫進 `deployment.json`。

**或手動用 Remix**：

1. 開啟 https://remix.ethereum.org ，新增 `MilestoneTrust.sol`，貼上 `contracts/` 的內容。
2. Solidity Compiler：版本選 `0.8.24`，開啟 Optimization（200），編譯。
3. Deploy & Run：Environment 選 **Injected Provider - MetaMask**，MetaMask 切到帳號 E。
5. 部署 `MilestoneTrust`，建構子參數依序填：

   | 參數 | 值 | 說明 |
   |---|---|---|
   | `usdc_` | `0x9cDF42E5680b0ac33ce51B1132Cb1856684Fd208` | 交易幣種 MTK |
   | `oracle_` | 帳號 E 的地址 | 只有它能設定完工機率與快轉時間 |
   | `day_` | `86400` | 真實的 1 天；demo 靠時間快轉，不靠縮短一天 |
   | `grace_` | `5184000` | 寬限期 60 天 |

6. 在 Sepolia Etherscan 查到 MilestoneTrust 的部署區塊號碼，前端稽核紀錄會從這裡開始讀。
7. （選做）在 Etherscan 驗證合約原始碼，評審就能直接在 Etherscan 上讀到函式。

## 三、開啟前端

MetaMask 不會注入到直接打開的本機檔案，所以要用網址開啟：

```bash
cd frontend
python3 -m http.server 8000
```

瀏覽器開啟（把三個值換成你的）：

```
http://localhost:8000/?usdc=<MTK 地址>&trust=<MilestoneTrust 地址>&from=<部署區塊>
```

也可以把 `frontend/index.html` 放到 GitHub Pages，用同樣的參數開啟。地址會記在瀏覽器裡，之後不用再輸入。

## 四、11/3 demo 劇本

合約內所有時間都讀「合約時間」（`block.timestamp + timeOffset`）。demo 管理員（帳號 E）可以用頁面上的合約時鐘快轉，讓 10 分鐘的報告能展示延誤與終止。時間只能往前，彩排過的合約無法倒退，所以正式 demo 要用乾淨的部署。

**報告前一晚（11/2）**

1. 執行 `node scripts/deploy.js`：重新部署乾淨的合約（彩排時的快轉不能倒退），並讓 D 授權 30,000。A 至少要有 90,000 MTK、D 至少要有 30,000 MTK，不足時腳本會在送交易前停止。專案不預建，由 A 在 demo 開始時於頁面設定期數、金額、間隔天數後建立。
2. 錄一支完整 demo 影片作為網路不穩時的備案（用另一份部署，不要動正式 demo 用的合約）。

**現場操作（13 到 14 筆交易，約 2.5 到 4.5 分鐘）**

| 步驟 | 帳號 | 操作 | 交易 | 觀眾看到 |
|---|---|---|---|---|
| 0 | A 業主 | 確認期數、金額、間隔天數後建立專案 | 2 | 工程款鎖進信託，出現里程碑卡片，表單消失 |
| 1 | E 機率來源 | 第 3 期 p 設為 99 | 1 | 卡片變成「可交易」 |
| 2 | B 承包商 | 第 3 期以 29,480 上架 | 1 | 看得到建議價約 29,480，上架後卡片顯示售價 |
| 3 | D 投資人 | 購買（已事先授權） | 1 | MTK 與 NFT 同一筆交換，持有人變成 D |
| 4 | D 投資人 | 以 29,600 再上架 | 1 | 卡片顯示新的售價 |
| 5 | F 二號投資人 | 購買（第一次會多一筆授權） | 1 到 2 | 持有人變成 F，D 收到 29,600 |
| 6 | E 機率來源 | 第 3 期 p 調到 60 | 1 | 卡片變成「不可轉讓」 |
| 7 | F 二號投資人 | 嘗試上架 | 0 | 按鈕停用，說明原因 |
| 8 | C 監造方 | 第 1 期回報進度 70% | 1 | 稽核紀錄出現進度 |
| 9 | E demo 管理員 | 快轉到第 3 期期限後 2 天 | 1 | 合約時鐘跳到期限後 2 天 |
| 10 | B 承包商 | 申報第 3 期完工 | 1 | 卡片顯示延誤 2 天、違約金 60 |
| 11 | C 監造方 | 核准第 3 期 | 1 | F 收到 29,940，業主收到 60；撥款跟著當下持有人走 |
| 12 | C 監造方 | 終止第 1 期（預填 70%） | 1 | 承包商 14,000，業主 6,000 |

以上數字以表單預設值為準（第 25、55、90 天到期）。快轉天數 = 第 3 期剩餘天數（無條件進位）+ 2，所以不管專案是多久前建立的，都會延誤 2 天。第 1 期（25 + 60 = 85 天）此時已超過寬限期，可以終止；如果調整期數或間隔，要確認要終止的那一期期限加 60 天不超過快轉後的時間。

駁回再申報、拖延核准不增加違約金，保留在合約與自動測試中，現場改為口頭說明。

切換帳號：在 MetaMask 換帳號，頁面會自動重新讀取角色與按鈕。

**現場備案**：Sepolia 偶爾會塞車，交易要等 15 到 30 秒。網路不穩時改播事先錄好的影片。

## 五、尚待工程師確認的設計（目前的預設做法）

| 問題 | 目前做法 | 理由 |
|---|---|---|
| 私下轉讓會繞過機率門檻嗎 | 所有轉讓都經過 `_transfer`，一律檢查 | 包含 `transferFrom`，門檻無法繞過 |
| 撥款用推送還是拉取 | 推送：核准時直接轉給持有人 | 一張 NFT 只有一位持有人，較單純 |
| 重入防護 | 先改狀態再轉錢，加上手寫 `nonReentrant` | 雙重保護 |
| 監造方消失 | 尚未處理，資金可能卡住 | 列為已知限制，待討論 |
| 監造方的持有限制範圍 | 只限自己監造的專案；機率來源則是全部 | 全域名單會讓任何人花極少的錢就能封鎖別人的地址 |
| 時間快轉 | 課堂 demo 專用，正式版本會移除 | 真實世界沒有人能加快時間 |
| 寬限期 60 天 | 違約金最多 6%，20% 上限是契約保護條款 | 讓「平均延誤 30 天」的定價假設在合約規則內成立 |
| 開發工具 | Remix 部署、Node.js 本地測試 | 不需另外建置開發環境 |

另外兩個細節：
- **申報被駁回後**：回到 Active，`claimedAt` 歸零；延誤天數以最後被核准的那次申報計算。
- **買方防改價**：`buy(id, maxPrice)` 多一個上限參數，賣方在買方送出交易後改價，交易會失敗。

## 六、本地測試

```bash
cd test
npm install
npm test        # 合約
npx playwright install chromium
npm run e2e     # 前端
```

## 七、安全注意

- 私鑰與 RPC 網址只放在 `.env`，它已被 `.gitignore` 排除，不要上傳。
- 只使用測試專用錢包與測試網，不要放有真實資產的帳號。
- 合約未經第三方審計，時間快轉 `advanceTime` 只供課堂 demo，不要用於正式環境。
- `frontend/deployments.json` 只有合約與錢包的公開地址，沒有機密。
