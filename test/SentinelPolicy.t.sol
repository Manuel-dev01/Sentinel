// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";
import { SentinelPolicy } from "../src/SentinelPolicy.sol";
import { SentinelPool } from "../src/SentinelPool.sol";
import { SentinelRegistry } from "../src/SentinelRegistry.sol";
import { MockStable } from "../src/mocks/MockStable.sol";
import { PayoutMath } from "../src/libraries/PayoutMath.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract SentinelPolicyTest is Test {
    SentinelRegistry internal registry;
    SentinelPool internal pool;
    SentinelPolicy internal policy;
    MockStable internal asset;

    address internal operator;
    address internal claimManager; // Oracle/Treasury stand-in
    address internal lp = makeAddr("lp");
    address internal buyer = makeAddr("buyer");

    address internal stable = makeAddr("USDx");
    uint64 internal constant MIN_AGE = 1 hours;
    uint16 internal constant ANNUAL_RATE_BPS = 50; // 0.50%/yr

    PayoutMath.DeviationTiers internal tiers =
        PayoutMath.DeviationTiers({ noPayoutBps: 200, partialBps: 500, highBps: 1000 });

    function setUp() public {
        operator = makeAddr("operator");
        claimManager = makeAddr("claimManager");
        asset = new MockStable("USD Coin", "USDC", 18);
        registry = new SentinelRegistry(operator);
        pool = new SentinelPool(IERC20(address(asset)), operator, 8_000);
        policy = new SentinelPolicy(IERC20(address(asset)), registry, pool, operator, MIN_AGE);

        vm.startPrank(operator);
        registry.registerStable(stable, 1e18, 50, 60, ANNUAL_RATE_BPS, tiers, "h", "s", "r");
        pool.grantRole(pool.POLICY_ROLE(), address(policy));
        policy.grantRole(policy.CLAIM_MANAGER_ROLE(), claimManager);
        vm.stopPrank();

        // Seed an LP so the pool has capital to back coverage (cap is 80% of this).
        asset.mint(lp, 10_000_000e18);
        vm.startPrank(lp);
        asset.approve(address(pool), type(uint256).max);
        pool.deposit(10_000_000e18, lp);
        vm.stopPrank();

        // Fund the buyer + approve the policy contract for premiums.
        asset.mint(buyer, 1_000_000e18);
        vm.prank(buyer);
        asset.approve(address(policy), type(uint256).max);
    }

    function _buy(uint256 notional, uint64 term) internal returns (uint256) {
        vm.prank(buyer);
        return policy.buy(stable, notional, term);
    }

    // ─────────────────────────────── quote / premium math ───────────────────────────────

    function test_quote_matches_formula() public view {
        // 1,000,000 notional × 50bps × 365d / (10_000 × 365d) = 5,000
        uint256 q = policy.quote(stable, 1_000_000e18, 365 days);
        assertEq(q, 5_000e18);
    }

    function test_quote_prorates_by_term() public view {
        // half a year → half the annual premium
        uint256 q = policy.quote(stable, 1_000_000e18, 182.5 days);
        assertEq(q, 2_500e18);
    }

    // ─────────────────────────────── buy ───────────────────────────────

    function test_buy_mints_nft_and_routes_premium() public {
        uint256 navBefore = pool.totalAssets();
        uint256 tokenId = _buy(1_000_000e18, 365 days);

        assertEq(policy.ownerOf(tokenId), buyer);
        SentinelPolicy.Policy memory p = policy.getPolicy(tokenId);
        assertEq(uint8(p.status), uint8(SentinelPolicy.Status.Active));
        assertEq(p.notional, 1_000_000e18);
        assertEq(p.premiumPaid, 5_000e18);
        assertEq(p.minAge, MIN_AGE);

        // premium accrued to the pool as yield
        assertEq(pool.totalAssets(), navBefore + 5_000e18);
        // liability recorded
        assertEq(pool.outstandingLiability(), 1_000_000e18);
    }

    function test_buy_unregistered_stable_reverts() public {
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(SentinelPolicy.NotInsurable.selector, address(0xDEAD)));
        policy.buy(address(0xDEAD), 1e18, 365 days);
    }

    function test_buy_inactive_stable_reverts() public {
        vm.prank(operator);
        registry.setActive(stable, false);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(SentinelPolicy.NotInsurable.selector, stable));
        policy.buy(stable, 1e18, 365 days);
    }

    function test_buy_blocked_by_utilization_cap() public {
        // Cap is 80% of 10M = 8M. A 9M notional must revert from the pool.
        vm.prank(buyer);
        vm.expectRevert();
        policy.buy(stable, 9_000_000e18, 365 days);
    }

    // ─────────────────────────────── anti-farming (the headline test) ───────────────────────────────

    function test_claim_rejected_when_bought_after_event_trigger() public {
        // The depeg triggered "now".
        uint64 triggeredAt = uint64(block.timestamp);

        // Attacker buys coverage 1 second AFTER the trigger.
        vm.warp(triggeredAt + 1);
        uint256 tokenId = _buy(1_000_000e18, 365 days);

        // Oracle tries to mark it claimable for the earlier event → rejected: start+minAge > trigger.
        vm.prank(claimManager);
        vm.expectRevert(abi.encodeWithSelector(SentinelPolicy.NotEligibleAtTrigger.selector, tokenId));
        policy.markClaimable(tokenId, stable, triggeredAt);
    }

    function test_claim_rejected_before_minAge() public {
        uint256 tokenId = _buy(1_000_000e18, 365 days);
        // Event triggers 30 min in — before the 1h min-age.
        uint64 triggeredAt = uint64(block.timestamp) + 30 minutes;
        vm.prank(claimManager);
        vm.expectRevert(abi.encodeWithSelector(SentinelPolicy.NotEligibleAtTrigger.selector, tokenId));
        policy.markClaimable(tokenId, stable, triggeredAt);
    }

    function test_claim_allowed_after_minAge_within_term() public {
        uint256 tokenId = _buy(1_000_000e18, 365 days);
        uint64 triggeredAt = uint64(block.timestamp) + 2 hours; // past 1h min-age, within term
        vm.prank(claimManager);
        policy.markClaimable(tokenId, stable, triggeredAt);
        assertEq(uint8(policy.getPolicy(tokenId).status), uint8(SentinelPolicy.Status.Claimable));
    }

    function test_claim_rejected_after_term() public {
        uint256 tokenId = _buy(1_000_000e18, 30 days);
        uint64 triggeredAt = uint64(block.timestamp) + 31 days; // after term
        vm.prank(claimManager);
        vm.expectRevert(abi.encodeWithSelector(SentinelPolicy.NotEligibleAtTrigger.selector, tokenId));
        policy.markClaimable(tokenId, stable, triggeredAt);
    }

    function test_claim_rejected_for_wrong_stable() public {
        uint256 tokenId = _buy(1_000_000e18, 365 days);
        address otherStable = makeAddr("OTHER");
        uint64 triggeredAt = uint64(block.timestamp) + 2 hours;
        vm.prank(claimManager);
        vm.expectRevert(
            abi.encodeWithSelector(SentinelPolicy.StableMismatch.selector, tokenId, stable, otherStable)
        );
        policy.markClaimable(tokenId, otherStable, triggeredAt);
    }

    function test_isEligibleAt_view_matches_gate() public {
        uint256 tokenId = _buy(1_000_000e18, 365 days);
        uint64 start = uint64(block.timestamp);
        assertFalse(policy.isEligibleAt(tokenId, stable, start + 30 minutes), "before minAge");
        assertTrue(policy.isEligibleAt(tokenId, stable, start + 2 hours), "in window");
        assertFalse(policy.isEligibleAt(tokenId, stable, start + 400 days), "after term");
        assertFalse(policy.isEligibleAt(tokenId, address(0xBEEF), start + 2 hours), "wrong stable");
    }

    // ─────────────────────────────── claimed / liability release ───────────────────────────────

    function test_markClaimed_releases_liability() public {
        uint256 tokenId = _buy(1_000_000e18, 365 days);
        uint64 triggeredAt = uint64(block.timestamp) + 2 hours;
        vm.startPrank(claimManager);
        policy.markClaimable(tokenId, stable, triggeredAt);
        policy.markClaimed(tokenId);
        vm.stopPrank();
        assertEq(uint8(policy.getPolicy(tokenId).status), uint8(SentinelPolicy.Status.Claimed));
        assertEq(pool.outstandingLiability(), 0);
    }

    // ─────────────────────────────── expire ───────────────────────────────

    function test_expire_after_term_releases_liability() public {
        uint256 tokenId = _buy(1_000_000e18, 30 days);
        assertEq(pool.outstandingLiability(), 1_000_000e18);
        vm.warp(block.timestamp + 31 days);
        policy.expire(tokenId); // permissionless
        assertEq(uint8(policy.getPolicy(tokenId).status), uint8(SentinelPolicy.Status.Expired));
        assertEq(pool.outstandingLiability(), 0);
    }

    function test_expire_before_term_reverts() public {
        uint256 tokenId = _buy(1_000_000e18, 30 days);
        vm.expectRevert(abi.encodeWithSelector(SentinelPolicy.TermNotElapsed.selector, tokenId));
        policy.expire(tokenId);
    }

    // ─────────────────────────────── access control ───────────────────────────────

    function test_only_claim_manager_can_markClaimable() public {
        uint256 tokenId = _buy(1_000_000e18, 365 days);
        uint64 triggeredAt = uint64(block.timestamp) + 2 hours;
        vm.prank(buyer);
        vm.expectRevert();
        policy.markClaimable(tokenId, stable, triggeredAt);
    }

    function test_markClaimable_unknown_policy_reverts() public {
        vm.prank(claimManager);
        vm.expectRevert(abi.encodeWithSelector(SentinelPolicy.UnknownPolicy.selector, uint256(999)));
        policy.markClaimable(999, stable, uint64(block.timestamp));
    }

    function test_pause_blocks_buy() public {
        vm.prank(operator);
        policy.pause();
        vm.prank(buyer);
        vm.expectRevert();
        policy.buy(stable, 1e18, 365 days);
    }

    // ─────────────────────────────── fuzz ───────────────────────────────

    /// Premium is always ≤ notional for sane rates/terms (never overcharges beyond principal in ≤1yr).
    function testFuzz_premium_below_notional(uint256 notional, uint64 term) public view {
        notional = bound(notional, 1e18, 1_000_000e18);
        term = uint64(bound(term, 1 days, 365 days));
        uint256 q = policy.quote(stable, notional, term);
        assertLe(q, notional);
    }

    /// A policy bought at-or-after the trigger instant is never eligible for that event.
    function testFuzz_buy_after_trigger_never_eligible(uint64 delay) public {
        uint64 triggeredAt = uint64(block.timestamp);
        delay = uint64(bound(delay, 0, 365 days));
        vm.warp(triggeredAt + delay);
        uint256 tokenId = _buy(1_000e18, 365 days);
        // The policy started at triggeredAt+delay ≥ triggeredAt, so with any minAge≥0 it cannot be
        // eligible for an event at triggeredAt.
        assertFalse(policy.isEligibleAt(tokenId, stable, triggeredAt));
    }
}
