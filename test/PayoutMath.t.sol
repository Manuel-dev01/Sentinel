// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";
import { PayoutMath } from "../src/libraries/PayoutMath.sol";
import { Classification } from "../src/libraries/Classification.sol";

contract PayoutMathTest is Test {
    using PayoutMath for *;

    // Default tiers from CLAUDE.md §5: <2% none, 2-5% partial, 5-10% high, >10% max.
    PayoutMath.DeviationTiers internal tiers =
        PayoutMath.DeviationTiers({ noPayoutBps: 200, partialBps: 500, highBps: 1000 });

    Classification.Cause constant EXPLOIT = Classification.Cause.SMART_CONTRACT_EXPLOIT;
    Classification.Cause constant BANK_RUN = Classification.Cause.BANK_RUN;
    Classification.Cause constant REGULATORY = Classification.Cause.REGULATORY;
    Classification.Cause constant GLITCH = Classification.Cause.TECHNICAL_GLITCH;
    Classification.Cause constant UNKNOWN = Classification.Cause.UNKNOWN;

    // ───────────────────────── per-class caps ─────────────────────────

    function test_caps_match_matrix() public pure {
        assertEq(PayoutMath.capBps(EXPLOIT), 10_000, "exploit 100%");
        assertEq(PayoutMath.capBps(BANK_RUN), 10_000, "bank run up to 100%");
        assertEq(PayoutMath.capBps(REGULATORY), 5_000, "regulatory 50%");
        assertEq(PayoutMath.capBps(GLITCH), 2_500, "glitch up to 25%");
        assertEq(PayoutMath.capBps(UNKNOWN), 2_500, "unknown 25%");
    }

    // ───────────────────────── per-class timing ─────────────────────────

    function test_timing_match_matrix() public pure {
        assertTrue(PayoutMath.timing(EXPLOIT) == PayoutMath.Timing.IMMEDIATE);
        assertTrue(PayoutMath.timing(BANK_RUN) == PayoutMath.Timing.VESTED_24H);
        assertTrue(PayoutMath.timing(REGULATORY) == PayoutMath.Timing.VESTED_24H);
        assertTrue(PayoutMath.timing(GLITCH) == PayoutMath.Timing.DELAYED);
        assertTrue(PayoutMath.timing(UNKNOWN) == PayoutMath.Timing.DELAYED);
    }

    // ───────────────────────── sub-threshold = nothing ─────────────────────────

    function test_below_floor_pays_zero_for_every_class() public view {
        uint256 dev = 100; // 1% < 2% floor
        assertEq(PayoutMath.payoutFactorBps(EXPLOIT, dev, tiers), 0);
        assertEq(PayoutMath.payoutFactorBps(BANK_RUN, dev, tiers), 0);
        assertEq(PayoutMath.payoutFactorBps(REGULATORY, dev, tiers), 0);
        assertEq(PayoutMath.payoutFactorBps(GLITCH, dev, tiers), 0);
        assertEq(PayoutMath.payoutFactorBps(UNKNOWN, dev, tiers), 0);
    }

    // ───────────────────────── EXPLOIT: full cap once over floor ─────────────────────────

    function test_exploit_pays_full_regardless_of_tier() public view {
        assertEq(PayoutMath.payoutFactorBps(EXPLOIT, 200, tiers), 10_000, "at floor");
        assertEq(PayoutMath.payoutFactorBps(EXPLOIT, 500, tiers), 10_000, "partial");
        assertEq(PayoutMath.payoutFactorBps(EXPLOIT, 5_000, tiers), 10_000, "huge");
    }

    // ───────────────────────── REGULATORY: flat 50% once over floor ─────────────────────────

    function test_regulatory_flat_50() public view {
        assertEq(PayoutMath.payoutFactorBps(REGULATORY, 200, tiers), 5_000);
        assertEq(PayoutMath.payoutFactorBps(REGULATORY, 9_999, tiers), 5_000);
    }

    // ───────────────────────── BANK_RUN scales by tier ─────────────────────────

    function test_bank_run_scales_by_tier() public view {
        // [200,500) → 33% of 10_000 = 3_333
        assertEq(PayoutMath.payoutFactorBps(BANK_RUN, 200, tiers), 3_333);
        assertEq(PayoutMath.payoutFactorBps(BANK_RUN, 499, tiers), 3_333);
        // [500,1000) → 66% = 6_666
        assertEq(PayoutMath.payoutFactorBps(BANK_RUN, 500, tiers), 6_666);
        assertEq(PayoutMath.payoutFactorBps(BANK_RUN, 999, tiers), 6_666);
        // >=1000 → 100% = 10_000
        assertEq(PayoutMath.payoutFactorBps(BANK_RUN, 1_000, tiers), 10_000);
        assertEq(PayoutMath.payoutFactorBps(BANK_RUN, 5_000, tiers), 10_000);
    }

    // ───────────────────────── GLITCH / UNKNOWN scale within 25% cap ─────────────────────────

    function test_glitch_scales_within_cap() public view {
        // 2_500 cap × {33%,66%,100%}
        assertEq(PayoutMath.payoutFactorBps(GLITCH, 200, tiers), uint256(2_500 * 3_333) / 10_000); // 833
        assertEq(PayoutMath.payoutFactorBps(GLITCH, 500, tiers), uint256(2_500 * 6_666) / 10_000); // 1666
        assertEq(PayoutMath.payoutFactorBps(GLITCH, 1_000, tiers), 2_500);
    }

    function test_unknown_scales_within_cap() public view {
        assertEq(PayoutMath.payoutFactorBps(UNKNOWN, 1_000, tiers), 2_500);
        assertEq(PayoutMath.payoutFactorBps(UNKNOWN, 500, tiers), uint256(2_500 * 6_666) / 10_000);
    }

    // ───────────────────────── payout amount ─────────────────────────

    function test_payout_amount_applies_factor_to_notional() public view {
        uint256 notional = 1_000_000e18;
        // exploit at any over-floor deviation → 100%
        assertEq(PayoutMath.payoutAmount(EXPLOIT, 600, tiers, notional), notional);
        // regulatory → 50%
        assertEq(PayoutMath.payoutAmount(REGULATORY, 600, tiers, notional), notional / 2);
        // below floor → 0
        assertEq(PayoutMath.payoutAmount(EXPLOIT, 1, tiers, notional), 0);
    }

    // ───────────────────────── invariants / fuzz ─────────────────────────

    /// Factor never exceeds the class cap, ever.
    function testFuzz_factor_never_exceeds_cap(uint8 causeRaw, uint256 devBps) public view {
        Classification.Cause cause = Classification.Cause(uint8(bound(causeRaw, 0, 4)));
        devBps = bound(devBps, 0, 100_000);
        uint256 factor = PayoutMath.payoutFactorBps(cause, devBps, tiers);
        assertLe(factor, PayoutMath.capBps(cause));
    }

    /// Factor is monotonic non-decreasing in deviation (more severe never pays less).
    function testFuzz_factor_monotonic_in_deviation(uint8 causeRaw, uint256 a, uint256 b) public view {
        Classification.Cause cause = Classification.Cause(uint8(bound(causeRaw, 0, 4)));
        a = bound(a, 0, 100_000);
        b = bound(b, 0, 100_000);
        if (a > b) (a, b) = (b, a); // a <= b
        uint256 fa = PayoutMath.payoutFactorBps(cause, a, tiers);
        uint256 fb = PayoutMath.payoutFactorBps(cause, b, tiers);
        assertLe(fa, fb);
    }

    /// Payout amount never exceeds notional (factor <= 100%).
    function testFuzz_payout_never_exceeds_notional(uint8 causeRaw, uint256 devBps, uint256 notional)
        public
        view
    {
        Classification.Cause cause = Classification.Cause(uint8(bound(causeRaw, 0, 4)));
        devBps = bound(devBps, 0, 100_000);
        notional = bound(notional, 0, 1e30);
        assertLe(PayoutMath.payoutAmount(cause, devBps, tiers, notional), notional);
    }
}
