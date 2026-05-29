// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title FixedPoint
/// @notice The single money convention for Sentinel: all prices, NAV, and notionals are
///         18-decimal fixed point (1e18 == $1.00 / 1.0 share). Basis points are integers out
///         of 10_000. No floats anywhere (CLAUDE.md Hard Rule #10).
/// @dev    Solidity 0.8 reverts on overflow natively; these helpers exist to keep rounding
///         direction explicit and the WAD/BPS constants in one place.
library FixedPoint {
    /// @notice 1.0 in 18-decimal fixed point.
    uint256 internal constant WAD = 1e18;

    /// @notice 100% in basis points.
    uint256 internal constant BPS_DENOMINATOR = 10_000;

    /// @notice Seconds in a 365-day year, for premium proration.
    uint256 internal constant SECONDS_PER_YEAR = 365 days;

    /// @notice Multiply two WADs, rounding down. (a * b) / 1e18.
    function mulWad(uint256 a, uint256 b) internal pure returns (uint256) {
        return (a * b) / WAD;
    }

    /// @notice Divide two WADs, rounding down. (a * 1e18) / b.
    function divWad(uint256 a, uint256 b) internal pure returns (uint256) {
        return (a * WAD) / b;
    }

    /// @notice Apply a basis-point rate to an amount, rounding down. amount * bps / 10_000.
    function bps(uint256 amount, uint256 rateBps) internal pure returns (uint256) {
        return (amount * rateBps) / BPS_DENOMINATOR;
    }

    /// @notice Absolute deviation of `price` from `peg`, expressed in basis points.
    /// @dev    Both inputs in WAD. Returns |price - peg| / peg * 10_000, rounded down.
    function deviationBps(uint256 price, uint256 peg) internal pure returns (uint256) {
        if (peg == 0) return 0;
        uint256 diff = price > peg ? price - peg : peg - price;
        return (diff * BPS_DENOMINATOR) / peg;
    }
}
