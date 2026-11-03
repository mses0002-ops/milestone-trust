// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/*
 * MilestoneTrust — 里程碑請款權信託
 *
 * 一份合約同時扮演三個角色：
 *   1. 信託：業主把整個工程款（MockUSDC）全額鎖在這裡
 *   2. ERC-721：每一期里程碑 = 一張請款權 NFT，持有人就是收款人
 *   3. 市集：持有人可以固定價格整張賣斷，USDC 與 NFT 在同一筆交易互換
 *
 * 撥款規則（每一期獨立）：
 *   如期完工  → 持有人拿全額
 *   延誤完工  → 持有人拿「全額 − 逾期違約金」，違約金給業主（每日 0.1%，上限 20%）
 *   工程終止  → 持有人拿「全額 × 完成比例」，剩餘退回業主
 *
 * 只有在 Active 且完工機率 p ≥ 70 時，NFT 才能轉讓（包含市集與私下轉讓）。
 *
 * 第一階段：不使用 OpenZeppelin，ERC-721 與防重入都手寫，方便逐行解釋。
 */

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

interface IERC721Receiver {
    function onERC721Received(address operator, address from, uint256 tokenId, bytes calldata data)
        external
        returns (bytes4);
}

contract MilestoneTrust {
    // ───────────────────────── 常數與參數 ─────────────────────────
    string public constant name = "Milestone Claim";
    string public constant symbol = "MCLAIM";

    uint16 public constant MIN_PROB = 70;              // 可交易的最低完工機率
    uint16 public constant PENALTY_BPS_PER_DAY = 10;   // 每日違約金 0.1%（萬分比）
    uint16 public constant PENALTY_CAP_BPS = 2000;     // 違約金上限 20%
    uint16 public constant BPS = 10000;                // 萬分比分母
    uint256 public constant MAX_MILESTONES = 10;       // 每個專案最多期數

    IERC20 public immutable usdc;
    address public immutable oracle;   // 完工機率來源（期中：手動設定的獨立帳號）
    uint256 public immutable DAY;      // 一天的秒數；86400
    uint256 public immutable GRACE;    // 寬限期秒數；5184000 = 60 天
    uint256 public timeOffset;         // 時間快轉累計秒數（課堂 demo 專用，只增不減）

    // ───────────────────────── 資料結構 ─────────────────────────
    enum Status { Active, Claimed, Paid, Terminated }

    struct Project {
        address owner;       // 業主
        address contractor;  // 承包商
        address attester;    // 監造方
    }

    struct Milestone {
        uint256 projectId;
        uint256 face;          // 面額（6 位小數）
        uint256 deadline;      // 約定完工時間（unix 秒）
        uint256 claimedAt;     // 承包商申報完工時間，0 = 尚未申報
        bytes32 evidenceHash;  // 驗收或鑑定文件的 hash
        Status status;
        uint16 probability;    // 完工機率 0–100
        uint256 listPrice;     // 上架價格，0 = 未上架
        uint16 progressBps;    // 最新回報進度（萬分比），只供參考，不影響撥款
        uint256 progressAt;    // 最新回報時間，0 = 尚未回報
    }

    uint256 public projectCount;
    uint256 public milestoneCount;   // 也是最後一張 NFT 的 id
    mapping(uint256 => Project) public projects;
    mapping(uint256 => Milestone) public milestones;

    // ───────────────────────── ERC-721 狀態 ─────────────────────────
    mapping(uint256 => address) private _owners;
    mapping(address => uint256) private _balances;
    mapping(uint256 => address) private _tokenApprovals;
    mapping(address => mapping(address => bool)) private _operatorApprovals;

    // ───────────────────────── 手寫防重入 ─────────────────────────
    uint256 private _locked = 1;

    modifier nonReentrant() {
        require(_locked == 1, "reentrant call");
        _locked = 2;
        _;
        _locked = 1;
    }

    // ───────────────────────── 事件（= 稽核軌跡） ─────────────────────────
    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);

    event ProjectCreated(
        uint256 indexed projectId,
        address indexed owner,
        address contractor,
        address attester,
        uint256 firstMilestoneId,
        uint256 count,
        uint256 total
    );
    event ProbabilitySet(uint256 indexed id, uint16 probability);
    event Listed(uint256 indexed id, address indexed seller, uint256 price);
    event ListingCancelled(uint256 indexed id);
    event Sold(uint256 indexed id, address indexed seller, address indexed buyer, uint256 price);
    event CompletionClaimed(uint256 indexed id, uint256 claimedAt, bytes32 evidenceHash);
    event ClaimRejected(uint256 indexed id);
    event TimeAdvanced(uint256 numDays, uint256 newOffset, uint256 newTime);
    event ProgressReported(uint256 indexed id, uint16 bps, bytes32 evidenceHash, uint256 reportedAt);
    event MilestonePaid(uint256 indexed id, address indexed holder, uint256 toHolder, uint256 penalty, uint256 daysLate);
    event MilestoneTerminated(uint256 indexed id, address indexed holder, uint256 toHolder, uint256 toOwner, uint16 completedBps, bytes32 evidenceHash);

    constructor(address usdc_, address oracle_, uint256 day_, uint256 grace_) {
        require(usdc_ != address(0) && oracle_ != address(0), "zero address");
        require(day_ > 0, "DAY must be > 0");
        usdc = IERC20(usdc_);
        oracle = oracle_;
        DAY = day_;
        GRACE = grace_;
    }

    // ═════════════════════════ 合約時間 ═════════════════════════

    /// @notice 合約內所有時間判斷都讀這裡，不直接用區塊時間
    function currentTime() public view returns (uint256) {
        return block.timestamp + timeOffset;
    }

    /// @notice 時間快轉（課堂 demo 專用，正式版本會移除）。demo 管理員 = 機率來源帳號，只能往前
    function advanceTime(uint256 days_) external {
        require(msg.sender == oracle, "only oracle");
        require(days_ >= 1, "days must be >= 1");
        timeOffset += days_ * DAY;
        emit TimeAdvanced(days_, timeOffset, currentTime());
    }

    // ═════════════════════════ 信託：建立專案 ═════════════════════════

    /// @notice 業主存入全部工程款，每一期鑄造一張 NFT 給承包商
    /// @dev 呼叫前業主必須先對本合約 approve 足夠的 USDC
    function createProject(
        address contractor,
        address attester,
        uint256[] calldata faces,
        uint256[] calldata deadlines
    ) external nonReentrant returns (uint256 projectId, uint256 firstId) {
        require(contractor != address(0) && attester != address(0), "zero address");
        require(attester != msg.sender && attester != contractor, "attester must be independent");
        require(contractor != msg.sender, "owner cannot be contractor");
        require(contractor != oracle, "oracle cannot hold");   // 鑄造也算持有，機率來源不能當承包商
        uint256 n = faces.length;
        require(n > 0 && n <= MAX_MILESTONES, "1 to 10 milestones");
        require(deadlines.length == n, "length mismatch");

        projectId = ++projectCount;
        projects[projectId] = Project(msg.sender, contractor, attester);

        firstId = milestoneCount + 1;
        uint256 total;
        for (uint256 i = 0; i < n; i++) {
            require(faces[i] > 0, "face must be > 0");
            require(deadlines[i] > currentTime(), "deadline in the past");
            uint256 id = ++milestoneCount;
            milestones[id] = Milestone({
                projectId: projectId,
                face: faces[i],
                deadline: deadlines[i],
                claimedAt: 0,
                evidenceHash: bytes32(0),
                status: Status.Active,
                probability: 0,
                listPrice: 0,
                progressBps: 0,
                progressAt: 0
            });
            _mint(contractor, id);
            total += faces[i];
        }

        emit ProjectCreated(projectId, msg.sender, contractor, attester, firstId, n, total);

        // 互動放最後：把工程款拉進信託
        require(usdc.transferFrom(msg.sender, address(this), total), "USDC transfer failed");
    }

    // ═════════════════════════ 完工機率 ═════════════════════════

    function setProbability(uint256 id, uint16 p) external {
        require(msg.sender == oracle, "only oracle");
        require(_exists(id), "no such milestone");
        require(p <= 100, "p must be 0-100");
        milestones[id].probability = p;
        emit ProbabilitySet(id, p);
    }

    /// @notice Active 且 p ≥ 70 才能轉讓
    function isTradable(uint256 id) public view returns (bool) {
        Milestone storage m = milestones[id];
        return _exists(id) && m.status == Status.Active && m.probability >= MIN_PROB;
    }

    // ═════════════════════════ 市集 ═════════════════════════

    function list(uint256 id, uint256 price) external {
        require(_owners[id] == msg.sender, "not holder");
        require(isTradable(id), "not tradable");
        require(price > 0, "price must be > 0");
        require(price <= milestones[id].face, "price above face");   // 持有人最多只拿到面額，售價不能更高
        milestones[id].listPrice = price;
        emit Listed(id, msg.sender, price);
    }

    function cancelListing(uint256 id) external {
        require(_owners[id] == msg.sender, "not holder");
        require(milestones[id].listPrice > 0, "not listed");
        milestones[id].listPrice = 0;
        emit ListingCancelled(id);
    }

    /// @param maxPrice 買方願付的上限，防止賣方在交易送出後偷偷改價
    /// @dev 呼叫前買方必須先對本合約 approve 足夠的 USDC
    function buy(uint256 id, uint256 maxPrice) external nonReentrant {
        uint256 price = milestones[id].listPrice;
        require(price > 0, "not listed");
        require(price <= maxPrice, "price changed");
        address seller = _owners[id];
        require(msg.sender != seller, "already holder");

        _transfer(seller, msg.sender, id);   // 內含 isTradable 檢查，並清除上架
        emit Sold(id, seller, msg.sender, price);

        require(usdc.transferFrom(msg.sender, seller, price), "USDC transfer failed");
    }

    // ═════════════════════════ 完工申報與撥款 ═════════════════════════

    /// @notice 承包商申報完工；延誤天數以這個時間計算
    function claimComplete(uint256 id, bytes32 evidenceHash) external {
        Milestone storage m = milestones[id];
        require(_exists(id), "no such milestone");
        require(msg.sender == projects[m.projectId].contractor, "only contractor");
        require(m.status == Status.Active, "not active");
        require(currentTime() <= m.deadline + GRACE, "grace period over");
        require(evidenceHash != bytes32(0), "evidence required");

        m.status = Status.Claimed;
        m.claimedAt = currentTime();
        m.evidenceHash = evidenceHash;
        m.listPrice = 0;
        emit CompletionClaimed(id, currentTime(), evidenceHash);
    }

    /// @notice 監造方駁回申報並記下實際進度，回到 Active，承包商可修正後再申報
    /// @param bps 驗收時的實際完成比例（萬分比），必須低於 100%；100% 應該核准
    function rejectClaim(uint256 id, uint16 bps, bytes32 evidenceHash) external {
        Milestone storage m = milestones[id];
        require(msg.sender == projects[m.projectId].attester, "only attester");
        require(m.status == Status.Claimed, "not claimed");
        require(bps < BPS, "bps must be < 10000");
        require(evidenceHash != bytes32(0), "evidence required");

        m.status = Status.Active;
        m.claimedAt = 0;
        m.progressBps = bps;
        m.progressAt = currentTime();
        emit ProgressReported(id, bps, evidenceHash, m.progressAt);
        emit ClaimRejected(id);
    }

    /// @notice 監造方核准申報：扣除逾期違約金後撥款給當下持有人
    function attest(uint256 id) external nonReentrant {
        Milestone storage m = milestones[id];
        Project storage p = projects[m.projectId];
        require(msg.sender == p.attester, "only attester");
        require(m.status == Status.Claimed, "not claimed");

        (uint256 penalty, uint256 daysLate) = penaltyOf(id);
        address holder = _owners[id];
        uint256 toHolder = m.face - penalty;

        m.status = Status.Paid;   // 先改狀態，再轉錢
        emit MilestonePaid(id, holder, toHolder, penalty, daysLate);

        if (penalty > 0) require(usdc.transfer(p.owner, penalty), "USDC transfer failed");
        require(usdc.transfer(holder, toHolder), "USDC transfer failed");
    }

    /// @notice 監造方回報進度：只留下紀錄與事件，不影響撥款
    /// @param bps 進度（萬分比，6000 = 60%）
    function reportProgress(uint256 id, uint16 bps, bytes32 evidenceHash) external {
        Milestone storage m = milestones[id];
        require(msg.sender == projects[m.projectId].attester, "only attester");
        require(m.status == Status.Active || m.status == Status.Claimed, "already settled");
        require(bps <= BPS, "bps must be <= 10000");
        require(evidenceHash != bytes32(0), "evidence required");

        m.progressBps = bps;
        m.progressAt = currentTime();
        emit ProgressReported(id, bps, evidenceHash, currentTime());
    }

    /// @notice 超過寬限期仍未完成：監造方鑑定完成比例後終止
    /// @param completedBps 完成比例（萬分比，7000 = 70%）
    function terminate(uint256 id, uint16 completedBps, bytes32 evidenceHash) external nonReentrant {
        Milestone storage m = milestones[id];
        Project storage p = projects[m.projectId];
        require(msg.sender == p.attester, "only attester");
        require(m.status == Status.Active || m.status == Status.Claimed, "already settled");
        require(currentTime() > m.deadline + GRACE, "grace period not over");
        require(completedBps <= BPS, "bps must be <= 10000");
        require(evidenceHash != bytes32(0), "evidence required");

        address holder = _owners[id];
        uint256 toHolder = m.face * completedBps / BPS;
        uint256 toOwner = m.face - toHolder;

        m.status = Status.Terminated;
        m.evidenceHash = evidenceHash;
        m.listPrice = 0;
        emit MilestoneTerminated(id, holder, toHolder, toOwner, completedBps, evidenceHash);

        if (toHolder > 0) require(usdc.transfer(holder, toHolder), "USDC transfer failed");
        if (toOwner > 0) require(usdc.transfer(p.owner, toOwner), "USDC transfer failed");
    }

    /// @notice 依目前的申報時間試算違約金（前端也用它顯示）
    function penaltyOf(uint256 id) public view returns (uint256 penalty, uint256 daysLate) {
        Milestone storage m = milestones[id];
        if (m.claimedAt > m.deadline) {
            daysLate = (m.claimedAt - m.deadline) / DAY;
        }
        uint256 bps = daysLate * PENALTY_BPS_PER_DAY;
        if (bps > PENALTY_CAP_BPS) bps = PENALTY_CAP_BPS;
        penalty = m.face * bps / BPS;
    }

    // ═════════════════════════ ERC-721（手寫） ═════════════════════════

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x01ffc9a7   // ERC-165
            || interfaceId == 0x80ac58cd;  // ERC-721
    }

    function balanceOf(address owner) external view returns (uint256) {
        require(owner != address(0), "zero address");
        return _balances[owner];
    }

    function ownerOf(uint256 id) public view returns (address) {
        address owner = _owners[id];
        require(owner != address(0), "no such token");
        return owner;
    }

    function approve(address to, uint256 id) external {
        address owner = ownerOf(id);
        require(msg.sender == owner || _operatorApprovals[owner][msg.sender], "not allowed");
        _tokenApprovals[id] = to;
        emit Approval(owner, to, id);
    }

    function getApproved(uint256 id) external view returns (address) {
        require(_exists(id), "no such token");
        return _tokenApprovals[id];
    }

    function setApprovalForAll(address operator, bool approved) external {
        _operatorApprovals[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function isApprovedForAll(address owner, address operator) external view returns (bool) {
        return _operatorApprovals[owner][operator];
    }

    function transferFrom(address from, address to, uint256 id) public {
        address owner = ownerOf(id);
        require(owner == from, "wrong from");
        require(
            msg.sender == owner || _tokenApprovals[id] == msg.sender || _operatorApprovals[owner][msg.sender],
            "not allowed"
        );
        _transfer(from, to, id);
    }

    function safeTransferFrom(address from, address to, uint256 id) external {
        safeTransferFrom(from, to, id, "");
    }

    function safeTransferFrom(address from, address to, uint256 id, bytes memory data) public {
        transferFrom(from, to, id);
        if (to.code.length > 0) {
            require(
                IERC721Receiver(to).onERC721Received(msg.sender, from, id, data)
                    == IERC721Receiver.onERC721Received.selector,
                "receiver rejected"
            );
        }
    }

    // ───────────────────────── 內部函式 ─────────────────────────

    function _exists(uint256 id) internal view returns (bool) {
        return _owners[id] != address(0);
    }

    function _mint(address to, uint256 id) internal {
        _balances[to] += 1;
        _owners[id] = to;
        emit Transfer(address(0), to, id);
    }

    /// @dev 所有轉讓（市集、私下 transferFrom）都經過這裡，所以機率門檻無法被繞過
    function _transfer(address from, address to, uint256 id) internal {
        require(to != address(0), "transfer to zero");
        require(to != oracle, "oracle cannot hold");
        require(to != projects[milestones[id].projectId].attester, "attester cannot hold");   // 只限自己監造的專案
        require(isTradable(id), "not tradable");
        delete _tokenApprovals[id];
        _balances[from] -= 1;
        _balances[to] += 1;
        _owners[id] = to;
        milestones[id].listPrice = 0;   // 換手後原上架自動失效
        emit Transfer(from, to, id);
    }
}
