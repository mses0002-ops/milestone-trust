// 部署 MilestoneTrust（交易代幣用課堂代幣 MTK），完成後自動執行 prepare
//   node scripts/deploy.js           部署到 Sepolia（寫入 deployment.json）
//   node scripts/deploy.js --practice 部署實操用合約到 Sepolia（寫入 deployment.practice.json，不動正式版）
//   node scripts/deploy.js --env live_2 部署備用合約（寫入 deployment.live_2.json，網址 ?env=live_2）
//   node scripts/deploy.js --local   用本地 ganache 演練，不花錢（代幣改用 18 位小數的本地測試幣，寫入 deployment.local.json）
const fs = require("fs");
const path = require("path");
const c = require("./common");
const { prepare } = require("./prepare");
const { ethers } = c;

const local = process.argv.includes("--local");

function compile() {
  const solc = c.testRequire("solc");
  const files = ["MockUSDC.sol", "MilestoneTrust.sol"];
  // 本地測試幣：MockUSDC 的原始碼改成 18 位小數、符號 MTK，不另外留合約檔
  const localToken = fs.readFileSync(path.join(c.ROOT, "contracts", "MockUSDC.sol"), "utf8")
    .replace("contract MockUSDC", "contract LocalMTK").replace('"Mock USDC"', '"Local MTK"').replace('"mUSDC"', '"MTK"').replace("decimals = 6", "decimals = 18");
  const out = JSON.parse(solc.compile(JSON.stringify({
    language: "Solidity",
    sources: Object.assign(Object.fromEntries(files.map(f => [f, { content: fs.readFileSync(path.join(c.ROOT, "contracts", f), "utf8") }])), { "LocalMTK.sol": { content: localToken } }),
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "shanghai", outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
  })));
  const errors = (out.errors || []).filter(e => e.severity === "error");
  if (errors.length) c.stop("合約編譯失敗：" + errors[0].formattedMessage);
  return { token: out.contracts["LocalMTK.sol"].LocalMTK, trust: out.contracts["MilestoneTrust.sol"].MilestoneTrust };
}

async function deployOne(ctx, label, artifact, signer, args) {
  const factory = new ethers.ContractFactory(artifact.abi, "0x" + artifact.evm.bytecode.object, signer);
  let contract;
  try { contract = await factory.deploy(...args); }
  catch (e) { c.stop(`部署 ${label} 失敗：${c.errorText(e)}`); }
  const tx = contract.deploymentTransaction();
  c.log(`  部署 ${label}：${c.txLine(ctx, tx.hash)}`);
  const receipt = await tx.wait(1, 600000);
  if (!receipt || receipt.status !== 1) c.stop(`部署 ${label} 失敗：交易被 revert（${tx.hash}）`);
  return { address: await contract.getAddress(), block: receipt.blockNumber };
}

async function startLocal(env) {
  const ganache = c.testRequire("ganache");
  const accounts = [env.PK_E, env.PK_A, env.PK_D].map(secretKey => ({ secretKey, balance: "0x56BC75E2D63100000" }));   // 100 ETH
  const server = ganache.server({ logging: { quiet: true }, chain: { chainId: 1337, hardfork: "shanghai" }, wallet: { accounts } });
  await server.listen(c.LOCAL_PORT);
  const provider = new ethers.JsonRpcProvider(`http://127.0.0.1:${c.LOCAL_PORT}`, ethers.Network.from(1337), { staticNetwork: true, pollingInterval: 100 });
  c.log("本地 ganache 已啟動（略過 chain ID 檢查，不會碰到 Sepolia）");
  return provider;
}

// 送出任何交易前先確認代幣正確、A 和 D 的 MTK 夠用，免得白花 gas
async function preflightToken(provider, wallets, env) {
  if ((await provider.getCode(c.TOKEN)) === "0x") c.stop(`代幣地址 ${c.TOKEN} 上沒有合約`);
  const token = new ethers.Contract(c.TOKEN, c.USDC_ABI, provider);
  const [symbol, decimals] = await Promise.all([token.symbol(), token.decimals()]);
  if (symbol !== "MTK" || decimals !== 18n) c.stop(`代幣不是預期的 MTK（符號 ${symbol}、小數 ${decimals}）`);
  c.log(`\n${symbol} 餘額（${c.TOKEN}）`);
  const rows = [["E", wallets.E.address, 0], ["A", wallets.A.address, 90000], ["B", env.ADDR_B, 0], ["C", env.ADDR_C, 0], ["D", wallets.D.address, 30000]];
  const low = [];
  for (const [name, address, need] of rows) {
    const bal = await token.balanceOf(address);
    c.log(`  ${name} ${address}  ${ethers.formatUnits(bal, decimals)}`);
    if (bal < ethers.parseUnits(String(need), decimals)) low.push(`${name} 需要至少 ${need}`);
  }
  if (low.length) c.stop(`MTK 不足，尚未送出任何交易：${low.join("；")}`);
}

c.runMain(async () => {
  const env = c.loadEnv({ needRpc: !local });
  const provider = local ? await startLocal(env) : await c.connectSepolia(env);
  const wallets = c.wallets(env, provider);
  const ctx = { local };

  c.log("\n帳號與 ETH 餘額");
  c.assertBalances(await c.printBalances(provider, wallets));

  if (!local) await preflightToken(provider, wallets, env);

  const art = compile();
  c.log("\n部署合約");
  const tokenAddress = local ? (await deployOne(ctx, "本地測試幣", art.token, wallets.E, [])).address : c.TOKEN;
  const trust = await deployOne(ctx, "MilestoneTrust", art.trust, wallets.E, [tokenAddress, wallets.E.address, c.DAY, c.GRACE]);

  const deployment = {
    network: local ? "local" : "sepolia",
    usdc: tokenAddress,
    trust: trust.address,
    fromBlock: trust.block,
    oracle: wallets.E.address,
    day: c.DAY,
    grace: c.GRACE,
    frontendUrl: `http://localhost:8000/?usdc=${tokenAddress}&trust=${trust.address}&from=${trust.block}&owner=${wallets.A.address}&contractor=${env.ADDR_B}&attester=${env.ADDR_C}`,
  };
  // prepare 之前就先存：prepare 中途失敗時，才能用 prepare.js 接著做
  fs.writeFileSync(c.deploymentFile(local), JSON.stringify(deployment, null, 2) + "\n");
  if (!local) deployment.frontendUrl = c.writeFrontendConfig(deployment, wallets.A.address, env.ADDR_B, env.ADDR_C);

  await prepare({ provider, wallets, env, deployment, local });

  c.log("\n部署結果");
  c.log(`  交易代幣       ${deployment.usdc}`);
  c.log(`  MilestoneTrust ${deployment.trust}`);
  c.log(`  部署區塊       ${deployment.fromBlock}`);
  c.log(`  前端網址       ${deployment.frontendUrl}`);
  c.log(`  已寫入         ${path.basename(c.deploymentFile(local))}`);
  c.log("\n剩餘 ETH");
  await c.printBalances(provider, wallets);
  c.log("\n啟動前端：在 frontend 資料夾執行 python -m http.server 8000");
});
