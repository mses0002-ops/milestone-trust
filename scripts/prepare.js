// 準備 demo：確認 A、D 的代幣足夠、投資人事先授權。專案由 A 在頁面上建立
// 可單獨重跑：node scripts/prepare.js（已完成的步驟會略過）
// Sepolia 上的 MTK 只有 owner 能 mint，所以 A、D 要先從其他錢包轉入；本地演練用可 mint 的測試幣
const fs = require("fs");
const c = require("./common");
const { ethers } = c;

const A_NEED = 90000, D_NEED = 30000;

async function prepare({ provider, wallets, env, deployment, local }) {
  const { A, D } = wallets;
  const ctx = { local };
  const usdc = new ethers.Contract(deployment.usdc, c.USDC_ABI, provider);
  const trust = new ethers.Contract(deployment.trust, c.TRUST_ABI, provider);
  for (const [name, addr] of [["交易代幣", deployment.usdc], ["MilestoneTrust", deployment.trust]]) {
    if ((await provider.getCode(addr)) === "0x") c.stop(`${name} 地址 ${addr} 上沒有合約，請確認部署與網路`);
  }
  const decimals = await usdc.decimals(), symbol = await usdc.symbol();
  const U = x => ethers.parseUnits(String(x), decimals);

  // 餘額不足時：本地直接領，Sepolia 停下來說明要轉多少
  const ensureBalance = async (name, wallet, need) => {
    const bal = await usdc.balanceOf(wallet.address);
    if (bal >= U(need)) return c.log(`  ${name} 的 ${symbol} 已足夠（${ethers.formatUnits(bal, decimals)}）`);
    if (!local) c.stop(`${name} 的 ${symbol} 不足：需要至少 ${need}，目前 ${ethers.formatUnits(bal, decimals)}。請先轉入 ${wallet.address}`);
    await c.sendTx(ctx, `${name} 領本地測試幣`, () => usdc.connect(wallet).mint(wallet.address, U(1000000)));
  };

  c.log("\n準備 demo");
  await ensureBalance("A", A, A_NEED);
  await ensureBalance("D", D, D_NEED);
  if ((await usdc.allowance(D.address, deployment.trust)) < U(D_NEED))
    await c.sendTx(ctx, `D 授權 ${D_NEED} ${symbol}`, () => usdc.connect(D).approve(deployment.trust, U(D_NEED)));
  else c.log("  D 的授權已足夠，略過");

  // 確認鏈上結果，而不是只相信交易成功
  const projects = await trust.projectCount();
  const checks = [
    [(await usdc.balanceOf(A.address)) >= U(A_NEED) || projects > 0n, `A 持有至少 ${A_NEED} ${symbol}（或已建立專案）`],
    [(await usdc.allowance(D.address, deployment.trust)) >= U(D_NEED), `D 已授權 ${D_NEED} ${symbol}`],
    [(await trust.DAY()) === BigInt(c.DAY) && (await trust.GRACE()) === BigInt(c.GRACE), "DAY = 86400、GRACE = 5184000"],
    [(await trust.oracle()) === wallets.E.address, "機率來源是 E"],
  ];
  c.log("\n鏈上檢查");
  for (const [pass, text] of checks) c.log(`  ${pass ? "通過" : "失敗"}：${text}`);
  if (checks.some(([pass]) => !pass)) c.stop("鏈上狀態與預期不符");
  c.log(`  目前專案數：${projects}（由 A 在頁面上設定期數、金額與間隔天數後建立）`);
}

module.exports = { prepare };

// 單獨執行：對 Sepolia，讀 deployment.json
if (require.main === module) {
  c.runMain(async () => {
    const file = c.deploymentFile(false);
    if (!fs.existsSync(file)) c.stop("找不到 deployment.json，請先執行 node scripts/deploy.js");
    const deployment = JSON.parse(fs.readFileSync(file, "utf8"));
    const env = c.loadEnv({ needRpc: true });
    const provider = await c.connectSepolia(env);
    const wallets = c.wallets(env, provider);
    await prepare({ provider, wallets, env, deployment, local: false });
    c.log("\n剩餘 Sepolia ETH");
    await c.printBalances(provider, wallets);
  });
}
