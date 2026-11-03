// 前端端到端測試：ganache（chainId 11155111）+ 假 MetaMask + Playwright 操作真實頁面
const fs = require("fs"), path = require("path"), http = require("http");
const solc = require("solc"), ganache = require("ganache"), { ethers } = require("ethers");
const { chromium } = require("playwright");

const ROOT = process.argv[2];
const SRC = path.join(ROOT, "contracts"), HTML = path.join(ROOT, "frontend", "index.html");
const files = ["MockUSDC.sol", "MilestoneTrust.sol"];
const out = JSON.parse(solc.compile(JSON.stringify({ language: "Solidity",
  sources: Object.fromEntries(files.map(f => [f, { content: fs.readFileSync(path.join(SRC, f), "utf8") }])),
  settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "shanghai", outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } } })));
const art = (f, c) => out.contracts[f][c];

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(c ? "  ✓" : "  ✗", m); };

(async () => {
  const server = ganache.server({ logging: { quiet: true }, chain: { chainId: 11155111, hardfork: "shanghai" }, wallet: { totalAccounts: 6 } });
  await server.listen(8545);
  const rpc = new ethers.JsonRpcProvider("http://127.0.0.1:8545", 11155111);
  const accts = await rpc.send("eth_accounts", []);
  const [E, A, B, C, D] = accts;
  const signer = await rpc.getSigner(E);
  const dep = async (c, ...args) => { const x = await new ethers.ContractFactory(c.abi, "0x" + c.evm.bytecode.object, signer).deploy(...args); await x.waitForDeployment(); return x.getAddress(); };
  const usdc = await dep(art("MockUSDC.sol", "MockUSDC"));
  const trust = await dep(art("MilestoneTrust.sol", "MilestoneTrust"), usdc, E, 86400, 5184000);

  // 靜態伺服器提供 index.html
  const web = http.createServer((req, res) => { res.setHeader("content-type", "text/html; charset=utf-8"); res.end(fs.readFileSync(HTML)); }).listen(8080);

  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  // ethers CDN 改由本地檔案提供（沙盒無法連外）
  await page.route("**/ethers.umd.min.js", r => r.fulfill({ contentType: "application/javascript",
    body: fs.readFileSync(path.join(__dirname, "node_modules/ethers/dist/ethers.umd.min.js")) }));
  // 假 MetaMask：把 RPC 轉發到 ganache，帳號由 window.__acct 決定
  await page.addInitScript(() => {
    window.__acct = null;
    const listeners = {};
    window.ethereum = {
      isMetaMask: true,
      on: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); },
      __emit: (ev, ...args) => (listeners[ev] || []).forEach(fn => fn(...args)),
      async request({ method, params }) {
        if (method === "eth_requestAccounts" || method === "eth_accounts") return [window.__acct];
        if (method === "wallet_switchEthereumChain" || method === "wallet_addEthereumChain") return null;
        if (method === "wallet_requestPermissions") {
          window.__permCalls = (window.__permCalls || 0) + 1;
          if (window.__pendingPerm) { const e = new Error("Request of type 'wallet_requestPermissions' already pending"); e.code = -32002; throw e; }
          if (window.__holdPerm) await new Promise(r => { window.__releasePerm = r; });
          if (window.__rejectPerm) { const e = new Error("User rejected the request."); e.code = 4001; throw e; }
          return [{ parentCapability: "eth_accounts" }];
        }
        if (method === "eth_sendTransaction") params = [{ ...params[0], from: window.__acct }];
        const r = await fetch("http://127.0.0.1:8545", { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params: params || [] }) });
        const j = await r.json();
        if (j.error) { const e = new Error(j.error.message); e.code = j.error.code; e.data = j.error.data; throw e; }
        return j.result;
      },
    };
  });
  await page.goto(`http://127.0.0.1:8080/?usdc=${usdc}&trust=${trust}&from=0`);
  const as = async a => { await page.evaluate(x => { window.__acct = x; }, a); await page.click("#btnConnect"); await page.waitForTimeout(700); };
  const waitToast = async text => { await page.waitForSelector(`.toast:has-text("${text}")`, { timeout: 20000 }); await page.waitForTimeout(500); };
  const card = id => page.locator(".ms", { hasText: `#${id}・` });
  const clearToasts = () => page.evaluate(() => { document.getElementById("toast").innerHTML = ""; });
  const clockTs = async () => Number(await page.getAttribute("#clockNow", "data-ts"));
  const fastForward = async (label, doneText) => { await page.locator("#clockAdmin button", { hasText: label }).click(); await waitToast(doneText); };

  console.log("連接錢包");
  await as(A);
  ok(await page.evaluate(() => (window.__permCalls || 0)) === 0, "第一次連線不用另外要求權限");
  ok((await page.textContent("#btnConnect")) === "授權／切換帳號", "連線後按鈕仍可使用，文字改為授權／切換帳號");
  await page.click("#btnConnect"); await page.waitForTimeout(500);
  ok(await page.evaluate(() => window.__permCalls) === 1, "已連線後按按鈕會開啟 MetaMask 帳號選擇");
  await page.evaluate(() => { window.__rejectPerm = true; });
  await page.click("#btnConnect"); await waitToast("你取消了 MetaMask 的操作");
  await page.evaluate(() => { window.__rejectPerm = false; });
  ok((await page.textContent("#acct")).length > 0, "取消授權後維持原本的連線");
  await page.evaluate(() => { window.__pendingPerm = true; });
  await page.click("#btnConnect"); await waitToast("MetaMask 還有視窗等待處理");
  await page.evaluate(() => { window.__pendingPerm = false; window.__holdPerm = true; });
  ok(await page.isEnabled("#btnConnect"), "提示後按鈕恢復可按");
  await page.click("#btnConnect"); await page.waitForTimeout(200);
  ok(await page.isDisabled("#btnConnect"), "授權視窗開著時，按鈕暫時停用");
  await page.evaluate(() => { window.__holdPerm = false; window.__releasePerm(); }); await page.waitForTimeout(500);
  ok(await page.isEnabled("#btnConnect"), "視窗處理完，按鈕恢復可按");
  await page.evaluate(x => { window.__acct = x; window.ethereum.__emit("accountsChanged", [x]); }, D); await page.waitForTimeout(700);
  ok((await page.textContent("#acct")).toLowerCase() === (D.slice(0, 6) + "…" + D.slice(-4)).toLowerCase(), "MetaMask 切換帳號時，頁面自動更新");
  ok(await page.evaluate(() => window.__permCalls) === 4, "自動更新時不會跳出授權視窗");
  await page.evaluate(x => { window.__acct = x; }, B); await page.waitForTimeout(3000);
  ok((await page.textContent("#acct")).toLowerCase() === (B.slice(0, 6) + "…" + B.slice(-4)).toLowerCase(), "沒收到事件時，也會在幾秒內跟上 MetaMask 目前的帳號");
  // 舊帳號的連線較晚完成：不能蓋掉最新的帳號
  const finalAcct = await page.evaluate(async ([oldA, newA]) => {
    const real = window.ethereum.request, slow = { value: true };
    window.ethereum.request = async function (a) {
      if (a.method === "eth_requestAccounts" && slow.value) { slow.value = false; await new Promise(r => setTimeout(r, 400)); return [oldA]; }
      return real.call(this, a);
    };
    window.__acct = oldA;
    const first = connect();
    await new Promise(r => setTimeout(r, 50));
    window.__acct = newA;
    await connect();
    await first;
    window.ethereum.request = real;
    return S.account;
  }, [C, D]);
  ok(finalAcct.toLowerCase() === D.toLowerCase(), "連續切換時，較慢回來的舊帳號不會蓋掉新帳號");
  await page.evaluate(() => window.ethereum.__emit("accountsChanged", [])); await page.waitForTimeout(300);
  ok((await page.textContent("#btnConnect")) === "連接 MetaMask" && (await page.textContent("#netBadge")) === "未連線", "網站被取消授權時顯示未連線");
  await as(A);
  ok((await page.textContent("#netBadge")) === "Sepolia", "網路顯示 Sepolia");
  ok((await page.textContent("#params")).includes("1 天 = 86400 秒"), "讀到 DAY 參數");
  ok((await page.textContent("#clockNow")) !== "–" && await clockTs() > 0, "所有人都看得到合約時鐘");
  ok(!(await page.locator("#clockAdmin").isVisible()), "非 demo 管理員看不到快轉按鈕");
  ok((await page.textContent("#clockNote")).includes("僅供課堂 DEMO 使用") && (await page.textContent("#clockNote")).includes("demo 管理員"), "業主看得到快轉僅 DEMO 用，以及由誰操作");

  console.log("定價假設的參考表格");
  const refText = () => page.textContent("#priceRef");
  const ref0 = await refText();
  ok(ref0.includes("如期84.15%") && ref0.includes("延誤14.85%") && ref0.includes("終止1%"), "參考表格顯示三個情境的機率");
  ok(ref0.includes("期望值29,776") && ref0.includes("時間折現") && /建議價29,4[78]\d/.test(ref0), "參考表格的期望值 29,776、建議價約 29,480");
  await page.fill("#asTermDone", "50");
  ok((await refText()).includes("期望值29,716"), "調整假設後，參考表格即時更新");
  await page.fill("#asTermDone", "70");

  console.log("業主領幣並建立專案");
  await page.click("#btnMint"); await waitToast("領取測試 mUSDC：完成");
  ok((await page.textContent("#balUsdc")) === "100,000", "業主餘額 100,000");
  console.log("建立專案表單：期數、金額、間隔天數");
  const rows = () => page.locator("#cpRows > div").count();
  ok(await rows() === 3 && (await page.textContent("#cpTotal")) === "90,000", "預設 3 期，合計 90,000");
  const rowText = n => page.locator("#cpRows > div").nth(n).textContent();
  ok((await rowText(0)).includes("距今幾天") && (await rowText(1)).includes("距上一期幾天"), "第 1 期距今、之後距上一期");
  ok((await rowText(0)).includes("第 25 天到期") && (await rowText(1)).includes("第 55 天到期") && (await rowText(2)).includes("第 90 天到期"), "累計到期日 25、55、90 天");
  await page.locator(".cp-days").nth(1).fill("40");
  ok((await rowText(1)).includes("第 65 天到期") && (await rowText(2)).includes("第 100 天到期"), "改間隔天數，後面的到期日跟著更新");
  await page.locator(".cp-days").nth(1).fill("30");
  await page.click("#btnAddRow");
  ok(await rows() === 4 && (await page.textContent("#cpTotal")) === "120,000" && (await rowText(3)).includes("第 4 期"), "新增一期：多一列，合計與期別更新");
  for (let i = 0; i < 6; i++) await page.click("#btnAddRow");
  ok(await rows() === 10, "可以加到 10 期");
  await page.click("#btnAddRow"); await waitToast("每個專案最多 10 期");
  ok(await rows() === 10, "第 11 期加不上去");
  for (let i = 0; i < 7; i++) await page.locator("#cpRows button", { hasText: "移除" }).last().click();
  ok(await rows() === 3 && (await page.textContent("#cpTotal")) === "90,000", "移除：回到 3 期，合計更新");
  await page.fill("#cpContractor", B); await page.fill("#cpAttester", C);
  await page.locator(".cp-face").first().fill("");
  await clearToasts(); await page.click("#btnCreate"); await waitToast("每期面額必須");
  ok(true, "面額空白時顯示原因，不會沒反應");
  await page.locator(".cp-face").first().fill("20000");
  await page.locator(".cp-days").first().fill("0");
  await clearToasts(); await page.click("#btnCreate"); await waitToast("每期的間隔必須大於 0 天");
  ok(true, "間隔天數為 0 時顯示原因");
  await page.locator(".cp-days").first().fill("25");
  await clearToasts();
  await page.fill("#cpContractor", A); await page.fill("#cpAttester", C);
  await page.click("#btnCreate"); await waitToast("業主不能同時是承包商");
  ok(await page.locator(".ms").count() === 0, "業主填自己當承包商：失敗且顯示中文原因");
  await page.fill("#cpContractor", B); await page.fill("#cpAttester", C);
  await page.click("#btnCreate"); await waitToast("建立信託專案：完成");
  ok(await page.locator(".ms").count() === 3, "出現 3 張里程碑卡片");
  ok((await card(1).textContent()).includes("20,000 mUSDC") && (await card(2).textContent()).includes("40,000 mUSDC") && (await card(3).textContent()).includes("30,000 mUSDC"), "每期金額不同");
  ok((await card(1).textContent()).includes("剩 25") && (await card(2).textContent()).includes("剩 55"), "每期期限不同");
  ok((await page.textContent("#roles")).includes("業主"), "角色顯示業主");
  ok(!(await page.locator("#secCreate").isVisible()), "建立專案後，業主也看不到表單（不會多建一組）");
  const secondTry = await page.evaluate(async () => { await createProject(); return document.getElementById("toast").textContent; });
  ok(secondTry.includes("這份合約已經有專案") && await page.locator(".ms").count() === 3, "就算直接呼叫也不會建立第二個專案");

  console.log("機率來源設定 p，承包商上架");
  await as(E);
  await card(3).locator("input[id^=p-]").fill("99");
  await card(3).locator("button", { hasText: "設定完工機率" }).click(); await waitToast("設定 #3 完工機率：完成");
  ok((await card(3).textContent()).includes("可交易"), "#3 顯示可交易");
  ok(await card(3).locator("summary", { hasText: "定價試算表" }).count() === 0, "機率來源的卡片沒有定價試算表");
  await as(A);
  ok((await card(3).textContent()).includes("可交易（持有人才能上架）") && await card(3).locator("button", { hasText: "上架賣斷" }).count() === 0, "業主看到可交易時，同時說明只有持有人能上架");
  await as(B);
  ok(!(await card(3).textContent()).includes("持有人才能上架") && await card(3).locator("button", { hasText: "上架賣斷" }).count() === 1, "持有人看得到上架按鈕，不顯示這句說明");
  await card(3).locator("summary", { hasText: "定價試算表" }).click();
  const table = () => card(3).locator("details.pricing").textContent();
  const tt = await table();
  ok(tt.includes("如期84.15%") && tt.includes("延誤14.85%") && tt.includes("終止1%"), "試算表三個情境的機率正確");
  ok(tt.includes("25,245") && tt.includes("4,321") && tt.includes("期望值29,776"), "試算表加權與期望值正確");
  ok(tt.includes("時間折現") && tt.includes("建議價"), "試算表有時間折現與建議價");
  const suggested = Number((/建議價([\d,]+)/.exec(tt) || [])[1]?.replace(/,/g, ""));
  ok(suggested >= 29470 && suggested <= 29490, `面額 30,000、p = 99、距期限 90 天，建議價約 29,480（實際 ${suggested}）`);
  await page.click("#btnReload"); await page.waitForTimeout(700);
  ok(await card(3).locator("details.pricing table").isVisible(), "重新整理後試算表維持展開");
  ok(await card(1).locator("details.pricing table").isVisible() === false, "其他卡片的試算表預設收合");
  await as(B);
  await card(3).locator("input[id^=price-]").fill("30000.01");
  await clearToasts(); await card(3).locator("button", { hasText: "上架賣斷" }).click(); await waitToast("售價不能高於面額 30,000");
  ok(!(await card(3).textContent()).includes("上架價格"), "高於面額的售價不會送出");
  await card(3).locator("input[id^=price-]").fill("29480");
  await card(3).locator("button", { hasText: "上架賣斷" }).click(); await waitToast("上架 #3：完成");
  ok((await card(3).textContent()).includes("29,480"), "#3 顯示上架價格");
  await as(C);
  ok(await card(3).locator("button", { hasText: "購買" }).count() === 0, "監造方看不到購買按鈕");
  await as(E);
  ok(await card(3).locator("button", { hasText: "購買" }).count() === 0, "機率來源看不到購買按鈕");

  console.log("投資人購買");
  await as(D);
  await page.click("#btnMint"); await waitToast("領取測試 mUSDC：完成");
  await card(3).locator("button", { hasText: "購買" }).click(); await waitToast("購買 #3：完成");
  ok((await card(3).textContent()).includes("（你）"), "投資人成為持有人");
  ok((await page.textContent("#balUsdc")) === "70,520", "投資人餘額 70,520");

  console.log("p 跌到 60，按鈕停用");
  await as(E);
  await card(3).locator("input[id^=p-]").fill("60");
  await card(3).locator("button", { hasText: "設定完工機率" }).click(); await waitToast("設定 #3 完工機率：完成");
  await as(D);
  ok(await card(3).locator("button", { hasText: "上架賣斷" }).isDisabled(), "持有人的上架按鈕停用");
  ok((await card(3).textContent()).includes("p 低於門檻"), "按鈕停用時說明原因");

  console.log("監造方回報進度");
  await as(C);
  // 自動更新會重繪卡片：輸入到一半的內容、選好的檔案、游標都不能不見（refresh 就是每 20 秒執行的那個函式）
  await card(3).locator("input[id^=prog-]").fill("45");
  await card(3).locator("input[id^=pev-]").setInputFiles({ name: "progress.txt", mimeType: "text/plain", buffer: Buffer.from("draft") });
  await card(3).locator("input[id^=pevt-]").fill("打到一半");
  await page.evaluate(() => refresh()); await page.waitForTimeout(700);
  ok((await card(3).locator("input[id^=prog-]").inputValue()) === "45", "重繪後保留輸入中的數字");
  ok((await card(3).locator("input[id^=pevt-]").inputValue()) === "打到一半", "重繪後保留輸入中的文字");
  ok(await card(3).locator("input[id^=pev-]").evaluate(i => i.files.length) === 1, "重繪後保留選好的檔案");
  ok(await page.evaluate(() => document.activeElement && document.activeElement.id.startsWith("pevt-")), "重繪後游標留在原本的欄位");
  await card(3).locator("input[id^=pev-]").setInputFiles([]);
  await card(3).locator("input[id^=pevt-]").fill("");
  await card(3).locator("input[id^=prog-]").fill("60");
  await card(3).locator("button", { hasText: "回報進度" }).click(); await waitToast("請選擇進度證明文件或輸入說明");
  await card(3).locator("input[id^=prog-]").fill("60");
  await card(3).locator("input[id^=pevt-]").fill("進度報告 v1");
  await card(3).locator("button", { hasText: "回報進度" }).click(); await waitToast("回報 #3 進度：完成");
  ok((await card(3).textContent()).includes("最新進度60%"), "#3 卡片顯示最新進度 60%");
  ok((await card(3).locator("input[id^=pevt-]").inputValue()) === "", "交易成功後清掉已送出的輸入");
  ok((await card(3).locator("input[id^=prog-]").inputValue()) === "60", "交易成功後數字改回最新進度");
  await page.waitForSelector("#audit tr.ev-progress", { timeout: 10000 });
  const progHash = ethers.id("進度報告 v1"), progRow = await page.locator("#audit tr.ev-progress").first().textContent();
  ok(progRow.includes("進度回報：60%") && progRow.includes(progHash.slice(0, 6) + "…" + progHash.slice(-4)) && /\d{4}\/\d{1,2}\/\d{1,2}/.test(progRow), "稽核紀錄明顯呈現進度（日期、%、證據 hash）");
  await as(D);
  ok(await card(3).locator("button", { hasText: "回報進度" }).count() === 0, "投資人看不到回報進度按鈕");

  console.log("時間快轉 92 天");
  await as(E);
  ok(await page.locator("#clockAdmin").isVisible(), "demo 管理員看得到快轉按鈕");
  ok((await page.textContent("#clockNote")).includes("僅供課堂 DEMO 使用"), "demo 管理員也看得到僅 DEMO 用的附註");
  await page.fill("#clockDays", "0"); await page.click("#btnClockCustom"); await waitToast("快轉天數必須是 1 以上的整數");
  const ts0 = await clockTs();
  await fastForward("＋30 天", "快轉 30 天：完成");
  ok(await clockTs() - ts0 >= 30 * 86400, "＋30 天：合約時鐘往前 30 天");
  ok((await page.textContent("#clockOffset")).includes("已快轉 30 天"), "顯示已快轉天數");
  ok((await card(3).textContent()).includes("剩 60"), "#3 倒數改用合約時間（剩 60 天）");
  await page.fill("#clockDays", "1"); await page.click("#btnClockCustom"); await waitToast("快轉 1 天：完成");
  await page.fill("#gotoId", "99"); await page.click("#btnClockGoto"); await waitToast("找不到第 99 期");
  await page.fill("#gotoId", "3"); await page.click("#btnClockGoto"); await waitToast("快轉 61 天：完成");
  ok(true, "快轉到第 3 期期限後 2 天：依剩餘天數算出 61 天");
  ok((await card(3).textContent()).includes("已逾期"), "快轉 92 天後，#3 顯示已逾期");
  await page.click("#btnClockGoto"); await waitToast("時間不能倒退");
  ok(true, "已超過目標時間時不送交易");

  console.log("申報、駁回、再申報，拖延 5 天後監造方核准");
  await as(B);
  ok(await card(1).locator("button", { hasText: "申報完工" }).count() === 0, "第 1 期已超過寬限期，看不到申報按鈕");
  ok(await card(2).locator("button", { hasText: "申報完工" }).count() === 1, "第 2 期還在寬限期內，仍可申報");
  await card(3).locator("input[id^=evt-]").fill("驗收報告 v1");
  await card(3).locator("button", { hasText: "申報完工" }).click(); await waitToast("申報 #3 完工：完成");
  await as(C);
  ok((await card(3).locator("button", { hasText: "回報進度" }).count()) === 0, "有申報時，不另外顯示回報進度");
  ok((await card(3).locator("input[id^=acc-]").inputValue()) === "100" && await card(3).locator("button", { hasText: "核准並撥款" }).count() === 1, "驗收結果預設 100%：按鈕是核准");
  await card(3).locator("input[id^=acc-]").fill("90");
  ok(await card(3).locator("button", { hasText: "核准並撥款" }).count() === 0 && await card(3).locator("button", { hasText: "駁回並回報進度" }).count() === 1, "填 90%：按鈕變成駁回並回報進度，按不到核准");
  await card(3).locator("button", { hasText: "駁回並回報進度" }).click(); await waitToast("駁回時請選擇證明文件");
  await card(3).locator("input[id^=aevt-]").fill("外牆尚未完成");
  await clearToasts(); await card(3).locator("button", { hasText: "駁回並回報進度" }).click(); await waitToast("駁回 #3：完成");
  ok((await card(3).textContent()).includes("最新進度90%") && (await card(3).textContent()).includes("Active"), "一筆交易完成：回到進行中，進度更新為 90%");
  await clearToasts();
  await as(B);
  await card(3).locator("input[id^=evt-]").fill("驗收報告 v2");
  await card(3).locator("button", { hasText: "申報完工" }).click(); await waitToast("申報 #3 完工：完成");
  await as(E);
  await fastForward("＋5 天", "快轉 5 天：完成");
  await as(C);
  ok((await card(3).textContent()).includes("延誤 2 天"), "拖延 5 天後仍顯示延誤 2 天");
  await card(3).locator("button", { hasText: "核准並撥款" }).click(); await waitToast("核准 #3：完成");
  ok((await card(3).textContent()).includes("Paid"), "#3 狀態變為已撥款");
  await as(D);
  ok((await page.textContent("#balUsdc")) === "100,460", "投資人收到 29,940（餘額 100,460）");

  console.log("第 1 期逾寬限期，監造方終止");
  await as(C);
  ok((await card(1).locator("input[id^=done-]").inputValue()) === "0", "尚未回報進度時，完成比例預填 0");
  const preview = () => card(1).locator("[id^=done-preview-]").textContent();
  const p0 = await preview();
  ok(p0.includes("持有人 0 mUSDC、業主 20,000 mUSDC") && p0.includes("尚未回報過進度") && p0.includes("持有人將拿到 0"), "完成 0%：預覽分配並提醒持有人拿到 0");
  ok((await card(1).textContent()).includes("目前進度 %（僅紀錄，不影響撥款）") && (await card(1).textContent()).includes("最終完成比例 %（決定分配，確定後無法更改）"), "兩個欄位的標籤清楚區分");
  await card(1).locator("input[id^=prog-]").fill("65");
  await card(1).locator("input[id^=pevt-]").fill("第 1 期進度");
  await card(1).locator("button", { hasText: "回報進度" }).click(); await waitToast("回報 #1 進度：完成");
  ok((await card(1).locator("input[id^=done-]").inputValue()) === "65", "完成比例預填最新進度 65");
  const p65 = await preview();
  ok(p65.includes("持有人 13,000 mUSDC、業主 7,000 mUSDC") && p65.includes("與最新回報進度 65% 相同"), "回報進度後，完成比例與分配預覽跟著連動");
  await card(1).locator("input[id^=done-]").fill("70");
  const p70 = await preview();
  ok(p70.includes("持有人 14,000 mUSDC、業主 6,000 mUSDC") && p70.includes("注意：與最新回報進度 65% 不同"), "改完成比例：分配即時更新，並提醒與進度不同");
  await card(1).locator("input[id^=done-]").fill("");
  ok((await preview()).includes("請輸入 0 到 100"), "空白時提示要輸入");
  await card(1).locator("input[id^=done-]").fill("70");
  await card(1).locator("input[id^=tevt-]").fill("鑑定報告");
  await card(1).locator("button", { hasText: "終止並依比例分配" }).click(); await waitToast("終止 #1：完成");
  ok((await card(1).textContent()).includes("Terminated"), "#1 狀態變為已終止");

  console.log("錯誤訊息與稽核紀錄");
  await as(A);
  await card(2).locator("button", { hasText: "回報進度" }).count().then(n => ok(n === 0, "業主看不到監造方的按鈕"));
  const audit = await page.textContent("#audit");
  ok(audit.includes("違約金 60") && audit.includes("完成 70%") && audit.includes("持有人 14,000、業主 6,000") && audit.includes("成交 29,480"), "稽核紀錄包含成交、違約金、終止");
  ok(["專案 1", "完工機率設為", "以 29,480 上架", "進度回報", "快轉 61 天", "申報完工", "申報被駁回"].every(t => audit.includes(t)), "稽核紀錄也包含建立、機率、上架、進度、快轉、申報、駁回");

  console.log("另一個專案（直接呼叫合約，用來測試角色畫面）");
  const usdcA = new ethers.Contract(usdc, ["function approve(address,uint256) returns (bool)"], await rpc.getSigner(A));
  await (await usdcA.approve(trust, ethers.parseUnits("1000", 6))).wait();
  const trustA = new ethers.Contract(trust, ["function createProject(address,address,uint256[],uint256[]) returns (uint256,uint256)", "function currentTime() view returns (uint256)"], await rpc.getSigner(A));
  await (await trustA.createProject(B, C, [ethers.parseUnits("1000", 6)], [(await trustA.currentTime()) + BigInt(25 * 86400)])).wait();
  await page.click("#btnReload"); await page.waitForTimeout(800);
  ok((await card(4).textContent()).includes("剩 25.0 天"), "第 4 期到期日以合約時間計算");
  ok(errors.length === 0, "頁面沒有 JavaScript 錯誤" + (errors.length ? "：" + errors.join("; ") : ""));

  // ═════════ 角色畫面矩陣與按鈕盤點：每個按鈕都驗證鏈上真的改變，不只看提示 ═════════
  console.log("角色畫面矩陣（#4：承包商 B、監造方 C、業主 A）");
  const F = accts[5];   // 與專案無關的陌生人
  const T = new ethers.Contract(trust, [
    "function milestones(uint256) view returns (uint256 projectId, uint256 face, uint256 deadline, uint256 claimedAt, bytes32 evidenceHash, uint8 status, uint16 probability, uint256 listPrice, uint16 progressBps, uint256 progressAt)",
    "function ownerOf(uint256) view returns (address)", "function timeOffset() view returns (uint256)",
    "function setProbability(uint256,uint16)",
  ], rpc);
  const U20 = new ethers.Contract(usdc, ["function balanceOf(address) view returns (uint256)"], rpc);
  const sameAddr = (x, y) => x.toLowerCase() === y.toLowerCase();
  const btns = async id => JSON.stringify(await card(id).locator(".actions button").allTextContents());
  const expectBtns = async (who, id, want, label) => { await as(who); const got = await btns(id); ok(got === JSON.stringify(want), `${label}：${want.join("、") || "沒有按鈕"}` + (got === JSON.stringify(want) ? "" : `（實際 ${got}）`)); };
  const press = async (id, text, done) => { await clearToasts(); await card(id).locator("button", { hasText: text }).click(); await waitToast(done); };
  const roles = async () => (await page.textContent("#roles")).trim();

  await expectBtns(E, 4, ["設定完工機率"], "E 機率來源，Active");
  ok((await roles()).includes("機率來源") && await page.locator("#clockAdmin").isVisible(), "E 的角色標籤與快轉區塊");
  await expectBtns(A, 4, [], "A 業主，Active");
  ok((await roles()).includes("業主") && !(await page.locator("#clockAdmin").isVisible()), "A 的角色標籤，沒有快轉區塊");
  await expectBtns(B, 4, ["上架賣斷", "申報完工"], "B 承包商兼持有人，Active");
  ok((await roles()).includes("承包商") && (await roles()).includes("持有人"), "B 的角色標籤");
  ok(await card(4).locator("button", { hasText: "上架賣斷" }).isDisabled(), "p = 0 時 B 的上架按鈕停用");
  await expectBtns(C, 4, ["回報進度"], "C 監造方，Active");
  ok((await roles()).includes("監造方") && (await card(4).textContent()).includes("寬限期結束後"), "C 的角色標籤與尚不能終止的說明");
  await expectBtns(F, 4, [], "陌生人，Active");
  ok((await roles()).includes("尚無角色"), "陌生人的角色標籤");

  console.log("五個角色的整頁畫面");
  const view = async who => {
    await as(who);
    return JSON.stringify({ 建立專案: await page.locator("#secCreate").isVisible(), 定價假設: await page.locator("#secPricing").isVisible(), 快轉: await page.locator("#clockAdmin").isVisible(), 卡片數: await page.locator(".ms").count(), 試算表: await card(4).locator("summary").count() });
  };
  const expectView = async (name, who, want) => { const got = await view(who); ok(got === JSON.stringify(want), `${name}：${got}`); };
  await expectView("E 機率來源", E, { 建立專案: false, 定價假設: false, 快轉: true, 卡片數: 4, 試算表: 0 });
  await expectView("A 業主", A, { 建立專案: false, 定價假設: false, 快轉: false, 卡片數: 4, 試算表: 0 });
  await expectView("B 承包商", B, { 建立專案: false, 定價假設: true, 快轉: false, 卡片數: 4, 試算表: 1 });
  await expectView("C 監造方", C, { 建立專案: false, 定價假設: false, 快轉: false, 卡片數: 4, 試算表: 0 });
  await expectView("D 投資人（只看到自己持有的 #3）", D, { 建立專案: false, 定價假設: true, 快轉: false, 卡片數: 1, 試算表: 0 });
  await expectView("陌生人（沒有相關也沒有上架）", F, { 建立專案: false, 定價假設: true, 快轉: false, 卡片數: 0, 試算表: 0 });
  ok((await page.textContent("#milestones")).includes("目前沒有與你有關或上架中的請款權"), "陌生人看到正確的提示");
  ok(!(await page.locator("#secContractor").isVisible()), "陌生人看不到工程損益");
  await as(B); await page.waitForTimeout(900);
  ok(await page.locator("#secContractor").isVisible(), "承包商看得到工程損益");
  await as(C); await page.waitForTimeout(900);
  ok(!(await page.locator("#secContractor").isVisible()), "監造方看不到工程損益");
  ok(await page.locator("#onlyMine").count() === 0, "「只看與我有關」勾選框已移除");

  console.log("輸入檢查：空白或超出範圍不能送出");
  await as(E);
  await card(4).locator("input[id^=p-]").fill("101");
  await press(4, "設定完工機率", "完工機率必須");
  await card(4).locator("input[id^=p-]").fill("");
  await press(4, "設定完工機率", "完工機率必須");
  ok((await T.milestones(4)).probability === 0n, "錯誤輸入沒有改到鏈上的 p");

  console.log("設定 p 後，已上架的按鈕");
  await as(E);
  await card(4).locator("input[id^=p-]").fill("99");
  await press(4, "設定完工機率", "設定 #4 完工機率：完成");
  ok((await T.milestones(4)).probability === 99n, "設定完工機率：鏈上 p = 99");
  await as(B);
  await card(4).locator("summary", { hasText: "定價試算表" }).click();
  const priceAt = async () => Number(/建議價([\d,]+)/.exec(await card(4).locator("details.pricing").textContent())[1].replace(/,/g, ""));
  const before = await priceAt();
  await page.fill("#asRate", "40"); await page.waitForTimeout(200);
  ok(await priceAt() < before, "定價假設：調高年利率後建議價下降");
  await page.fill("#asRate", "4"); await page.waitForTimeout(200);

  await as(B);
  await card(4).locator("input[id^=price-]").fill("");
  await press(4, "上架賣斷", "售價必須");
  ok((await T.milestones(4)).listPrice === 0n, "空白售價沒有送出");
  await card(4).locator("input[id^=price-]").fill("500");
  await press(4, "上架賣斷", "上架 #4：完成");
  ok((await T.milestones(4)).listPrice === ethers.parseUnits("500", 6), "上架賣斷：鏈上售價 500");
  await expectBtns(B, 4, ["取消上架", "申報完工"], "B，已上架");
  await press(4, "取消上架", "取消上架 #4：完成");
  ok((await T.milestones(4)).listPrice === 0n, "取消上架：鏈上售價歸零");
  await card(4).locator("input[id^=price-]").fill("500");
  await press(4, "上架賣斷", "上架 #4：完成");
  await expectBtns(A, 4, ["以 500 購買"], "A 業主，已上架");
  ok(await card(4).locator("summary", { hasText: "定價試算表" }).count() === 1, "業主看到上架中的請款權時，有建議價可參考");
  await expectBtns(D, 4, ["以 500 購買"], "D 投資人，已上架");
  await expectBtns(F, 4, ["以 500 購買"], "陌生人，已上架");
  ok(await page.locator(".ms").count() === 1 && await card(4).count() === 1, "陌生人看得到上架中的請款權");
  await expectBtns(C, 4, ["回報進度"], "C 監造方，已上架（沒有購買）");
  await expectBtns(E, 4, ["設定完工機率"], "E 機率來源，已上架（沒有購買）");

  console.log("重新整理、領幣、購買");
  await (await T.connect(await rpc.getSigner(E)).setProbability(4, 88)).wait();
  await page.click("#btnReload"); await page.waitForTimeout(800);
  ok((await card(4).textContent()).includes("88%"), "重新整理：讀到鏈上最新的 p");
  await as(F);
  await clearToasts(); await page.click("#btnMint"); await waitToast("領取測試 mUSDC：完成");
  ok((await U20.balanceOf(F)) === ethers.parseUnits("100000", 6), "領測試幣：鏈上餘額 100,000");
  const bBeforeBuy = await U20.balanceOf(B);
  await press(4, "以 500 購買", "購買 #4：完成");
  ok(sameAddr(await T.ownerOf(4), F) && (await U20.balanceOf(B)) - bBeforeBuy === ethers.parseUnits("500", 6), "購買：NFT 給買方，賣方收到 500");
  await expectBtns(F, 4, ["上架賣斷"], "新持有人");
  await expectBtns(B, 4, ["申報完工"], "B 賣掉後只剩申報");

  console.log("快轉按鈕");
  await as(E);
  const off0 = await T.timeOffset();
  await page.locator("#clockAdmin button", { hasText: "＋1 天" }).click(); await waitToast("快轉 1 天：完成");
  await page.locator("#clockAdmin button", { hasText: "＋10 天" }).click(); await waitToast("快轉 10 天：完成");
  ok((await T.timeOffset()) - off0 === BigInt(11 * 86400), "＋1 天、＋10 天：鏈上 timeOffset 增加 11 天");

  console.log("用檔案當證據");
  const fileHash = text => "0x" + require("crypto").createHash("sha256").update(text).digest("hex");
  const pick = async (sel, name, text) => card(4).locator(sel).setInputFiles({ name, mimeType: "text/plain", buffer: Buffer.from(text) });
  await as(C);
  await card(4).locator("input[id^=prog-]").fill("");
  await card(4).locator("input[id^=pevt-]").fill("進度");
  await press(4, "回報進度", "進度必須");
  await card(4).locator("input[id^=prog-]").fill("50");
  await pick("input[id^=pev-]", "progress.txt", "progress evidence");
  await press(4, "回報進度", "回報 #4 進度：完成");
  ok((await T.milestones(4)).progressBps === 5000n, "回報進度（檔案）：鏈上進度 50%");
  await as(B);
  await pick("input[id^=ev-]", "report.txt", "claim evidence");
  await press(4, "申報完工", "申報 #4 完工：完成");
  const claimed = await T.milestones(4);
  ok(claimed.status === 1n && claimed.evidenceHash === fileHash("claim evidence"), "申報完工（檔案）：狀態 Claimed，hash 等於檔案的 SHA-256");
  await expectBtns(B, 4, [], "B，Claimed");
  await expectBtns(F, 4, [], "持有人，Claimed（不能上架）");
  await expectBtns(E, 4, ["設定完工機率"], "E，Claimed");
  await expectBtns(C, 4, ["核准並撥款"], "C，Claimed，預設 100%");
  await card(4).locator("input[id^=acc-]").fill("");
  ok(await card(4).locator("button", { hasText: "駁回並回報進度" }).isDisabled(), "實際完成比例空白時按鈕停用");
  await card(4).locator("input[id^=acc-]").fill("75");
  ok(JSON.stringify(await card(4).locator(".actions button").allTextContents()) === JSON.stringify(["駁回並回報進度"]), "C，Claimed，填 75%：只剩駁回並回報進度");
  await card(4).locator("input[id^=aev-]").setInputFiles({ name: "r.txt", mimeType: "text/plain", buffer: Buffer.from("reject evidence") });
  await press(4, "駁回並回報進度", "駁回 #4：完成");
  const rejected4 = await T.milestones(4);
  ok(rejected4.status === 0n && rejected4.progressBps === 7500n, "駁回並回報進度：鏈上回到 Active，進度 75%");
  await as(B);
  await card(4).locator("input[id^=evt-]").fill("第二次申報");
  await press(4, "申報完工", "申報 #4 完工：完成");
  ok((await T.milestones(4)).evidenceHash === ethers.id("第二次申報"), "申報完工（文字）：hash 等於文字的 keccak256");
  await as(C);
  const fBefore = await U20.balanceOf(F);
  await press(4, "核准並撥款", "核准 #4：完成");
  ok((await T.milestones(4)).status === 2n && (await U20.balanceOf(F)) - fBefore === ethers.parseUnits("1000", 6), "核准並撥款：持有人收到全額 1,000");
  await expectBtns(C, 4, [], "C，Paid");
  await expectBtns(E, 4, [], "E，Paid");
  await expectBtns(F, 4, [], "持有人，Paid");

  console.log("終止（第 2 期，超過寬限期）");
  await as(E);
  await page.fill("#clockDays", "10"); await page.click("#btnClockCustom"); await waitToast("快轉 10 天：完成");
  await as(C);
  await card(2).locator("input[id^=done-]").fill("");
  await card(2).locator("input[id^=tevt-]").fill("鑑定");
  await clearToasts(); await card(2).locator("button", { hasText: "終止並依比例分配" }).click(); await waitToast("完成比例必須");
  ok((await T.milestones(2)).status === 0n, "完成比例空白時不會終止（否則持有人會拿到 0）");
  await card(2).locator("input[id^=done-]").fill("50");
  await card(2).locator("input[id^=tev-]").setInputFiles({ name: "t.txt", mimeType: "text/plain", buffer: Buffer.from("termination evidence") });
  await clearToasts(); await card(2).locator("button", { hasText: "終止並依比例分配" }).click(); await waitToast("終止 #2：完成");
  const m2 = await T.milestones(2);
  ok(m2.status === 3n && m2.evidenceHash === fileHash("termination evidence"), "終止（檔案）：狀態 Terminated，hash 等於檔案的 SHA-256");
  await expectBtns(C, 2, [], "C，Terminated");

  console.log("建立專案表單與合約設定");
  await as(A);
  ok(!(await page.locator("#cfgTrust").isVisible()), "合約設定載入成功後收合");
  await page.click("#cfgBox > summary");
  await page.fill("#cfgTrust", "0x123");
  await page.click("#btnSaveCfg"); await page.waitForTimeout(300);
  ok((await page.textContent("#milestones")).includes("請填入兩個合約地址"), "儲存並載入：地址錯誤時提示");
  await page.fill("#cfgTrust", trust);
  await page.click("#btnSaveCfg"); await page.waitForTimeout(800);
  ok(!(await page.locator("#cfgTrust").isVisible()), "重新載入成功後再次收合");
  ok(await page.locator(".ms").count() === 4 && sameAddr(await page.evaluate(() => JSON.parse(localStorage.getItem("mt-cfg")).trust), trust), "儲存並載入：重新載入，地址記在瀏覽器");
  ok(errors.length === 0, "整輪操作沒有 JavaScript 錯誤" + (errors.length ? "：" + errors.join("; ") : ""));

  console.log("18 位小數代幣（MTK 的條件）");
  const decCheck = fn => page.evaluate(fn);
  // 模擬 MTK：18 位小數，只有 E 能領（其他帳號的 mint 會失敗）
  const mtkSource = fs.readFileSync(path.join(SRC, "MockUSDC.sol"), "utf8")
    .replace("contract MockUSDC", "contract LocalMTK").replace('"mUSDC"', '"MTK"').replace("decimals = 6", "decimals = 18")
    .replace('require(to != address(0), "mint to zero");', `require(to == ${ethers.getAddress(E)}, "not owner");`);
  const mtkOut = JSON.parse(solc.compile(JSON.stringify({ language: "Solidity", sources: { "LocalMTK.sol": { content: mtkSource } },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "shanghai", outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } } })));
  const mtkAddr = await dep(mtkOut.contracts["LocalMTK.sol"].LocalMTK);
  const trust18 = await dep(art("MilestoneTrust.sol", "MilestoneTrust"), mtkAddr, E, 86400, 5184000);
  const V = x => ethers.parseUnits(String(x), 18);
  const MTK = new ethers.Contract(mtkAddr, ["function mint(address,uint256)", "function transfer(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"], signer);
  await (await MTK.mint(E, V(2000000))).wait();
  await (await MTK.transfer(A, V(1000000))).wait();   // 模擬從舊錢包轉入
  await (await MTK.transfer(D, V(1000000))).wait();
  // 網址的業主地址不完整：不能讓表單默默消失
  await page.goto(`http://127.0.0.1:8080/?usdc=${mtkAddr}&trust=${trust18}&from=0&owner=${A.slice(0, 20)}&contractor=${B}&attester=${C}`);
  await as(A);
  ok(await page.locator("#secCreate").isVisible(), "owner 參數不完整時，表單仍然顯示");
  // 短網址：地址來自 deployments.json
  await page.route("**/deployments.json", r => r.fulfill({ contentType: "application/json",
    body: JSON.stringify({ practice: { usdc: mtkAddr, trust: trust18, from: 0, owner: A, contractor: B, attester: C } }) }));
  await page.goto("http://127.0.0.1:8080/?env=practice");
  await as(A);
  ok(await page.locator("#secCreate").isVisible() && (await page.textContent("#roles")).includes("業主") && (await page.inputValue("#cpContractor")).toLowerCase() === B.toLowerCase(), "短網址 ?env=practice：A 是業主，看得到表單，地址已預填");
  await as(D);
  ok(!(await page.locator("#secCreate").isVisible()) && (await page.textContent("#milestones")).includes("業主尚未建立專案"), "短網址：其他帳號看不到表單");
  await page.goto("http://127.0.0.1:8080/?env=nope");
  await waitToast("找不到 nope 的部署設定");
  ok(true, "短網址名稱錯誤時顯示原因");
  await page.goto(`http://127.0.0.1:8080/?usdc=${mtkAddr}&trust=${trust18}&from=0&owner=${A}&contractor=${B}&attester=${C}`);
  await as(B);
  ok(!(await page.locator("#secCreate").isVisible()) && (await page.textContent("#milestones")).includes("業主尚未建立專案"), "網址指定業主時，其他帳號看不到表單");
  await as(E);
  await fastForward("＋1 天", "快轉 1 天：完成");
  await as(A);
  ok(await page.locator("#secCreate").isVisible() && !(await page.locator("#secPricing").isVisible()), "只有指定的業主看得到表單");
  ok((await page.textContent("#roles")).includes("業主"), "建立專案前，指定的業主就顯示業主標籤");
  ok((await page.inputValue("#cpContractor")).toLowerCase() === B.toLowerCase() && (await page.inputValue("#cpAttester")).toLowerCase() === C.toLowerCase(), "承包商與監造方地址已預填");
  ok((await page.textContent("#balUsdc")) === "1,000,000", "18 位小數的餘額顯示正確（1,000,000）");
  ok((await page.locator(".sym").first().textContent()) === "MTK", "頁面顯示代幣符號 MTK");
  ok(!(await page.locator("#btnMint").isVisible()), "不能 mint 的帳號看不到領幣按鈕");
  ok(await decCheck(() => DEC) === 18, "前端的小數位數讀到 18");
  ok(await decCheck(() => String(amountOf("1.123456789012345678"))) === "1123456789012345678", "金額可以輸入到 18 位小數");
  ok(await decCheck(() => amountOf("1.1234567890123456789")) === null, "超過 18 位小數會被擋下");
  await page.click("#btnCreate"); await waitToast("建立信託專案：完成");
  const createToasts = await page.textContent("#toast");
  ok(createToasts.includes("授權 MTK：完成") && !createToasts.includes("USDC"), "授權提示顯示 MTK，不是 USDC");
  ok(await page.evaluate(() => reason({ message: "execution reverted: USDC transfer failed" })) === "代幣轉帳失敗", "合約的 USDC 錯誤字串不會直接顯示");
  ok(!(await page.evaluate(() => Object.values(REASONS).join(""))).includes("USDC"), "中文錯誤訊息都沒有寫死 USDC");
  ok((await card(1).textContent()).includes("20,000 MTK") && (await page.textContent("#balUsdc")) === "910,000", "建立專案：卡片與餘額都以 MTK 顯示");
  ok((await card(1).textContent()).includes("剩 25.0 天") && (await card(3).textContent()).includes("剩 90.0 天"), "快轉後建立，到期日仍從合約時間起算");
  await as(E);
  ok(await page.locator("#btnMint").isVisible() && (await page.textContent("#btnMint")).includes("MTK"), "能 mint 的帳號看得到領幣按鈕");
  await clearToasts(); await page.click("#btnMint"); await waitToast("領取測試 MTK：完成");
  ok((await MTK.balanceOf(E)) === V(100000), "領幣金額依 18 位小數換算");
  await card(3).locator("input[id^=p-]").fill("99");
  await press(3, "設定完工機率", "設定 #3 完工機率：完成");
  await as(B);
  await card(3).locator("input[id^=price-]").fill("29480");
  await press(3, "上架賣斷", "上架 #3：完成");
  await as(D);
  await press(3, "以 29,480 購買", "購買 #3：完成");
  ok((await page.textContent("#balUsdc")) === "970,520" && (await MTK.balanceOf(B)) === V(29480), "購買：投資人 970,520，承包商收到 29,480 MTK");
  console.log("二次轉售：D 再上架，二號投資人買下");
  await MTK.transfer(F, V(50000)).then(t => t.wait());
  await card(3).locator("input[id^=price-]").fill("29600");
  await press(3, "上架賣斷", "上架 #3：完成");
  ok((await card(3).textContent()).includes("29,600 MTK"), "D 的卡片顯示再上架價格 29,600");
  await as(F);
  ok(await card(3).count() === 1 && await page.locator(".ms").count() === 1, "二號投資人只看到上架中的 #3");
  await press(3, "以 29,600 購買", "購買 #3：完成");
  const T18 = new ethers.Contract(trust18, ["function ownerOf(uint256) view returns (address)"], rpc);
  ok(sameAddr(await T18.ownerOf(3), F) && (await MTK.balanceOf(D)) === V(1000000 - 29480 + 29600), "二次轉售：二號投資人持有，D 收到 29,600 MTK");
  ok((await card(3).textContent()).includes("（你）"), "二號投資人顯示為持有人");
  const flow = async who => { await as(who); await page.waitForTimeout(900); return (await page.textContent("#flow")).replace(/\s+/g, " "); };
  const fHold = await flow(F);
  ok(fHold.includes("買入 #3 請款權") && fHold.includes("−29,600 MTK") && fHold.includes("尚未結算，暫不計賺賠") && fHold.includes("買入成本 29,600 MTK"), "持有中：列出買入成本，不計賺賠");
  await as(D);
  ok(await card(3).count() === 0, "D 賣掉後看不到 #3");
  await as(E);
  await clearToasts(); await page.click("#btnClockGoto"); await waitToast("快轉 92 天：完成");
  await as(B);
  await card(3).locator("input[id^=evt-]").fill("驗收報告");
  await press(3, "申報完工", "申報 #3 完工：完成");
  await as(C);
  ok((await card(3).textContent()).includes("延誤 2 天・違約金 60"), "違約金顯示 60");
  await press(3, "核准並撥款", "核准 #3：完成");
  ok((await MTK.balanceOf(F)) === V(50000 - 29600 + 29940), "核准：撥款給當下持有人（二號投資人）29,940 MTK");
  ok((await MTK.balanceOf(D)) === V(1000000 - 29480 + 29600), "D 賣掉後不會再收到撥款");
  await card(1).locator("input[id^=done-]").fill("70");
  await card(1).locator("input[id^=tevt-]").fill("鑑定");
  await clearToasts(); await card(1).locator("button", { hasText: "終止並依比例分配" }).click(); await waitToast("終止 #1：完成");
  ok((await MTK.balanceOf(B)) === V(29480 + 14000), "終止第 1 期：承包商收到 14,000 MTK");

  console.log("每個角色的資金流水與賺賠");
  const fD = await flow(D);
  ok(fD.includes("買入 #3 請款權") && fD.includes("賣出 #3 請款權") && fD.includes("流入 29,600 MTK") && fD.includes("流出 29,480 MTK") && fD.includes("結果：賺 120 MTK"), "D 投資人：買 29,480、賣 29,600，賺 120");
  const fF = await flow(F);
  ok(fF.includes("#3 撥款（已扣違約金，延誤 2 天）") && fF.includes("+29,940 MTK") && fF.includes("結果：賺 340 MTK"), "F 二號投資人：買 29,600、撥款 29,940，賺 340");
  const fB = await flow(B);
  ok(fB.includes("賣出 #3 請款權") && fB.includes("#1 終止分配（完成 70%）") && fB.includes("結果：賺 3,480 MTK") && fB.includes("已扣工程成本（利潤比例 20%）"), "B 承包商（利潤 20%）：#3 賣 29,480 − 成本 24,000 = 賺 5,480；#1 收 14,000 − 成本 16,000 = 賠 2,000，共賺 3,480");
  const pnlText = async () => (await page.textContent("#contractorPnl")).replace(/\s+/g, " ");
  const pB = await pnlText();
  ok(await page.locator("#secContractor").isVisible() && pB.includes("賺 5,480 MTK") && pB.includes("賠 2,000 MTK") && pB.includes("已終止（完成 70%）") && pB.includes("尚未發生") && pB.includes("8,000 MTK"), "工程損益：每期列出，#2 未賣未結算只列預期獲利 8,000");
  await page.fill("#asMargin", "1");
  await page.waitForTimeout(200);
  const fB2 = (await page.textContent("#flow")).replace(/\s+/g, " ");
  ok(fB2.includes("結果：賠"), "利潤比例調低到 1%：承包商變成賠錢（#3 賣價低於成本）");
  ok((await page.textContent("#marginHint")).includes("延誤超過 10 天就會虧損"), "顯示幾天後會虧損");
  await page.fill("#asMargin", "20");
  await page.waitForTimeout(200);
  ok((await page.textContent("#marginHint")).includes("不會因延誤虧損"), "利潤 20% 高於違約金上限時，說明不會因延誤虧損");
  // 沒賣出、自己承擔違約金：利潤 5%、延誤 60 天 → 收 28,200，成本 28,500，賠 300
  const lossUnsold = await page.evaluate(me => {
    const face = 30000n * 10n ** 18n;
    const items = [{ id: 9, project: { contractor: me }, m: { face, status: 2n } }];
    const evs = [{ fragment: { name: "MilestonePaid" }, args: { id: 9n, holder: me, toHolder: 28200n * 10n ** 18n, penalty: 1800n * 10n ** 18n } }];
    return contractorPnl(items, evs, me, 500).total.toString();
  }, B);
  ok(lossUnsold === (-300n * 10n ** 18n).toString(), "沒賣出又延誤 60 天（利潤 5%）：承包商自己承擔違約金，賠 300");
  const lossZero = await page.evaluate(me => {
    const face = 20000n * 10n ** 18n;
    const items = [{ id: 9, project: { contractor: me }, m: { face, status: 3n } }];
    const evs = [{ fragment: { name: "MilestoneTerminated" }, args: { id: 9n, holder: me, toHolder: 0n, toOwner: face, completedBps: 0n } }];
    return contractorPnl(items, evs, me, 2000).total.toString();
  }, B);
  ok(lossZero === (-16000n * 10n ** 18n).toString(), "完成 0% 被終止：工程成本全額損失，賠 16,000");
  await page.reload(); await as(B); await page.waitForTimeout(900);
  ok((await page.inputValue("#asMargin")) === "20", "利潤比例記在瀏覽器");
  const fA = await flow(A);
  ok(fA.includes("存入專案 1 工程款") && fA.includes("#3 違約金收入") && fA.includes("#1 退回工程款") && fA.includes("結果：賺 60 MTK") && fA.includes("仍鎖在信託：40,000 MTK"), "A 業主：賺違約金 60，40,000 仍鎖在信託");
  const fC = await flow(C);
  ok(fC.includes("沒有資金往來，損益 0") && fC.includes("監造方"), "C 監造方：沒有資金往來");
  const fE = await flow(E);
  ok(fE.includes("沒有資金往來，損益 0") && fE.includes("機率來源"), "E 機率來源：沒有資金往來");
  ok(fA.includes("賺賠只計違約金與里程碑請款權交易"), "業主的說明文字包含請款權交易");
  // 業主自己買賣請款權：賺賠要計入
  const ownerTrade = await page.evaluate(([me, other]) => {
    const f = flowOf([
      { fragment: { name: "ProjectCreated" }, blockNumber: 1, args: { projectId: 9n, owner: me, total: 90000n * 10n ** 18n } },
      { fragment: { name: "Sold" }, blockNumber: 2, args: { id: 99n, seller: other, buyer: me, price: 29000n * 10n ** 18n } },
      { fragment: { name: "MilestonePaid" }, blockNumber: 3, args: { id: 99n, holder: me, toHolder: 30000n * 10n ** 18n, penalty: 0n, daysLate: 0n } },
    ], me);
    return f.profit.toString();
  }, [A, B]);
  ok(ownerTrade === (1000n * 10n ** 18n).toString(), "業主以 29,000 買入、撥款 30,000：賺賠計入 1,000，工程款不計");
  // 賠錢的情況：單獨驗算（D 低於買入價賣出）
  const lossFlow = await page.evaluate(([me, other]) => flowOf([
    { fragment: { name: "Sold" }, blockNumber: 1, args: { id: 9n, seller: other, buyer: me, price: 29484n * 10n ** 18n } },
    { fragment: { name: "Sold" }, blockNumber: 2, args: { id: 9n, seller: me, buyer: other, price: 29200n * 10n ** 18n } },
  ], me).profit.toString(), [D, F]);
  ok(lossFlow === (-284n * 10n ** 18n).toString(), "低價賣出：算出賠 284");
  ok(errors.length === 0, "MTK 流程沒有 JavaScript 錯誤" + (errors.length ? "：" + errors.join("; ") : ""));

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: path.join(__dirname, "ui.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  ok(!overflow, "手機寬度沒有水平捲動");

  console.log(`\n結果：${pass} 通過，${fail} 失敗`);
  await browser.close(); web.close(); await server.close();
  process.exit(fail ? 1 : 0);
})().catch(async e => { console.error(e); process.exit(1); });
