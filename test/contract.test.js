// 本地驗收測試：編譯兩份合約 → ganache 本地鏈 → 跑規格 12.1 的 13 個步驟與邊界情況
const fs = require("fs");
const path = require("path");
const solc = require("solc");
const ganache = require("ganache");
const { ethers } = require("ethers");

const SRC = process.argv[2];
const files = ["MockUSDC.sol", "MilestoneTrust.sol"];
const input = {
  language: "Solidity",
  sources: Object.fromEntries(files.map(f => [f, { content: fs.readFileSync(path.join(SRC, f), "utf8") }])),
  settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "shanghai",
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
};
// 模擬 MTK 的小數位數：MockUSDC 的原始碼改成 18 位小數
input.sources["LocalMTK.sol"] = { content: fs.readFileSync(path.join(SRC, "MockUSDC.sol"), "utf8")
  .replace("contract MockUSDC", "contract LocalMTK").replace('"mUSDC"', '"MTK"').replace("decimals = 6", "decimals = 18") };
const out = JSON.parse(solc.compile(JSON.stringify(input)));
const errs = (out.errors || []).filter(e => e.severity === "error");
(out.errors || []).forEach(e => console.log(e.severity.toUpperCase(), e.formattedMessage.split("\n")[0]));
if (errs.length) process.exit(1);
const art = (f, c) => out.contracts[f][c];
fs.writeFileSync(path.join(__dirname, "abi.json"), JSON.stringify({
  MockUSDC: art("MockUSDC.sol", "MockUSDC").abi, MilestoneTrust: art("MilestoneTrust.sol", "MilestoneTrust").abi }, null, 1));

const U = x => ethers.parseUnits(String(x), 6);
const F = x => ethers.formatUnits(x, 6);
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log("  ✓", msg); } else { fail++; console.log("  ✗", msg); } };
async function reverts(p, reason, msg) {
  try { await (await p).wait?.(); ok(false, msg + "（應該失敗卻成功）"); }
  catch (e) { const m = (e.shortMessage || "") + (e.message || "") + JSON.stringify(e.info || {}); ok(m.includes(reason), `${msg} → revert "${reason}"`); }
}

(async () => {
  // cacheTimeout -1：關掉 ethers 預設 250ms 的請求快取，否則連續兩筆相同交易會沿用舊的 estimateGas，測試偶爾拿不到 revert 原因
  const provider = new ethers.BrowserProvider(ganache.provider({ logging: { quiet: true }, chain: { hardfork: "shanghai" } }), undefined, { cacheTimeout: -1 });
  const [E, A, B, C, D] = await Promise.all([0, 1, 2, 3, 4].map(i => provider.getSigner(i)));
  const deploy = async (c, signer, ...args) => {
    const f = new ethers.ContractFactory(c.abi, "0x" + c.evm.bytecode.object, signer);
    const x = await f.deploy(...args); await x.waitForDeployment(); return x;
  };
  const DAY = 86400, GRACE = 5184000;
  const addr = s => s.getAddress();
  const advance = async n => { await (await trust.connect(E).advanceTime(n)).wait(); };

  console.log("步驟 1：部署（DAY=86400、GRACE=5184000）與 mint");
  const usdc = await deploy(art("MockUSDC.sol", "MockUSDC"), E);
  const trust = await deploy(art("MilestoneTrust.sol", "MilestoneTrust"), E, await usdc.getAddress(), await addr(E), DAY, GRACE);
  const T = await trust.getAddress();
  await (await usdc.mint(await addr(A), U(100000))).wait();
  await (await usdc.mint(await addr(D), U(100000))).wait();
  ok((await usdc.balanceOf(await addr(A))) === U(100000), "業主拿到 100,000 mUSDC");
  ok((await trust.DAY()) === 86400n && (await trust.GRACE()) === 5184000n, "DAY、GRACE 為真實秒數");

  console.log("步驟 2：業主建立 3 期（20,000／40,000／30,000），期限 25、55、90 天後");
  const t0 = await trust.currentTime();
  const dl = n => t0 + BigInt(n * DAY);
  await (await usdc.connect(A).approve(T, U(90000))).wait();
  await reverts(trust.connect(A).createProject(await addr(B), await addr(A), [U(1)], [dl(1)]), "attester must be independent", "監造方不能是業主");
  await reverts(trust.connect(A).createProject(await addr(B), await addr(B), [U(1)], [dl(1)]), "attester must be independent", "監造方不能是承包商");
  await reverts(trust.connect(A).createProject(await addr(A), await addr(C), [U(1)], [dl(1)]), "owner cannot be contractor", "業主不能是承包商");
  await reverts(trust.connect(A).createProject(await addr(E), await addr(C), [U(1)], [dl(1)]), "oracle cannot hold", "機率來源不能當承包商");
  await reverts(trust.connect(A).createProject(await addr(B), await addr(C), [0n], [dl(1)]), "face must be > 0", "面額不能為 0");
  await reverts(trust.connect(A).createProject(await addr(B), await addr(C), [U(1)], [t0]), "deadline in the past", "期限必須在未來");
  await reverts(trust.connect(A).createProject(await addr(B), await addr(C), Array(11).fill(U(1)), Array(11).fill(dl(1))), "1 to 10 milestones", "期數不能超過 10");
  ok((await usdc.balanceOf(T)) === 0n, "建立失敗時沒有轉任何錢");
  await (await trust.connect(A).createProject(await addr(B), await addr(C), [U(20000), U(40000), U(30000)], [dl(25), dl(55), dl(90)])).wait();
  ok((await usdc.balanceOf(T)) === U(90000), "信託持有 90,000");
  ok((await trust.milestones(1)).face === U(20000) && (await trust.milestones(2)).face === U(40000) && (await trust.milestones(3)).face === U(30000), "每期金額可以不同");
  ok((await trust.balanceOf(await addr(B))) === 3n && (await trust.ownerOf(3)) === await addr(B), "承包商持有 3 張 NFT");

  console.log("步驟 3：p = 0 時上架失敗");
  await reverts(trust.connect(B).list(3, U(29480)), "not tradable", "p = 0 時不能上架");

  console.log("步驟 4：機率來源設 p = 99，承包商以 29,480 上架");
  await reverts(trust.connect(A).setProbability(3, 99), "only oracle", "只有機率來源能設 p");
  await (await trust.connect(E).setProbability(3, 99)).wait();
  await reverts(trust.connect(B).list(3, U(30000) + 1n), "price above face", "承包商不能以高於面額的價格上架（多 1 個最小單位也不行）");
  await (await trust.connect(B).list(3, U(30000))).wait();
  ok((await trust.milestones(3)).listPrice === U(30000), "售價等於面額可以上架");
  await (await trust.connect(B).list(3, U(29480))).wait();
  ok((await trust.milestones(3)).listPrice === U(29480), "第 3 期以 29,480 上架");

  console.log("步驟 5：監造方與機率來源不能購買");
  await reverts(trust.connect(C).buy(3, U(29480)), "attester cannot hold", "監造方不能購買自己專案的請款權");
  await reverts(trust.connect(E).buy(3, U(29480)), "oracle cannot hold", "機率來源不能購買");

  console.log("步驟 6：投資人購買（原子交換）");
  const bBefore = await usdc.balanceOf(await addr(B));
  await (await usdc.connect(D).approve(T, U(29480))).wait();
  await reverts(trust.connect(D).buy(3, U(29000)), "price changed", "maxPrice 低於售價會被擋");
  await (await trust.connect(D).buy(3, U(29480))).wait();
  ok((await trust.ownerOf(3)) === await addr(D), "投資人取得 NFT");
  ok((await usdc.balanceOf(await addr(B))) - bBefore === U(29480), "承包商收到 29,480");
  ok((await trust.milestones(3)).listPrice === 0n, "成交後上架清除");
  await reverts(trust.connect(D).list(3, U(30001)), "price above face", "投資人轉售也不能高於面額");
  await reverts(trust.connect(D).transferFrom(await addr(D), await addr(C), 3), "attester cannot hold", "不能私下轉給監造方");
  await reverts(trust.connect(D).transferFrom(await addr(D), await addr(E), 3), "oracle cannot hold", "不能私下轉給機率來源");
  await reverts(trust.connect(D)["safeTransferFrom(address,address,uint256)"](await addr(D), await addr(C), 3), "attester cannot hold", "safeTransferFrom 也不能轉給監造方");

  console.log("步驟 7：p 調到 60，轉讓全面暫停");
  await (await trust.connect(E).setProbability(3, 60)).wait();
  await reverts(trust.connect(D).list(3, U(29900)), "not tradable", "p < 70 不能上架");
  await reverts(trust.connect(D).transferFrom(await addr(D), await addr(A), 3), "not tradable", "p < 70 私下 transferFrom 也被擋");
  ok((await trust.ownerOf(3)) === await addr(D), "已持有者不受影響");

  console.log("步驟 8：監造方回報第 3 期進度 60%");
  const prog = ethers.id("進度報告.pdf");
  await reverts(trust.connect(A).reportProgress(3, 6000, prog), "only attester", "只有監造方能回報進度");
  await reverts(trust.connect(C).reportProgress(3, 10001, prog), "bps must be <= 10000", "進度不能超過 100%");
  await reverts(trust.connect(C).reportProgress(3, 6000, ethers.ZeroHash), "evidence required", "回報進度要附證據");
  await (await trust.connect(C).reportProgress(3, 6000, prog)).wait();
  const m3 = await trust.milestones(3);
  ok(m3.progressBps === 6000n && m3.progressAt >= t0, "記錄最新進度 60% 與時間");
  ok(m3.status === 0n && m3.face === U(30000), "回報進度不改變狀態與面額");
  const progEv = (await trust.queryFilter("ProgressReported", 0)).at(-1);
  ok(progEv.args.bps === 6000n && progEv.args.evidenceHash === prog && progEv.args.reportedAt === m3.progressAt, "進度事件含比例、證據與時間");

  console.log("步驟 9：非 demo 管理員快轉失敗");
  await reverts(trust.connect(A).advanceTime(1), "only oracle", "業主不能快轉");
  await reverts(trust.connect(D).advanceTime(1), "only oracle", "投資人不能快轉");
  await reverts(trust.connect(E).advanceTime(0), "days must be >= 1", "快轉天數至少 1 天");
  const h = ethers.id("驗收報告.pdf");
  await reverts(trust.connect(C).terminate(1, 7000, h), "grace period not over", "寬限期內不能終止");

  console.log("步驟 10：快轉 92 天，申報、駁回、再申報，再快轉 5 天後核准");
  const off0 = await trust.timeOffset();
  await advance(92);
  ok((await trust.timeOffset()) === off0 + BigInt(92 * DAY), "timeOffset 增加 92 天");
  const latest = BigInt((await provider.getBlock("latest")).timestamp);
  ok((await trust.currentTime()) === latest + BigInt(92 * DAY), "合約時間 = block.timestamp + timeOffset");
  await reverts(trust.connect(D).claimComplete(3, h), "only contractor", "只有承包商能申報");
  await (await trust.connect(B).claimComplete(3, h)).wait();
  ok((await trust.milestones(3)).claimedAt >= dl(92), "申報時間用合約時間記錄");
  await reverts(trust.connect(D).transferFrom(await addr(D), await addr(A), 3), "not tradable", "Claimed 狀態不能轉讓");
  await reverts(trust.connect(A).rejectClaim(3, 9000, prog), "only attester", "只有監造方能駁回");
  await reverts(trust.connect(C).rejectClaim(3, 10000, prog), "bps must be < 10000", "完成 100% 不能駁回，應該核准");
  await reverts(trust.connect(C).rejectClaim(3, 8000, ethers.ZeroHash), "evidence required", "駁回要附證據");
  await (await trust.connect(C).rejectClaim(3, 8000, prog)).wait();
  const rejected = await trust.milestones(3);
  ok(rejected.claimedAt === 0n && rejected.status === 0n, "駁回後回到 Active，申報時間歸零");
  ok(rejected.progressBps === 8000n && rejected.progressAt > 0n, "駁回同一筆交易記下進度 80%");
  const lastProg = (await trust.queryFilter("ProgressReported", 0)).at(-1);
  ok(lastProg.args.bps === 8000n && lastProg.args.evidenceHash === prog, "駁回時也發出進度事件（含證據）");
  await reverts(trust.connect(C).rejectClaim(3, 8000, prog), "not claimed", "沒有申報時不能駁回");
  await (await trust.connect(B).claimComplete(3, h)).wait();
  await (await trust.connect(C).reportProgress(3, 9000, prog)).wait();
  ok((await trust.milestones(3)).progressBps === 9000n, "Claimed 狀態也能回報進度");
  await advance(5);   // 監造方拖延 5 天才核准
  const [pen, late] = await trust.penaltyOf(3);
  ok(late === 2n && pen === U(60), `拖延核准不增加違約金：延誤 ${late} 天、違約金 ${F(pen)}`);
  const aBefore = await usdc.balanceOf(await addr(A));
  const dBefore = await usdc.balanceOf(await addr(D));
  await reverts(trust.connect(A).attest(3), "only attester", "只有監造方能核准");
  await (await trust.connect(C).attest(3)).wait();
  ok((await usdc.balanceOf(await addr(D))) - dBefore === U(29940), "投資人收到 29,940");
  ok((await usdc.balanceOf(await addr(A))) - aBefore === U(60), "業主收到違約金 60");
  await reverts(trust.connect(C).attest(3), "not claimed", "不能重複撥款");
  await reverts(trust.connect(C).reportProgress(3, 7000, prog), "already settled", "已撥款不能再回報進度");

  console.log("步驟 11：第 1 期已超過寬限期，申報失敗");
  await reverts(trust.connect(B).claimComplete(1, h), "grace period over", "寬限期過後不能再申報");

  console.log("步驟 12：監造方終止第 1 期，完成比例 70%");
  const a2 = await usdc.balanceOf(await addr(A)), b2 = await usdc.balanceOf(await addr(B));
  await reverts(trust.connect(C).terminate(1, 10001, h), "bps must be <= 10000", "完成比例不能超過 100%");
  await (await trust.connect(C).terminate(1, 7000, ethers.id("鑑定報告.pdf"))).wait();
  ok((await usdc.balanceOf(await addr(B))) - b2 === U(14000), "承包商（持有人）收到 14,000");
  ok((await usdc.balanceOf(await addr(A))) - a2 === U(6000), "業主收回 6,000");
  ok((await usdc.balanceOf(T)) === U(40000), `信託剩餘 ${F(await usdc.balanceOf(T))}（第 2 期未結算）`);
  await reverts(trust.connect(C).terminate(2, 7000, h), "grace period not over", "第 2 期（55 + 60 天）還在寬限期內，不能終止");

  console.log("步驟 13：稽核事件");
  const evs = await trust.queryFilter("*", 0);
  const names = new Set(evs.map(e => e.fragment?.name));
  const need = ["ProjectCreated", "ProbabilitySet", "Listed", "Sold", "ProgressReported", "TimeAdvanced", "CompletionClaimed", "ClaimRejected", "MilestonePaid", "MilestoneTerminated"];
  ok(need.every(n => names.has(n)), "事件完整：" + need.join(", "));

  console.log("額外：如期完工");
  const t1 = await trust.currentTime();
  await (await usdc.connect(A).approve(T, U(10000))).wait();
  await (await trust.connect(A).createProject(await addr(B), await addr(C), [U(10000)], [t1 + BigInt(3 * DAY)])).wait();
  const id = await trust.milestoneCount();
  await (await trust.connect(B).claimComplete(id, h)).wait();
  const b3 = await usdc.balanceOf(await addr(B));
  await (await trust.connect(C).attest(id)).wait();
  ok((await usdc.balanceOf(await addr(B))) - b3 === U(10000), "如期完工拿到全額 10,000");

  console.log("額外：C7 所有時間判斷都用合約時間");
  const realNow = BigInt((await provider.getBlock("latest")).timestamp);
  await reverts(trust.connect(A).createProject(await addr(B), await addr(C), [U(1)], [realNow + BigInt(DAY)]), "deadline in the past", "真實時間的未來、合約時間的過去：視為過期");

  console.log("額外：C1 其他專案的監造方可以購買");
  const t2 = await trust.currentTime();
  await (await usdc.mint(await addr(A), U(1000))).wait();
  await (await usdc.mint(await addr(C), U(1000))).wait();
  await (await usdc.connect(A).approve(T, U(1000))).wait();
  await (await trust.connect(A).createProject(await addr(B), await addr(D), [U(1000)], [t2 + BigInt(DAY)])).wait();
  const otherId = await trust.milestoneCount();
  await (await trust.connect(E).setProbability(otherId, 99)).wait();
  await (await trust.connect(B).list(otherId, U(900))).wait();
  await (await usdc.connect(C).approve(T, U(900))).wait();
  await (await trust.connect(C).buy(otherId, U(900))).wait();
  ok((await trust.ownerOf(otherId)) === await addr(C), "C 監造專案 1，仍可購買 D 監造的專案");

  console.log("額外：§8 延誤 300 天，違約金封頂 20%（另部署寬限期 400 天的合約）");
  const capped = await deploy(art("MilestoneTrust.sol", "MilestoneTrust"), E, await usdc.getAddress(), await addr(E), DAY, 400 * DAY);
  const CT = await capped.getAddress();
  const t3 = await capped.currentTime();
  await (await usdc.mint(await addr(A), U(30000))).wait();
  await (await usdc.connect(A).approve(CT, U(30000))).wait();
  await (await capped.connect(A).createProject(await addr(B), await addr(C), [U(30000)], [t3 + BigInt(DAY)])).wait();
  await (await capped.connect(E).advanceTime(301)).wait();
  await (await capped.connect(B).claimComplete(1, h)).wait();
  const a4 = await usdc.balanceOf(await addr(A)), b4 = await usdc.balanceOf(await addr(B));
  await (await capped.connect(C).attest(1)).wait();
  ok((await usdc.balanceOf(await addr(B))) - b4 === U(24000), "持有人拿 24,000");
  ok((await usdc.balanceOf(await addr(A))) - a4 === U(6000), "業主拿 6,000");

  console.log("額外：18 位小數代幣（MTK 的條件），金額計算不變");
  const V = x => ethers.parseUnits(String(x), 18);
  const mtk = await deploy(art("LocalMTK.sol", "LocalMTK"), E);
  const MT = await mtk.getAddress();
  const trust18 = await deploy(art("MilestoneTrust.sol", "MilestoneTrust"), E, MT, await addr(E), DAY, GRACE);
  const T18 = await trust18.getAddress();
  await (await mtk.mint(await addr(A), V(1000000))).wait();
  await (await mtk.mint(await addr(D), V(1000000))).wait();
  await (await mtk.connect(A).approve(T18, V(90000))).wait();
  await (await mtk.connect(D).approve(T18, V(30000))).wait();
  const t18 = await trust18.currentTime();
  await (await trust18.connect(A).createProject(await addr(B), await addr(C), [V(20000), V(40000), V(30000)], [t18 + BigInt(25 * DAY), t18 + BigInt(55 * DAY), t18 + BigInt(90 * DAY)])).wait();
  ok((await mtk.balanceOf(T18)) === V(90000), "信託持有 90,000 MTK");
  await (await trust18.connect(E).setProbability(3, 99)).wait();
  await (await trust18.connect(B).list(3, V(29480))).wait();
  const bM = await mtk.balanceOf(await addr(B));
  await (await trust18.connect(D).buy(3, V(29480))).wait();
  ok((await mtk.balanceOf(await addr(B))) - bM === V(29480), "承包商收到 29,480 MTK");
  // 二次轉售：D 再上架，二號投資人買下，撥款跟著當下持有人走
  const G = await provider.getSigner(5);
  await (await mtk.mint(await addr(G), V(100000))).wait();
  await (await mtk.connect(G).approve(T18, V(29600))).wait();
  await (await trust18.connect(D).list(3, V(29600))).wait();
  const dResale = await mtk.balanceOf(await addr(D));
  await (await trust18.connect(G).buy(3, V(29600))).wait();
  ok((await trust18.ownerOf(3)) === await addr(G) && (await mtk.balanceOf(await addr(D))) - dResale === V(29600), "二次轉售：二號投資人持有，D 收到 29,600 MTK");
  await (await trust18.connect(E).advanceTime(92)).wait();
  await (await trust18.connect(B).claimComplete(3, h)).wait();
  const aM = await mtk.balanceOf(await addr(A)), dM = await mtk.balanceOf(await addr(G));
  await (await trust18.connect(C).attest(3)).wait();
  ok((await mtk.balanceOf(await addr(G))) - dM === V(29940) && (await mtk.balanceOf(await addr(A))) - aM === V(60), "延誤 2 天：撥款給當下持有人（二號投資人）29,940、業主 60 MTK");
  const bM2 = await mtk.balanceOf(await addr(B)), aM2 = await mtk.balanceOf(await addr(A));
  await (await trust18.connect(C).terminate(1, 7000, h)).wait();
  ok((await mtk.balanceOf(await addr(B))) - bM2 === V(14000) && (await mtk.balanceOf(await addr(A))) - aM2 === V(6000), "終止第 1 期：承包商 14,000、業主 6,000 MTK");

  console.log(`\n結果：${pass} 通過，${fail} 失敗`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
