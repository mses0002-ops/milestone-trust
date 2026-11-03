// deploy.js 與 prepare.js 共用：讀 .env、連線、送交易、遮蔽機密
// 相依套件沿用 test/node_modules，不另外安裝
const fs = require("fs");
const path = require("path");
const { createRequire } = require("module");

const ROOT = path.join(__dirname, "..");
const testRequire = createRequire(path.join(ROOT, "test", "package.json"));
const { ethers } = testRequire("ethers");

const SEPOLIA_ID = 11155111n;
const TOKEN = "0x9cDF42E5680b0ac33ce51B1132Cb1856684Fd208";   // 課堂代幣 MTK（18 位小數，只有 owner 能 mint）
const EXPLORER = "https://sepolia.etherscan.io";
const LOCAL_PORT = 8547;
const DAY = 86400;
const GRACE = 5184000;   // 60 天

const USDC_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function mint(address,uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];
const TRUST_ABI = [
  "function DAY() view returns (uint256)",
  "function GRACE() view returns (uint256)",
  "function oracle() view returns (address)",
  "function projectCount() view returns (uint256)",
  "function milestoneCount() view returns (uint256)",
  "function currentTime() view returns (uint256)",
  "function createProject(address contractor, address attester, uint256[] faces, uint256[] deadlines) returns (uint256, uint256)",
];

// ───────────────────────── 機密遮蔽 ─────────────────────────
// 所有輸出都經過 scrub：錯誤訊息可能夾帶 RPC URL（內含 API key）
const secrets = [];
function scrub(text) {
  let out = String(text);
  for (const s of secrets) out = out.split(s).join("[已遮蔽]");
  return out;
}
const log = msg => console.log(scrub(msg));

// 預期中的停止：只印原因，不印 stack
class Stop extends Error {}
const stop = msg => { throw new Stop(msg); };

function errorText(e) {
  if (e instanceof Stop) return e.message;
  if (e.code === "INSUFFICIENT_FUNDS") return "帳號的 Sepolia ETH 不足以支付這筆交易";
  if (e.code === "ACTION_REJECTED") return "交易被拒絕";
  return e.reason || e.shortMessage || e.message || String(e);
}

// ───────────────────────── .env ─────────────────────────
function loadEnv({ needRpc }) {
  const file = path.join(ROOT, ".env");
  if (!fs.existsSync(file)) stop("找不到 .env，請放在專案根目錄");
  process.loadEnvFile(file);

  const names = ["PK_E", "PK_A", "PK_D", "ADDR_B", "ADDR_C"].concat(needRpc ? ["SEPOLIA_RPC_URL"] : []);
  const missing = names.filter(n => !process.env[n] || !process.env[n].trim());
  if (missing.length) stop(`.env 缺少或未填：${missing.join("、")}`);

  // 一次列出所有問題，只提欄位名稱，不提內容
  const env = {}, bad = [];
  for (const n of ["PK_E", "PK_A", "PK_D"]) {
    const v = process.env[n].trim();
    secrets.push(v);
    if (!/^(0x)?[0-9a-fA-F]{64}$/.test(v)) { bad.push(`${n}（應為私鑰：64 位十六進位，可含 0x）`); continue; }
    env[n] = v.startsWith("0x") ? v : "0x" + v;
    secrets.push(env[n]);
  }
  for (const n of ["ADDR_B", "ADDR_C"]) {
    try { env[n] = ethers.getAddress(process.env[n].trim()); }
    catch (_) { bad.push(`${n}（應為地址：0x 開頭、共 42 字元）`); }
  }
  if (bad.length) stop(`.env 格式不對：${bad.join("、")}`);
  if (needRpc) {
    env.SEPOLIA_RPC_URL = process.env.SEPOLIA_RPC_URL.trim();
    secrets.push(env.SEPOLIA_RPC_URL);
    const lastPart = env.SEPOLIA_RPC_URL.split("/").pop();
    if (lastPart.length >= 8) secrets.push(lastPart);   // 路徑最後一段通常是 API key
  }
  return env;
}

function wallets(env, provider) {
  const E = new ethers.Wallet(env.PK_E, provider);
  const A = new ethers.Wallet(env.PK_A, provider);
  const D = new ethers.Wallet(env.PK_D, provider);
  const all = [E.address, A.address, D.address, env.ADDR_B, env.ADDR_C].map(a => a.toLowerCase());
  if (new Set(all).size !== all.length) stop("E、A、D、ADDR_B、ADDR_C 必須是 5 個不同的地址");
  return { E, A, D };
}

// ───────────────────────── 連線 ─────────────────────────
// 先用一般請求確認 chain ID：ethers 連不上時會無限重試，這裡要能明確失敗
async function chainIdOf(url) {
  let res, lastError;
  for (let attempt = 1; attempt <= 4 && !res; attempt++) {   // 連線偶爾逾時；這裡還沒送交易，可以安全重試
    try {
      res = await fetch(url, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
        signal: AbortSignal.timeout(20000),
      });
    } catch (e) {
      lastError = e;
      if (e.cause?.code === "ERR_INVALID_URL") break;
      if (attempt < 4) { log(`連線逾時，重試中（第 ${attempt} 次）`); await sleep(3000); }
    }
  }
  // 只回報錯誤代碼：完整訊息可能含網址
  if (!res) stop(`連不上 SEPOLIA_RPC_URL（${lastError.cause?.code || lastError.name}），請確認網址與網路`);
  if (!res.ok) stop(`SEPOLIA_RPC_URL 回應錯誤（HTTP ${res.status}），請確認網址或 API key`);
  const json = await res.json().catch(() => null);
  if (!json || !json.result) stop("SEPOLIA_RPC_URL 沒有回傳 chain ID");
  return BigInt(json.result);
}

function assertSepolia(id) {
  if (id !== SEPOLIA_ID) stop(`chain ID 是 ${id}，不是 Sepolia（${SEPOLIA_ID}），停止`);
}

async function connectSepolia(env) {
  assertSepolia(await chainIdOf(env.SEPOLIA_RPC_URL));
  log(`chain ID ${SEPOLIA_ID}（Sepolia）確認`);
  return new ethers.JsonRpcProvider(env.SEPOLIA_RPC_URL, ethers.Network.from(SEPOLIA_ID), { staticNetwork: true });
}

// ───────────────────────── 餘額 ─────────────────────────
async function printBalances(provider, { E, A, D }) {
  const rows = [];
  for (const [name, w] of [["E", E], ["A", A], ["D", D]]) {
    const wei = await provider.getBalance(w.address);
    rows.push({ name, address: w.address, wei });
    log(`  ${name} ${w.address}  ${ethers.formatEther(wei)} ETH`);
  }
  return rows;
}

function assertBalances(rows) {
  const min = { E: ethers.parseEther("0.02"), A: ethers.parseEther("0.005"), D: ethers.parseEther("0.005") };
  const low = rows.filter(r => r.wei < min[r.name]);
  if (low.length) stop("Sepolia ETH 不足：" + low.map(r => `${r.name} 需要至少 ${ethers.formatEther(min[r.name])}，目前 ${ethers.formatEther(r.wei)}`).join("；"));
}

// ───────────────────────── 交易 ─────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));
const txLine = (ctx, hash) => ctx.local ? `${hash}（本地）` : `${EXPLORER}/tx/${hash}`;

// 送出前的模擬失敗可能只是 RPC 節點還沒看到上一筆交易，所以重試；交易一旦送出就不再重試
async function sendTx(ctx, label, fn) {
  let tx;
  for (let attempt = 1; ; attempt++) {
    try { tx = await fn(); break; }
    catch (e) {
      if (e.code !== "CALL_EXCEPTION" || attempt >= 4) stop(`${label} 失敗：${errorText(e)}`);
      await sleep(4000);
    }
  }
  log(`  ${label}：${txLine(ctx, tx.hash)}`);
  let receipt;
  try { receipt = await tx.wait(1, 600000); }
  catch (e) { stop(`${label} 失敗：${errorText(e)}（交易 ${tx.hash}）`); }
  if (!receipt || receipt.status !== 1) stop(`${label} 失敗：交易被 revert（${tx.hash}）`);
  return receipt;
}

// 這次部署的名稱：預設 live；--practice 是 practice；--env live_2 可自訂（對應網址 ?env=live_2）
function envName() {
  const i = process.argv.indexOf("--env");
  if (i >= 0) {
    const name = process.argv[i + 1] || "";
    if (!/^[A-Za-z0-9_-]+$/.test(name)) stop("--env 後面要接名稱，只能用英數字、底線或連字號");
    return name;
  }
  return process.argv.includes("--practice") ? "practice" : "live";
}

// 把地址寫進前端的設定檔，之後用 ?env=practice、?env=live 就能開啟
function writeFrontendConfig(deployment, owner, contractor, attester) {
  const name = envName();
  const file = path.join(ROOT, "frontend", "deployments.json");
  let all = {};
  try { all = JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) {}
  all[name] = { usdc: deployment.usdc, trust: deployment.trust, from: deployment.fromBlock, owner, contractor, attester };
  fs.writeFileSync(file, JSON.stringify(all, null, 2) + "\n");
  return `http://localhost:8000/?env=${name}`;
}

function deploymentFile(local) {
  if (local) return path.join(ROOT, "deployment.local.json");
  // 除了正式版，其他部署都另外存檔，不會蓋掉正式 demo 的 deployment.json
  const name = envName();
  return path.join(ROOT, name === "live" ? "deployment.json" : `deployment.${name}.json`);
}

// 統一的進入點：印出乾淨的原因並以非 0 結束
function runMain(main) {
  main().then(() => process.exit(0)).catch(e => {
    if (e instanceof Stop) console.error(scrub("\n停止：" + e.message));
    else console.error(scrub("\n發生未預期的錯誤：" + errorText(e)));
    process.exit(1);
  });
}

module.exports = {
  ROOT, ethers, testRequire, TOKEN, DAY, GRACE, USDC_ABI, TRUST_ABI, LOCAL_PORT,
  log, stop, scrub, errorText, loadEnv, wallets, assertSepolia, connectSepolia, printBalances, assertBalances,
  sendTx, txLine, deploymentFile, writeFrontendConfig, runMain,
};
