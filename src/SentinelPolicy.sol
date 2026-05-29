// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { ERC721 } from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { Pausable } from "@openzeppelin/contracts/utils/Pausable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { FixedPoint } from "./libraries/FixedPoint.sol";
import { SentinelRegistry } from "./SentinelRegistry.sol";
import { SentinelPool } from "./SentinelPool.sol";

/// @title SentinelPolicy
/// @notice ERC-721 coverage. Each token is one policy: a holder insures a notional of a registered
///         stablecoin for a term, paying an up-front premium that accrues to the LP pool. Policies
///         advance through quote → buy → active → claimable → claimed, or active → expired
///         (CLAUDE.md §6, §11).
///
/// @dev    Money convention is the protocol's single 1e18/bps standard (FixedPoint). Premium tokens
///         flow buyer → this contract → pool.accruePremium (which pulls from this contract). The
///         pool's utilization cap is enforced in `increaseLiability` at buy time, so the pool can
///         never be oversold.
///
///         Eligibility is owned here (this contract has the policy data); the payout *amount* and
///         disbursement are SentinelTreasury's job (M4). `markClaimable`/`markClaimed` are the hooks
///         the Oracle/Treasury call, gated by CLAIM_MANAGER_ROLE.
contract SentinelPolicy is ERC721, AccessControl, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;
    using FixedPoint for uint256;

    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    /// @notice Granted to SentinelOracle / SentinelTreasury to drive claim-state transitions.
    bytes32 public constant CLAIM_MANAGER_ROLE = keccak256("CLAIM_MANAGER_ROLE");

    enum Status {
        None, // 0 — never minted
        Active, // 1 — coverage in force
        Claimable, // 2 — a covered event matched this policy
        Claimed, // 3 — payout disbursed
        Expired // 4 — term elapsed with no covered event
    }

    /// @param holder       Policyholder at mint (NFT owner is the live source of truth for payout).
    /// @param stable       Covered stablecoin (must be registered+active at buy time).
    /// @param notional     Insured amount, in asset units (WAD).
    /// @param premiumPaid  Premium paid up front, in asset units.
    /// @param start        Coverage start (block.timestamp at buy).
    /// @param term         Coverage duration in seconds.
    /// @param minAge       Seconds the policy must be active before it can be claimable (anti-farm).
    /// @param status       Lifecycle state.
    struct Policy {
        address holder;
        address stable;
        uint256 notional;
        uint256 premiumPaid;
        uint64 start;
        uint64 term;
        uint64 minAge;
        Status status;
    }

    IERC20 public immutable asset;
    SentinelRegistry public immutable registry;
    SentinelPool public immutable pool;

    /// @notice Minimum age (seconds) applied to new policies. Stamped onto each policy at buy time
    ///         so changing it never affects policies already sold.
    uint64 public minAge;

    uint256 public nextTokenId = 1;
    mapping(uint256 tokenId => Policy) public policies;

    event PolicyBought(
        uint256 indexed tokenId,
        address indexed holder,
        address indexed stable,
        uint256 notional,
        uint256 premium,
        uint64 term
    );
    event PolicyClaimable(uint256 indexed tokenId, uint64 eventTriggeredAt);
    event PolicyClaimed(uint256 indexed tokenId);
    event PolicyExpired(uint256 indexed tokenId);
    event MinAgeSet(uint64 minAge);

    error NotInsurable(address stable);
    error ZeroNotional();
    error ZeroTerm();
    error NotActive(uint256 tokenId);
    error NotClaimable(uint256 tokenId);
    error NotEligibleAtTrigger(uint256 tokenId);
    error StableMismatch(uint256 tokenId, address expected, address actual);
    error TermNotElapsed(uint256 tokenId);
    error UnknownPolicy(uint256 tokenId);

    constructor(
        IERC20 asset_,
        SentinelRegistry registry_,
        SentinelPool pool_,
        address operator,
        uint64 minAge_
    ) ERC721("Sentinel Policy", "SENTINEL-POL") {
        asset = asset_;
        registry = registry_;
        pool = pool_;
        minAge = minAge_;
        _grantRole(DEFAULT_ADMIN_ROLE, operator);
        _grantRole(OPERATOR_ROLE, operator);
        emit MinAgeSet(minAge_);
    }

    // ─────────────────────────────────── quote ───────────────────────────────────

    /// @notice Premium for a prospective policy. Pure function of the §5 formula + the stable's rate.
    /// @dev    premium = notional × annualRateBps / 10_000 × term / SECONDS_PER_YEAR (rounds down).
    function quote(address stable, uint256 notional, uint64 term) public view returns (uint256 premium) {
        SentinelRegistry.StableConfig memory cfg = registry.getConfig(stable); // reverts if unregistered
        premium = (notional * cfg.annualRateBps * term)
            / (FixedPoint.BPS_DENOMINATOR * FixedPoint.SECONDS_PER_YEAR);
    }

    // ─────────────────────────────────── buy ───────────────────────────────────

    /// @notice Buy coverage. Caller must have approved this contract for at least `quote(...)`.
    /// @dev    Pulls premium → routes to pool as yield → records liability (cap-checked) → mints NFT.
    function buy(address stable, uint256 notional, uint64 term)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 tokenId)
    {
        if (!registry.isInsurable(stable)) revert NotInsurable(stable);
        if (notional == 0) revert ZeroNotional();
        if (term == 0) revert ZeroTerm();

        uint256 premium = quote(stable, notional, term);

        tokenId = nextTokenId++;
        policies[tokenId] = Policy({
            holder: msg.sender,
            stable: stable,
            notional: notional,
            premiumPaid: premium,
            start: uint64(block.timestamp),
            term: term,
            minAge: minAge,
            status: Status.Active
        });

        // Record max coverage liability (the worst-case 100% factor) — reverts if it would breach
        // the pool's utilization cap. Done before any token movement so an oversold pool can't mint.
        pool.increaseLiability(notional);

        // Route premium: buyer → here → pool. The pool pulls from this contract in accruePremium.
        if (premium > 0) {
            asset.safeTransferFrom(msg.sender, address(this), premium);
            asset.forceApprove(address(pool), premium);
            pool.accruePremium(premium);
        }

        _safeMint(msg.sender, tokenId);
        emit PolicyBought(tokenId, msg.sender, stable, notional, premium, term);
    }

    // ─────────────────────────── claim lifecycle (manager) ───────────────────────────

    /// @notice Mark a policy claimable for a covered event. CLAIM_MANAGER_ROLE (Oracle/Treasury).
    /// @param  tokenId          The policy.
    /// @param  stable           The depegged stable (must match the policy's covered stable).
    /// @param  eventTriggeredAt The on-chain timestamp the depeg event triggered.
    /// @dev    Eligibility gate (§6): policy must be Active, cover this stable, and have been past
    ///         its min-age AND still within term *at the moment the event triggered* — which blocks
    ///         buying coverage after a depeg starts (the policy's start+minAge would be after the
    ///         trigger). The payout amount is computed and disbursed by the Treasury (M4).
    function markClaimable(uint256 tokenId, address stable, uint64 eventTriggeredAt)
        external
        onlyRole(CLAIM_MANAGER_ROLE)
    {
        Policy storage p = policies[tokenId];
        if (p.status == Status.None) revert UnknownPolicy(tokenId);
        if (p.status != Status.Active) revert NotActive(tokenId);
        if (p.stable != stable) revert StableMismatch(tokenId, p.stable, stable);

        // Must have been active and past min-age at trigger time, and not yet expired then.
        uint64 eligibleFrom = p.start + p.minAge;
        uint64 expiresAt = p.start + p.term;
        if (eventTriggeredAt < eligibleFrom || eventTriggeredAt > expiresAt) {
            revert NotEligibleAtTrigger(tokenId);
        }

        p.status = Status.Claimable;
        emit PolicyClaimable(tokenId, eventTriggeredAt);
    }

    /// @notice Transition a claimable policy to claimed once the Treasury has paid it. Releases the
    ///         policy's coverage liability from the pool. CLAIM_MANAGER_ROLE.
    function markClaimed(uint256 tokenId) external onlyRole(CLAIM_MANAGER_ROLE) {
        Policy storage p = policies[tokenId];
        if (p.status != Status.Claimable) revert NotClaimable(tokenId);
        p.status = Status.Claimed;
        pool.decreaseLiability(p.notional);
        emit PolicyClaimed(tokenId);
    }

    // ─────────────────────────────────── expire ───────────────────────────────────

    /// @notice Close a policy whose term elapsed with no covered event. Permissionless — anyone can
    ///         poke it (keepers, the holder, or the operator). Releases liability; premium is kept.
    function expire(uint256 tokenId) external {
        Policy storage p = policies[tokenId];
        if (p.status != Status.Active) revert NotActive(tokenId);
        if (block.timestamp <= p.start + p.term) revert TermNotElapsed(tokenId);
        p.status = Status.Expired;
        pool.decreaseLiability(p.notional);
        emit PolicyExpired(tokenId);
    }

    // ─────────────────────────────────── views ───────────────────────────────────

    function getPolicy(uint256 tokenId) external view returns (Policy memory) {
        if (policies[tokenId].status == Status.None) revert UnknownPolicy(tokenId);
        return policies[tokenId];
    }

    /// @notice Would this policy be eligible for a claim from an event at `eventTriggeredAt`?
    ///         Pure read — does not check the event's classification (that's the matrix's job).
    function isEligibleAt(uint256 tokenId, address stable, uint64 eventTriggeredAt)
        external
        view
        returns (bool)
    {
        Policy memory p = policies[tokenId];
        if (p.status != Status.Active || p.stable != stable) return false;
        uint64 eligibleFrom = p.start + p.minAge;
        uint64 expiresAt = p.start + p.term;
        return eventTriggeredAt >= eligibleFrom && eventTriggeredAt <= expiresAt;
    }

    // ─────────────────────────────────── operator ───────────────────────────────────

    function setMinAge(uint64 minAge_) external onlyRole(OPERATOR_ROLE) {
        minAge = minAge_;
        emit MinAgeSet(minAge_);
    }

    function pause() external onlyRole(OPERATOR_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(OPERATOR_ROLE) {
        _unpause();
    }

    // ─────────────────────────────────── overrides ───────────────────────────────────

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721, AccessControl)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
