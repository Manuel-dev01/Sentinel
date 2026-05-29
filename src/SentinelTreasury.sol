// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { Pausable } from "@openzeppelin/contracts/utils/Pausable.sol";
import { Classification } from "./libraries/Classification.sol";
import { PayoutMath } from "./libraries/PayoutMath.sol";
import { SentinelRegistry } from "./SentinelRegistry.sol";
import { SentinelPool } from "./SentinelPool.sol";
import { SentinelPolicy } from "./SentinelPolicy.sol";

/// @title SentinelTreasury
/// @notice Applies the payout matrix and executes settlements. The Oracle records a finalized
///         event verdict here (`recordVerdict`); each affected policy is then settled individually
///         (`settle`), which keeps gas bounded (one policy per tx) and avoids any unbounded loop
///         over the policy set. Exploit-class payouts disburse immediately; softer classes vest and
///         are released later via `claimVested` (CLAUDE.md §4, §5, §11).
///
/// @dev    Money flows out of the LP pool only through `SentinelPool.payOut`, gated by TREASURY_ROLE
///         held by this contract. Capital is reserved (`reserveForEvent`) the instant a policy is
///         settled, before any disbursement, so `total paid for an event ≤ reserved` holds per
///         policy and therefore in aggregate. CEI + nonReentrant on every value path. The
///         double-settle guard is inherited from the Policy state machine: `markClaimable`
///         transitions Active→Claimable and reverts on a second attempt.
contract SentinelTreasury is AccessControl, ReentrancyGuard, Pausable {
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    /// @notice Granted to SentinelOracle — the only caller allowed to record a finalized verdict.
    bytes32 public constant ORACLE_ROLE = keccak256("ORACLE_ROLE");

    /// @notice Vesting windows by timing class, measured from the event trigger time.
    uint64 public constant VESTED_24H_DELAY = 24 hours;
    uint64 public constant DELAYED_WINDOW = 72 hours;

    SentinelRegistry public immutable registry;
    SentinelPool public immutable pool;
    SentinelPolicy public immutable policyNft;

    /// @notice A finalized depeg-event verdict, recorded by the Oracle.
    /// @param stable        The depegged stablecoin.
    /// @param cause         The consensus classification.
    /// @param deviationBps  Peak deviation magnitude (bps) used for the payout factor.
    /// @param triggeredAt   On-chain time the event triggered (drives eligibility + vesting clocks).
    /// @param exists        Set once recorded.
    struct Verdict {
        address stable;
        Classification.Cause cause;
        uint256 deviationBps;
        uint64 triggeredAt;
        bool exists;
    }

    /// @notice A scheduled (vested/delayed) payout for one policy under one event.
    /// @param amount     Asset amount to release (already reserved in the pool).
    /// @param releaseAt  Timestamp the amount becomes claimable.
    /// @param claimed    Set once paid — prevents double-claim.
    struct Vesting {
        uint256 amount;
        uint64 releaseAt;
        bool claimed;
    }

    mapping(uint256 eventId => Verdict) public verdicts;
    /// @dev keyed by (eventId, tokenId)
    mapping(uint256 eventId => mapping(uint256 tokenId => Vesting)) public vestings;
    /// @notice Total disbursed per event — asserted ≤ what was reserved.
    mapping(uint256 eventId => uint256) public paidPerEvent;
    mapping(uint256 eventId => uint256) public reservedPerEvent;

    event VerdictRecorded(
        uint256 indexed eventId, address indexed stable, Classification.Cause cause, uint256 deviationBps
    );
    event SettledImmediate(
        uint256 indexed eventId, uint256 indexed tokenId, address indexed to, uint256 amount
    );
    event SettledVesting(uint256 indexed eventId, uint256 indexed tokenId, uint256 amount, uint64 releaseAt);
    event VestedClaimed(uint256 indexed eventId, uint256 indexed tokenId, address indexed to, uint256 amount);

    error VerdictExists(uint256 eventId);
    error UnknownVerdict(uint256 eventId);
    error ZeroAddress();
    error NothingToPay(uint256 tokenId);
    error NoVesting(uint256 eventId, uint256 tokenId);
    error AlreadyClaimed(uint256 eventId, uint256 tokenId);
    error NotYetReleasable(uint256 eventId, uint256 tokenId, uint64 releaseAt);

    constructor(SentinelRegistry registry_, SentinelPool pool_, SentinelPolicy policyNft_, address operator) {
        if (operator == address(0)) revert ZeroAddress();
        registry = registry_;
        pool = pool_;
        policyNft = policyNft_;
        _grantRole(DEFAULT_ADMIN_ROLE, operator);
        _grantRole(OPERATOR_ROLE, operator);
    }

    // ─────────────────────────────── verdict (Oracle) ───────────────────────────────

    /// @notice Record a finalized event verdict. Oracle-only; idempotent per eventId.
    /// @dev    The spec's `routePayouts(eventId)` — but instead of looping policies here (unbounded
    ///         gas), it registers the verdict so each policy can be settled individually.
    function recordVerdict(
        uint256 eventId,
        address stable,
        Classification.Cause cause,
        uint256 deviationBps,
        uint64 triggeredAt
    ) external onlyRole(ORACLE_ROLE) {
        if (verdicts[eventId].exists) revert VerdictExists(eventId);
        verdicts[eventId] = Verdict({
            stable: stable, cause: cause, deviationBps: deviationBps, triggeredAt: triggeredAt, exists: true
        });
        emit VerdictRecorded(eventId, stable, cause, deviationBps);
    }

    // ─────────────────────────────── settle one policy ───────────────────────────────

    /// @notice Settle one policy against a recorded verdict. Permissionless — anyone can poke it
    ///         (the holder, a keeper, the operator); funds always go to the policy's current owner.
    /// @dev    Flow: compute factor → mark policy claimable (eligibility gate + double-settle guard)
    ///         → reserve capital → immediate classes pay now & mark claimed; vested/delayed classes
    ///         store a schedule and pay on `claimVested`.
    function settle(uint256 eventId, uint256 tokenId) external nonReentrant whenNotPaused {
        Verdict memory v = verdicts[eventId];
        if (!v.exists) revert UnknownVerdict(eventId);

        SentinelPolicy.Policy memory p = policyNft.getPolicy(tokenId);
        uint256 amount =
            PayoutMath.payoutAmount(v.cause, v.deviationBps, registry.tiersOf(v.stable), p.notional);
        if (amount == 0) revert NothingToPay(tokenId);

        // Transitions Active→Claimable; enforces the eligibility gate at trigger time AND blocks a
        // second settle of the same policy (reverts if not Active / stable mismatch / ineligible).
        policyNft.markClaimable(tokenId, v.stable, v.triggeredAt);

        // Reserve before any disbursement so reserved ≥ paid always holds.
        pool.reserveForEvent(amount);
        reservedPerEvent[eventId] += amount;

        address to = policyNft.ownerOf(tokenId);
        PayoutMath.Timing t = PayoutMath.timing(v.cause);

        if (t == PayoutMath.Timing.IMMEDIATE) {
            // Effects then interaction: mark claimed (releases liability) before the external payout.
            policyNft.markClaimed(tokenId);
            paidPerEvent[eventId] += amount;
            pool.payOut(to, amount);
            emit SettledImmediate(eventId, tokenId, to, amount);
        } else {
            uint64 delay = t == PayoutMath.Timing.VESTED_24H ? VESTED_24H_DELAY : DELAYED_WINDOW;
            vestings[eventId][tokenId] =
                Vesting({ amount: amount, releaseAt: v.triggeredAt + delay, claimed: false });
            emit SettledVesting(eventId, tokenId, amount, v.triggeredAt + delay);
        }
    }

    // ─────────────────────────────── claim vested ───────────────────────────────

    /// @notice Release a matured vested payout for a policy. Permissionless; funds go to current owner.
    function claimVested(uint256 eventId, uint256 tokenId) external nonReentrant whenNotPaused {
        Vesting storage vest = vestings[eventId][tokenId];
        if (vest.amount == 0) revert NoVesting(eventId, tokenId);
        if (vest.claimed) revert AlreadyClaimed(eventId, tokenId);
        if (block.timestamp < vest.releaseAt) revert NotYetReleasable(eventId, tokenId, vest.releaseAt);

        // Effects first (claimed flag + claimed status + accounting), then the external transfer.
        vest.claimed = true;
        policyNft.markClaimed(tokenId);
        paidPerEvent[eventId] += vest.amount;

        address to = policyNft.ownerOf(tokenId);
        pool.payOut(to, vest.amount);
        emit VestedClaimed(eventId, tokenId, to, vest.amount);
    }

    // ─────────────────────────────── views ───────────────────────────────

    /// @notice Quote the payout amount a policy would receive under a recorded verdict (pure read).
    function quotePayout(uint256 eventId, uint256 tokenId) external view returns (uint256) {
        Verdict memory v = verdicts[eventId];
        if (!v.exists) revert UnknownVerdict(eventId);
        SentinelPolicy.Policy memory p = policyNft.getPolicy(tokenId);
        return PayoutMath.payoutAmount(v.cause, v.deviationBps, registry.tiersOf(v.stable), p.notional);
    }

    // ─────────────────────────────── operator ───────────────────────────────

    function pause() external onlyRole(OPERATOR_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(OPERATOR_ROLE) {
        _unpause();
    }
}
