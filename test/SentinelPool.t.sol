// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";
import { SentinelPool } from "../src/SentinelPool.sol";
import { MockStable } from "../src/mocks/MockStable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract SentinelPoolTest is Test {
    SentinelPool internal pool;
    MockStable internal asset;

    address internal operator;
    address internal policy; // holds POLICY_ROLE
    address internal treasury; // holds TREASURY_ROLE
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal claimant = makeAddr("claimant");

    uint16 internal constant CAP_BPS = 8_000; // 80% utilization cap

    function setUp() public {
        operator = makeAddr("operator");
        policy = makeAddr("policy");
        treasury = makeAddr("treasury");
        asset = new MockStable("USD Coin", "USDC", 18);
        pool = new SentinelPool(IERC20(address(asset)), operator, CAP_BPS);

        vm.startPrank(operator);
        pool.grantRole(pool.POLICY_ROLE(), policy);
        pool.grantRole(pool.TREASURY_ROLE(), treasury);
        vm.stopPrank();

        // Seed balances + approvals.
        asset.mint(alice, 1_000_000e18);
        asset.mint(bob, 1_000_000e18);
        asset.mint(policy, 1_000_000e18);
        vm.prank(alice);
        asset.approve(address(pool), type(uint256).max);
        vm.prank(bob);
        asset.approve(address(pool), type(uint256).max);
        vm.prank(policy);
        asset.approve(address(pool), type(uint256).max);
    }

    function _deposit(address lp, uint256 amt) internal returns (uint256) {
        vm.prank(lp);
        return pool.deposit(amt, lp);
    }

    // ───────────────────────────── deposit / redeem ─────────────────────────────

    function test_first_deposit_mints_shares_and_tracks_assets() public {
        uint256 shares = _deposit(alice, 100e18);
        assertGt(shares, 0);
        assertEq(pool.totalAssets(), 100e18);
        assertEq(pool.sharesOf(alice), shares);
        assertEq(asset.balanceOf(address(pool)), 100e18);
    }

    function test_redeem_returns_assets_and_burns_shares() public {
        uint256 shares = _deposit(alice, 100e18);
        vm.prank(alice);
        uint256 assets = pool.redeem(shares, alice);
        assertApproxEqAbs(assets, 100e18, 1); // virtual-offset rounding ≤ 1 wei
        assertEq(pool.sharesOf(alice), 0);
        assertEq(pool.totalShares(), 0);
    }

    function test_premium_raises_nav_for_existing_lp() public {
        uint256 shares = _deposit(alice, 100e18);
        // Premium accrues → NAV per share rises.
        vm.prank(policy);
        pool.accruePremium(50e18);
        assertEq(pool.totalAssets(), 150e18);
        // Alice's shares now redeem for ~150.
        assertApproxEqAbs(pool.convertToAssets(shares), 150e18, 2);
    }

    function test_second_depositor_not_diluted_by_premium() public {
        uint256 aliceShares = _deposit(alice, 100e18);
        vm.prank(policy);
        pool.accruePremium(100e18); // NAV doubles: 100 assets → 200
        uint256 bobShares = _deposit(bob, 200e18); // bob pays 200 for ~same claim as alice

        // Alice and Bob should each be able to redeem ~ what they're owed; total conserved.
        uint256 aliceOut = pool.convertToAssets(aliceShares);
        uint256 bobOut = pool.convertToAssets(bobShares);
        assertApproxEqRel(aliceOut, 200e18, 0.01e18); // alice's 100 grew to ~200
        assertApproxEqRel(bobOut, 200e18, 0.01e18); // bob's 200 stays ~200
    }

    // ───────────────────────────── withdrawal lock (§6) ─────────────────────────────

    function test_cannot_redeem_reserved_capital() public {
        uint256 shares = _deposit(alice, 100e18);
        // Treasury reserves 60 for a settling event.
        vm.prank(treasury);
        pool.reserveForEvent(60e18);
        assertEq(pool.availableCapital(), 40e18);

        // Alice tries to pull all 100 → blocked; only 40 is available.
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(SentinelPool.ExceedsAvailableCapital.selector, 100e18, 40e18));
        pool.redeem(shares, alice);

        // She can pull the available 40 worth.
        uint256 partialShares = pool.convertToShares(40e18);
        vm.prank(alice);
        pool.redeem(partialShares, alice);
    }

    function test_release_reserve_restores_availability() public {
        _deposit(alice, 100e18);
        vm.prank(treasury);
        pool.reserveForEvent(60e18);
        vm.prank(treasury);
        pool.releaseReserve(60e18);
        assertEq(pool.availableCapital(), 100e18);
    }

    // ───────────────────────────── payout ─────────────────────────────

    function test_payout_reduces_nav_and_reserve() public {
        _deposit(alice, 100e18);
        vm.prank(treasury);
        pool.reserveForEvent(60e18);
        vm.prank(treasury);
        pool.payOut(claimant, 60e18);
        assertEq(asset.balanceOf(claimant), 60e18);
        assertEq(pool.totalAssets(), 40e18);
        assertEq(pool.reservedCapital(), 0);
    }

    // ───────────────────────────── liability / cap ─────────────────────────────

    function test_increaseLiability_enforces_cap() public {
        _deposit(alice, 100e18); // cap 80% → max liability 80
        vm.prank(policy);
        pool.increaseLiability(80e18); // exactly at cap, ok
        assertEq(pool.outstandingLiability(), 80e18);

        vm.prank(policy);
        vm.expectRevert(abi.encodeWithSelector(SentinelPool.UtilizationCapExceeded.selector, 81e18, 80e18));
        pool.increaseLiability(1e18);
    }

    function test_maxNewLiability_tracks_cap() public {
        _deposit(alice, 100e18);
        assertEq(pool.maxNewLiability(), 80e18);
        vm.prank(policy);
        pool.increaseLiability(30e18);
        assertEq(pool.maxNewLiability(), 50e18);
    }

    function test_decreaseLiability() public {
        _deposit(alice, 100e18);
        vm.prank(policy);
        pool.increaseLiability(50e18);
        vm.prank(policy);
        pool.decreaseLiability(20e18);
        assertEq(pool.outstandingLiability(), 30e18);
    }

    // ───────────────────────────── access control ─────────────────────────────

    function test_only_policy_can_accruePremium() public {
        vm.prank(alice);
        vm.expectRevert();
        pool.accruePremium(1e18);
    }

    function test_only_treasury_can_payOut() public {
        _deposit(alice, 100e18);
        vm.prank(alice);
        vm.expectRevert();
        pool.payOut(claimant, 1e18);
    }

    function test_only_treasury_can_reserve() public {
        _deposit(alice, 100e18);
        vm.prank(policy);
        vm.expectRevert();
        pool.reserveForEvent(1e18);
    }

    function test_reserve_cannot_exceed_available() public {
        _deposit(alice, 100e18);
        vm.prank(treasury);
        vm.expectRevert(abi.encodeWithSelector(SentinelPool.ExceedsAvailableCapital.selector, 101e18, 100e18));
        pool.reserveForEvent(101e18);
    }

    // ───────────────────────────── pause ─────────────────────────────

    function test_pause_blocks_deposit() public {
        vm.prank(operator);
        pool.pause();
        vm.prank(alice);
        vm.expectRevert();
        pool.deposit(1e18, alice);
    }

    // ───────────────────────────── fuzz: value conservation ─────────────────────────────

    /// Depositing then immediately redeeming all shares never returns more than deposited
    /// (no value minted from nothing); difference is at most rounding dust.
    function testFuzz_deposit_redeem_no_value_creation(uint256 amt) public {
        amt = bound(amt, 1e6, 1_000_000e18);
        uint256 shares = _deposit(alice, amt);
        vm.prank(alice);
        uint256 out = pool.redeem(shares, alice);
        assertLe(out, amt, "never get more than put in");
        assertApproxEqAbs(out, amt, 1e3, "minus only dust");
    }

    /// Across a random deposit/premium/deposit sequence, total redeemable never exceeds totalAssets.
    /// @dev Bob's deposit must be large enough relative to the post-premium NAV to mint ≥1 share;
    ///      otherwise the contract correctly reverts ZeroAmount on a dust deposit. We size it so the
    ///      property under test (no over-claim) is what's exercised, not the dust guard.
    function testFuzz_shares_never_overclaim(uint256 d1, uint256 prem, uint256 d2) public {
        d1 = bound(d1, 1e18, 1_000_000e18);
        prem = bound(prem, 0, 1_000_000e18);

        _deposit(alice, d1);
        if (prem > 0) {
            asset.mint(policy, prem);
            vm.prank(policy);
            pool.accruePremium(prem);
        }
        // NAV per share ≈ (d1+prem)/d1; require d2 ≥ that so ≥1 share mints.
        uint256 minD2 = ((d1 + prem) / d1) + 1;
        d2 = bound(d2, minD2 < 1e18 ? 1e18 : minD2, 1_000_000e18);
        asset.mint(bob, d2); // ensure balance regardless of the setUp seed
        _deposit(bob, d2);

        uint256 redeemable =
            pool.convertToAssets(pool.sharesOf(alice)) + pool.convertToAssets(pool.sharesOf(bob));
        assertLe(redeemable, pool.totalAssets(), "sum of claims <= backing");
    }
}
