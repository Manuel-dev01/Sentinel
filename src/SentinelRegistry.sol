// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";
import { FixedPoint } from "./libraries/FixedPoint.sol";
import { PayoutMath } from "./libraries/PayoutMath.sol";

/// @title SentinelRegistry
/// @notice Operator-managed list of insurable stablecoins and their risk parameters. The single
///         source of truth for "what can be insured and on what terms." Only registered + active
///         stables can back a policy or trigger an event (CLAUDE.md §11).
/// @dev    Config is intentionally all-integer (CLAUDE.md Hard Rule #10): peg + tiers in WAD/bps.
///         Issuer URLs are stored for the investigation agents (LLM Parse Website) to read.
contract SentinelRegistry is AccessControl {
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");

    /// @notice Per-stablecoin configuration.
    /// @param pegTarget          Reference value in WAD (1e18 == $1.00).
    /// @param depegThresholdBps  Deviation that arms detection (bps).
    /// @param minDurationSeconds Sustained-deviation requirement before an event is valid.
    /// @param annualRateBps      Premium rate (bps/yr) — default range 30–80 (§5).
    /// @param tiers              Deviation tiers scaling the payout factor (§5).
    /// @param homepageUrl        Issuer homepage (LLM Parse Website target).
    /// @param socialUrl          Issuer social/X (LLM Parse Website target).
    /// @param repoUrl            Issuer repo / recent commits (LLM Parse Website target).
    /// @param active             Only active stables can be insured or trigger events.
    /// @param exists             Distinguishes a never-registered stable from a deactivated one.
    struct StableConfig {
        uint256 pegTarget;
        uint16 depegThresholdBps;
        uint32 minDurationSeconds;
        uint16 annualRateBps;
        PayoutMath.DeviationTiers tiers;
        string homepageUrl;
        string socialUrl;
        string repoUrl;
        bool active;
        bool exists;
    }

    mapping(address stable => StableConfig config) private _configs;
    address[] private _stables;

    event StableRegistered(address indexed stable, uint256 pegTarget, uint16 annualRateBps);
    event StableConfigUpdated(address indexed stable);
    event StableActiveSet(address indexed stable, bool active);

    error AlreadyRegistered(address stable);
    error NotRegistered(address stable);
    error InvalidConfig(string reason);

    constructor(address operator) {
        _grantRole(DEFAULT_ADMIN_ROLE, operator);
        _grantRole(OPERATOR_ROLE, operator);
    }

    // ─────────────────────────────── operator writes ───────────────────────────────

    /// @notice Register a new insurable stablecoin. Reverts if already registered.
    function registerStable(
        address stable,
        uint256 pegTarget,
        uint16 depegThresholdBps,
        uint32 minDurationSeconds,
        uint16 annualRateBps,
        PayoutMath.DeviationTiers calldata tiers,
        string calldata homepageUrl,
        string calldata socialUrl,
        string calldata repoUrl
    ) external onlyRole(OPERATOR_ROLE) {
        if (stable == address(0)) revert InvalidConfig("stable=0");
        if (_configs[stable].exists) revert AlreadyRegistered(stable);
        _validate(pegTarget, depegThresholdBps, annualRateBps, tiers);

        _configs[stable] = StableConfig({
            pegTarget: pegTarget,
            depegThresholdBps: depegThresholdBps,
            minDurationSeconds: minDurationSeconds,
            annualRateBps: annualRateBps,
            tiers: tiers,
            homepageUrl: homepageUrl,
            socialUrl: socialUrl,
            repoUrl: repoUrl,
            active: true,
            exists: true
        });
        _stables.push(stable);
        emit StableRegistered(stable, pegTarget, annualRateBps);
    }

    /// @notice Update risk parameters for an already-registered stable. Preserves active flag.
    function updateConfig(
        address stable,
        uint256 pegTarget,
        uint16 depegThresholdBps,
        uint32 minDurationSeconds,
        uint16 annualRateBps,
        PayoutMath.DeviationTiers calldata tiers,
        string calldata homepageUrl,
        string calldata socialUrl,
        string calldata repoUrl
    ) external onlyRole(OPERATOR_ROLE) {
        StableConfig storage c = _configs[stable];
        if (!c.exists) revert NotRegistered(stable);
        _validate(pegTarget, depegThresholdBps, annualRateBps, tiers);

        c.pegTarget = pegTarget;
        c.depegThresholdBps = depegThresholdBps;
        c.minDurationSeconds = minDurationSeconds;
        c.annualRateBps = annualRateBps;
        c.tiers = tiers;
        c.homepageUrl = homepageUrl;
        c.socialUrl = socialUrl;
        c.repoUrl = repoUrl;
        emit StableConfigUpdated(stable);
    }

    /// @notice Activate or deactivate a registered stable.
    function setActive(address stable, bool active) external onlyRole(OPERATOR_ROLE) {
        if (!_configs[stable].exists) revert NotRegistered(stable);
        _configs[stable].active = active;
        emit StableActiveSet(stable, active);
    }

    // ─────────────────────────────────── getters ───────────────────────────────────

    /// @notice Full config for a stable. Reverts if never registered.
    function getConfig(address stable) external view returns (StableConfig memory) {
        if (!_configs[stable].exists) revert NotRegistered(stable);
        return _configs[stable];
    }

    /// @notice True only if the stable is registered AND active (the gate for insuring/triggering).
    function isInsurable(address stable) external view returns (bool) {
        StableConfig storage c = _configs[stable];
        return c.exists && c.active;
    }

    function pegTargetOf(address stable) external view returns (uint256) {
        if (!_configs[stable].exists) revert NotRegistered(stable);
        return _configs[stable].pegTarget;
    }

    function tiersOf(address stable) external view returns (PayoutMath.DeviationTiers memory) {
        if (!_configs[stable].exists) revert NotRegistered(stable);
        return _configs[stable].tiers;
    }

    /// @notice All registered stables (active or not), in registration order.
    function allStables() external view returns (address[] memory) {
        return _stables;
    }

    function stableCount() external view returns (uint256) {
        return _stables.length;
    }

    // ─────────────────────────────────── internal ──────────────────────────────────

    function _validate(
        uint256 pegTarget_,
        uint16 depegThresholdBps_,
        uint16 annualRateBps_,
        PayoutMath.DeviationTiers calldata tiers_
    ) private pure {
        if (pegTarget_ == 0) revert InvalidConfig("peg=0");
        if (depegThresholdBps_ == 0 || depegThresholdBps_ > FixedPoint.BPS_DENOMINATOR) {
            revert InvalidConfig("threshold");
        }
        if (annualRateBps_ == 0 || annualRateBps_ > FixedPoint.BPS_DENOMINATOR) {
            revert InvalidConfig("rate");
        }
        // Tiers must be strictly increasing and within range.
        if (
            tiers_.noPayoutBps >= tiers_.partialBps || tiers_.partialBps >= tiers_.highBps
                || tiers_.highBps > FixedPoint.BPS_DENOMINATOR
        ) {
            revert InvalidConfig("tiers");
        }
    }
}
