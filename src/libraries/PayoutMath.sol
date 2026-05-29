// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Classification } from "./Classification.sol";
import { FixedPoint } from "./FixedPoint.sol";

/// @title PayoutMath
/// @notice Pure implementation of the §5 payout matrix: maps (classification, deviation) to a
///         payout factor in basis points and a settlement timing. All matrix logic lives here so
///         it's unit-testable in isolation and has a single source of truth.
/// @dev    Factor model: `factor = classCapBps × tierScaleBps / 10_000`, where the tier scale is
///         derived from how far the deviation sits across the configured tier thresholds. Two
///         classes are special: SMART_CONTRACT_EXPLOIT always pays its full cap (an exploit is an
///         exploit regardless of the transient price print), and REGULATORY is a flat 50% (legal
///         actions aren't well-modeled by price magnitude). BANK_RUN/TECHNICAL_GLITCH/UNKNOWN
///         scale with deviation.
library PayoutMath {
    using FixedPoint for uint256;

    /// @notice When a payout is releasable.
    enum Timing {
        IMMEDIATE, // same/next block — exploits
        VESTED_24H, // linear or cliff release over 24h — bank run, regulatory
        DELAYED // released only after a confirmation window — glitch, unknown
    }

    /// @notice Configurable deviation tiers (CLAUDE.md §5). Boundaries in basis points.
    ///         Example defaults: noPayout=200 (2%), partial=500 (5%), high=1000 (10%).
    ///         < noPayoutBps         → scale 0
    ///         [noPayout, partial)   → scale 33%   (3_333 bps)
    ///         [partial, high)       → scale 66%   (6_666 bps)
    ///         >= highBps            → scale 100%  (10_000 bps)
    struct DeviationTiers {
        uint16 noPayoutBps;
        uint16 partialBps;
        uint16 highBps;
    }

    uint256 internal constant FULL = FixedPoint.BPS_DENOMINATOR; // 10_000 = 100%

    /// @notice Per-class cap (max payout factor as a fraction of notional, in bps).
    function capBps(Classification.Cause cause) internal pure returns (uint256) {
        if (cause == Classification.Cause.SMART_CONTRACT_EXPLOIT) return 10_000; // 100%
        if (cause == Classification.Cause.BANK_RUN) return 10_000; // up to 100%, scaled
        if (cause == Classification.Cause.REGULATORY) return 5_000; // flat 50%
        if (cause == Classification.Cause.TECHNICAL_GLITCH) return 2_500; // up to 25%, scaled
        return 2_500; // UNKNOWN — conservative 25%, scaled
    }

    /// @notice Settlement timing per class.
    function timing(Classification.Cause cause) internal pure returns (Timing) {
        if (cause == Classification.Cause.SMART_CONTRACT_EXPLOIT) return Timing.IMMEDIATE;
        if (cause == Classification.Cause.BANK_RUN) return Timing.VESTED_24H;
        if (cause == Classification.Cause.REGULATORY) return Timing.VESTED_24H;
        return Timing.DELAYED; // TECHNICAL_GLITCH, UNKNOWN
    }

    /// @notice Tier scale (bps) for a deviation given the configured thresholds.
    function tierScaleBps(uint256 devBps, DeviationTiers memory tiers) internal pure returns (uint256) {
        if (devBps < tiers.noPayoutBps) return 0;
        if (devBps < tiers.partialBps) return 3_333;
        if (devBps < tiers.highBps) return 6_666;
        return FULL;
    }

    /// @notice The payout factor (bps of notional) for a (cause, deviation) pair.
    /// @dev    EXPLOIT and REGULATORY ignore the tier scale (full cap); the rest scale by tier.
    function payoutFactorBps(Classification.Cause cause, uint256 devBps, DeviationTiers memory tiers)
        internal
        pure
        returns (uint256)
    {
        // Below the no-payout floor, nothing pays regardless of class — a sub-threshold blip is
        // not an insured event.
        if (devBps < tiers.noPayoutBps) return 0;

        uint256 cap = capBps(cause);

        // TODO(revisit before mainnet): EXPLOIT and REGULATORY intentionally ignore the deviation
        // tier — exploit pays a flat 100%, regulatory a flat 50%, on the theory that cause severity
        // (not the transient price magnitude) drives those two. A reviewer may want a tiny exploit
        // that barely moved the peg to pay <100%. If so, drop them into the scaled branch below;
        // it's a localized change (no other contract depends on the internal shape). See
        // docs/ARCHITECTURE.md §8.
        if (cause == Classification.Cause.SMART_CONTRACT_EXPLOIT || cause == Classification.Cause.REGULATORY)
        {
            return cap;
        }

        return (cap * tierScaleBps(devBps, tiers)) / FULL;
    }

    /// @notice The actual payout amount (in asset units, WAD) for a policy.
    /// @param  notional The insured notional (WAD).
    function payoutAmount(
        Classification.Cause cause,
        uint256 devBps,
        DeviationTiers memory tiers,
        uint256 notional
    ) internal pure returns (uint256) {
        return notional.bps(payoutFactorBps(cause, devBps, tiers));
    }
}
