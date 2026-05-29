// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { Pausable } from "@openzeppelin/contracts/utils/Pausable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { FixedPoint } from "./libraries/FixedPoint.sol";

/// @title SentinelPool
/// @notice The LP capital pool backing all payouts. ERC-4626-style share accounting: LPs deposit
///         the capital asset and receive shares; premiums accrue as yield (NAV rises); payouts
///         reduce NAV. Solvency is enforced by a utilization cap on outstanding liability, and
///         capital reserved for a settling event cannot be withdrawn (CLAUDE.md §5, §6, §11, §15).
///
/// @dev    MONEY CONVENTION (the one fixed-point convention for the whole protocol): the capital
///         `asset` is an ERC-20 carried in its own native decimals; *share/asset ratios* use the
///         WAD/bps helpers in `FixedPoint`. No floats anywhere.
///
///         Accounting uses an internal `_totalAssets` counter, NOT `asset.balanceOf(this)`, so a
///         direct token donation cannot move NAV (the classic ERC-4626 inflation/donation attack).
///         Share conversion uses a virtual +1 offset on both sides, which also blocks the
///         first-depositor inflation attack and removes the div-by-zero edge.
///
///         Shares are tracked internally (non-transferable) — LP-share transferability isn't in
///         MVP scope; deposit/redeem are the only ways in and out.
contract SentinelPool is AccessControl, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    bytes32 public constant POLICY_ROLE = keccak256("POLICY_ROLE"); // SentinelPolicy: liability + premium
    bytes32 public constant TREASURY_ROLE = keccak256("TREASURY_ROLE"); // SentinelTreasury: payout + reserve

    /// @notice The capital asset LPs deposit and payouts are denominated in.
    IERC20 public immutable asset;

    /// @notice Internal capital accounting (deposits + accrued premiums − payouts). Source of NAV.
    uint256 private _totalAssets;

    /// @notice Total LP shares outstanding.
    uint256 public totalShares;

    /// @notice Per-LP share balance.
    mapping(address lp => uint256 shares) public sharesOf;

    /// @notice Sum of max potential payout across active coverage. Bounded by the utilization cap.
    uint256 public outstandingLiability;

    /// @notice Capital locked for in-flight/settling events; excluded from `availableCapital`.
    uint256 public reservedCapital;

    /// @notice Max coverage-to-capital ratio in bps: outstandingLiability ≤ totalAssets × cap / 1e4.
    uint16 public utilizationCapBps;

    event Deposited(address indexed lp, uint256 assets, uint256 shares);
    event Redeemed(address indexed lp, uint256 shares, uint256 assets);
    event PremiumAccrued(address indexed from, uint256 amount);
    event PayoutExecuted(address indexed to, uint256 amount);
    event LiabilityIncreased(uint256 delta, uint256 outstanding);
    event LiabilityDecreased(uint256 delta, uint256 outstanding);
    event CapitalReserved(uint256 amount, uint256 reserved);
    event CapitalReleased(uint256 amount, uint256 reserved);
    event UtilizationCapSet(uint16 capBps);

    error ZeroAmount();
    error ZeroAddress();
    error InsufficientShares(uint256 have, uint256 want);
    error ExceedsAvailableCapital(uint256 want, uint256 available);
    error UtilizationCapExceeded(uint256 wouldBe, uint256 max);
    error InsufficientReserve(uint256 have, uint256 want);
    error InsufficientLiability(uint256 have, uint256 want);
    error CapTooHigh(uint16 capBps);

    constructor(IERC20 asset_, address operator, uint16 utilizationCapBps_) {
        if (address(asset_) == address(0) || operator == address(0)) revert ZeroAddress();
        if (utilizationCapBps_ > FixedPoint.BPS_DENOMINATOR) revert CapTooHigh(utilizationCapBps_);
        asset = asset_;
        utilizationCapBps = utilizationCapBps_;
        _grantRole(DEFAULT_ADMIN_ROLE, operator);
        _grantRole(OPERATOR_ROLE, operator);
        emit UtilizationCapSet(utilizationCapBps_);
    }

    // ───────────────────────────────── views (NAV) ─────────────────────────────────

    /// @notice Total capital backing payouts (deposits + premiums − payouts). NAV numerator.
    function totalAssets() public view returns (uint256) {
        return _totalAssets;
    }

    /// @notice Capital free to be withdrawn — total minus what's reserved for settling events.
    function availableCapital() public view returns (uint256) {
        return _totalAssets - reservedCapital; // reservedCapital ≤ _totalAssets invariant (see _reserve)
    }

    /// @notice Max additional liability the pool may take on right now under the cap.
    function maxNewLiability() public view returns (uint256) {
        uint256 ceiling = FixedPoint.bps(_totalAssets, utilizationCapBps);
        return ceiling > outstandingLiability ? ceiling - outstandingLiability : 0;
    }

    /// @notice Shares for a given asset amount, rounding down (favor pool). Virtual +1 offset.
    function convertToShares(uint256 assets) public view returns (uint256) {
        return Math.mulDiv(assets, totalShares + 1, _totalAssets + 1);
    }

    /// @notice Assets for a given share amount, rounding down (favor pool). Virtual +1 offset.
    function convertToAssets(uint256 shares) public view returns (uint256) {
        return Math.mulDiv(shares, _totalAssets + 1, totalShares + 1);
    }

    // ───────────────────────────────── LP flow ─────────────────────────────────

    /// @notice Deposit `assets` of the capital token, minting shares at the current NAV.
    function deposit(uint256 assets, address receiver)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 shares)
    {
        if (assets == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroAddress();

        shares = convertToShares(assets);
        if (shares == 0) revert ZeroAmount(); // dust deposit that would mint nothing

        // Effects before interaction (CEI).
        totalShares += shares;
        sharesOf[receiver] += shares;
        _totalAssets += assets;

        asset.safeTransferFrom(msg.sender, address(this), assets);
        emit Deposited(receiver, assets, shares);
    }

    /// @notice Burn `shares` and withdraw the corresponding assets at current NAV.
    /// @dev    Cannot draw down capital reserved for a settling event (the §6 lock).
    function redeem(uint256 shares, address receiver)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 assets)
    {
        if (shares == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroAddress();
        uint256 bal = sharesOf[msg.sender];
        if (bal < shares) revert InsufficientShares(bal, shares);

        assets = convertToAssets(shares);
        uint256 avail = availableCapital();
        if (assets > avail) revert ExceedsAvailableCapital(assets, avail);

        // Effects.
        sharesOf[msg.sender] = bal - shares;
        totalShares -= shares;
        _totalAssets -= assets;

        asset.safeTransfer(receiver, assets);
        emit Redeemed(msg.sender, shares, assets);
    }

    // ─────────────────────────── premium / payout / reserve ───────────────────────────

    /// @notice Pull `amount` of premium from the caller (SentinelPolicy) into the pool as yield.
    ///         Raises NAV for all LPs. CEI: effect first, then pull.
    function accruePremium(uint256 amount) external onlyRole(POLICY_ROLE) {
        if (amount == 0) revert ZeroAmount();
        _totalAssets += amount;
        asset.safeTransferFrom(msg.sender, address(this), amount);
        emit PremiumAccrued(msg.sender, amount);
    }

    /// @notice Pay `amount` out to `to` for a settled claim. Treasury-only. Consumes reserve first.
    /// @dev    nonReentrant + CEI; the recipient is arbitrary so the guard matters.
    function payOut(address to, uint256 amount) external onlyRole(TREASURY_ROLE) nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (to == address(0)) revert ZeroAddress();
        if (amount > _totalAssets) revert ExceedsAvailableCapital(amount, _totalAssets);

        // A payout draws against the reservation made when the event began settling.
        if (reservedCapital >= amount) {
            reservedCapital -= amount;
        } else {
            reservedCapital = 0; // partial/over-draw beyond reserve still bounded by _totalAssets
        }
        _totalAssets -= amount;

        asset.safeTransfer(to, amount);
        emit PayoutExecuted(to, amount);
    }

    // ─────────────────────────── liability accounting (Policy) ───────────────────────────

    /// @notice Record new coverage liability when a policy is bought. Enforces the utilization cap.
    function increaseLiability(uint256 delta) external onlyRole(POLICY_ROLE) {
        if (delta == 0) revert ZeroAmount();
        uint256 wouldBe = outstandingLiability + delta;
        uint256 ceiling = FixedPoint.bps(_totalAssets, utilizationCapBps);
        if (wouldBe > ceiling) revert UtilizationCapExceeded(wouldBe, ceiling);
        outstandingLiability = wouldBe;
        emit LiabilityIncreased(delta, wouldBe);
    }

    /// @notice Release coverage liability when a policy expires, is claimed, or is closed.
    function decreaseLiability(uint256 delta) external onlyRole(POLICY_ROLE) {
        if (delta == 0) revert ZeroAmount();
        if (delta > outstandingLiability) revert InsufficientLiability(outstandingLiability, delta);
        outstandingLiability -= delta;
        emit LiabilityDecreased(delta, outstandingLiability);
    }

    // ─────────────────────────── reservation (Treasury) ───────────────────────────

    /// @notice Lock `amount` of capital for a settling event so it can't be withdrawn.
    /// @dev    Bounded by availableCapital so reservedCapital ≤ _totalAssets always holds.
    function reserveForEvent(uint256 amount) external onlyRole(TREASURY_ROLE) {
        if (amount == 0) revert ZeroAmount();
        uint256 avail = availableCapital();
        if (amount > avail) revert ExceedsAvailableCapital(amount, avail);
        reservedCapital += amount;
        emit CapitalReserved(amount, reservedCapital);
    }

    /// @notice Release a previously-made reservation (e.g. event dismissed or payout < reserved).
    function releaseReserve(uint256 amount) external onlyRole(TREASURY_ROLE) {
        if (amount == 0) revert ZeroAmount();
        if (amount > reservedCapital) revert InsufficientReserve(reservedCapital, amount);
        reservedCapital -= amount;
        emit CapitalReleased(amount, reservedCapital);
    }

    // ─────────────────────────────────── operator ───────────────────────────────────

    function setUtilizationCap(uint16 capBps) external onlyRole(OPERATOR_ROLE) {
        if (capBps > FixedPoint.BPS_DENOMINATOR) revert CapTooHigh(capBps);
        utilizationCapBps = capBps;
        emit UtilizationCapSet(capBps);
    }

    function pause() external onlyRole(OPERATOR_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(OPERATOR_ROLE) {
        _unpause();
    }
}
