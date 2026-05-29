// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";
import { FixedPoint } from "../src/libraries/FixedPoint.sol";

contract FixedPointTest is Test {
    using FixedPoint for uint256;

    function test_constants() public pure {
        assertEq(FixedPoint.WAD, 1e18);
        assertEq(FixedPoint.BPS_DENOMINATOR, 10_000);
        assertEq(FixedPoint.SECONDS_PER_YEAR, 365 days);
    }

    function test_bps() public pure {
        assertEq(FixedPoint.bps(1_000_000e18, 50), 5_000e18, "50bps of 1M");
        assertEq(FixedPoint.bps(1_000e18, 10_000), 1_000e18, "100%");
        assertEq(FixedPoint.bps(1_000e18, 0), 0);
    }

    function test_deviationBps_at_and_off_peg() public pure {
        uint256 peg = 1e18;
        assertEq(FixedPoint.deviationBps(1e18, peg), 0, "at peg");
        assertEq(FixedPoint.deviationBps(0.94e18, peg), 600, "6% below");
        assertEq(FixedPoint.deviationBps(1.02e18, peg), 200, "2% above");
        assertEq(FixedPoint.deviationBps(0.9e18, peg), 1_000, "10% below");
    }

    function test_deviationBps_zero_peg_is_zero() public pure {
        assertEq(FixedPoint.deviationBps(1e18, 0), 0);
    }

    function test_mulWad_divWad() public pure {
        assertEq(FixedPoint.mulWad(2e18, 3e18), 6e18);
        assertEq(FixedPoint.divWad(6e18, 3e18), 2e18);
    }

    /// deviation is symmetric around the peg
    function testFuzz_deviation_symmetric(uint256 delta) public pure {
        uint256 peg = 1e18;
        delta = bound(delta, 0, 0.5e18);
        assertEq(FixedPoint.deviationBps(peg + delta, peg), FixedPoint.deviationBps(peg - delta, peg));
    }
}
