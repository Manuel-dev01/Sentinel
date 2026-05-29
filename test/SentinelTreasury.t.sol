// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";
import { SentinelTreasury } from "../src/SentinelTreasury.sol";
import { SentinelPolicy } from "../src/SentinelPolicy.sol";
import { SentinelPool } from "../src/SentinelPool.sol";
import { SentinelRegistry } from "../src/SentinelRegistry.sol";
import { MockStable } from "../src/mocks/MockStable.sol";
import { Classification } from "../src/libraries/Classification.sol";
import { PayoutMath } from "../src/libraries/PayoutMath.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract SentinelTreasuryTest is Test {
    SentinelRegistry internal registry;
    SentinelPool internal pool;
    SentinelPolicy internal policy;
    SentinelTreasury internal treasury;
    MockStable internal asset;

    address internal operator;
    address internal oracle; // holds ORACLE_ROLE on treasury
    address internal lp = makeAddr("lp");
    address internal buyer = makeAddr("buyer");
    address internal stable = makeAddr("USDx");

    uint64 internal constant MIN_AGE = 1 hours;
    uint256 internal constant NOTIONAL = 1_000_000e18;

    PayoutMath.DeviationTiers internal tiers =
        PayoutMath.DeviationTiers({ noPayoutBps: 200, partialBps: 500, highBps: 1000 });

    function setUp() public {
        operator = makeAddr("operator");
        oracle = makeAddr("oracle");
        asset = new MockStable("USD Coin", "USDC", 18);
        registry = new SentinelRegistry(operator);
        pool = new SentinelPool(IERC20(address(asset)), operator, 8_000);
        policy = new SentinelPolicy(IERC20(address(asset)), registry, pool, operator, MIN_AGE);
        treasury = new SentinelTreasury(registry, pool, policy, operator);

        vm.startPrank(operator);
        registry.registerStable(stable, 1e18, 50, 60, 50, tiers, "h", "s", "r");
        pool.grantRole(pool.POLICY_ROLE(), address(policy));
        pool.grantRole(pool.TREASURY_ROLE(), address(treasury));
        // The Treasury drives policy claim-state transitions.
        policy.grantRole(policy.CLAIM_MANAGER_ROLE(), address(treasury));
        treasury.grantRole(treasury.ORACLE_ROLE(), oracle);
        vm.stopPrank();

        // Seed pool capital.
        asset.mint(lp, 10_000_000e18);
        vm.startPrank(lp);
        asset.approve(address(pool), type(uint256).max);
        pool.deposit(10_000_000e18, lp);
        vm.stopPrank();

        // Buyer purchases a policy.
        asset.mint(buyer, 1_000_000e18);
        vm.prank(buyer);
        asset.approve(address(policy), type(uint256).max);
    }

    function _buy() internal returns (uint256) {
        vm.prank(buyer);
        return policy.buy(stable, NOTIONAL, 365 days);
    }

    function _record(uint256 eventId, Classification.Cause cause, uint256 devBps, uint64 triggeredAt)
        internal
    {
        vm.prank(oracle);
        treasury.recordVerdict(eventId, stable, cause, devBps, triggeredAt);
    }

    // ─────────────────────────── immediate (exploit) ───────────────────────────

    function test_exploit_pays_immediately_in_full() public {
        uint256 tokenId = _buy();
        uint64 trigger = uint64(block.timestamp) + 2 hours; // past min-age
        vm.warp(trigger);
        _record(1, Classification.Cause.SMART_CONTRACT_EXPLOIT, 600, trigger);

        uint256 balBefore = asset.balanceOf(buyer);
        treasury.settle(1, tokenId);

        // exploit = 100% of notional
        assertEq(asset.balanceOf(buyer) - balBefore, NOTIONAL);
        assertEq(uint8(policy.getPolicy(tokenId).status), uint8(SentinelPolicy.Status.Claimed));
        assertEq(pool.outstandingLiability(), 0, "liability released");
        assertEq(treasury.paidPerEvent(1), NOTIONAL);
        assertLe(treasury.paidPerEvent(1), treasury.reservedPerEvent(1), "paid <= reserved");
    }

    // ─────────────────────────── vested (bank run) ───────────────────────────

    function test_bank_run_vests_24h_then_claimable() public {
        uint256 tokenId = _buy();
        uint64 trigger = uint64(block.timestamp) + 2 hours;
        vm.warp(trigger);
        _record(1, Classification.Cause.BANK_RUN, 1_000, trigger); // tier max → 100% of notional

        uint256 balBefore = asset.balanceOf(buyer);
        treasury.settle(1, tokenId);
        // Not paid yet — vesting scheduled, balance unchanged.
        assertEq(asset.balanceOf(buyer), balBefore);
        (uint256 amount, uint64 releaseAt, bool claimed) = treasury.vestings(1, tokenId);
        assertEq(amount, NOTIONAL);
        assertEq(releaseAt, trigger + treasury.VESTED_24H_DELAY());
        assertFalse(claimed);

        // Claiming before release reverts.
        vm.expectRevert(
            abi.encodeWithSelector(SentinelTreasury.NotYetReleasable.selector, 1, tokenId, releaseAt)
        );
        treasury.claimVested(1, tokenId);

        // After the window, it pays.
        vm.warp(releaseAt);
        treasury.claimVested(1, tokenId);
        assertEq(asset.balanceOf(buyer) - balBefore, NOTIONAL);
        assertEq(uint8(policy.getPolicy(tokenId).status), uint8(SentinelPolicy.Status.Claimed));
    }

    function test_vested_cannot_double_claim() public {
        uint256 tokenId = _buy();
        uint64 trigger = uint64(block.timestamp) + 2 hours;
        vm.warp(trigger);
        _record(1, Classification.Cause.BANK_RUN, 1_000, trigger);
        treasury.settle(1, tokenId);
        vm.warp(trigger + treasury.VESTED_24H_DELAY());
        treasury.claimVested(1, tokenId);

        vm.expectRevert(abi.encodeWithSelector(SentinelTreasury.AlreadyClaimed.selector, 1, tokenId));
        treasury.claimVested(1, tokenId);
    }

    // ─────────────────────────── regulatory (flat 50%, vested) ───────────────────────────

    function test_regulatory_pays_half_vested() public {
        uint256 tokenId = _buy();
        uint64 trigger = uint64(block.timestamp) + 2 hours;
        vm.warp(trigger);
        _record(1, Classification.Cause.REGULATORY, 600, trigger);
        treasury.settle(1, tokenId);
        (uint256 amount,,) = treasury.vestings(1, tokenId);
        assertEq(amount, NOTIONAL / 2, "regulatory = 50%");
    }

    // ─────────────────────────── glitch (delayed window) ───────────────────────────

    function test_glitch_uses_delayed_window() public {
        uint256 tokenId = _buy();
        uint64 trigger = uint64(block.timestamp) + 2 hours;
        vm.warp(trigger);
        _record(1, Classification.Cause.TECHNICAL_GLITCH, 1_000, trigger); // 25% cap at top tier
        treasury.settle(1, tokenId);
        (uint256 amount, uint64 releaseAt,) = treasury.vestings(1, tokenId);
        assertEq(amount, NOTIONAL / 4, "glitch top tier = 25%");
        assertEq(releaseAt, trigger + treasury.DELAYED_WINDOW());
    }

    // ─────────────────────────── no-payout cases ───────────────────────────

    function test_below_floor_reverts_nothing_to_pay() public {
        uint256 tokenId = _buy();
        uint64 trigger = uint64(block.timestamp) + 2 hours;
        vm.warp(trigger);
        _record(1, Classification.Cause.SMART_CONTRACT_EXPLOIT, 100, trigger); // 1% < 2% floor
        vm.expectRevert(abi.encodeWithSelector(SentinelTreasury.NothingToPay.selector, tokenId));
        treasury.settle(1, tokenId);
    }

    // ─────────────────────────── double-settle guard ───────────────────────────

    function test_cannot_settle_same_policy_twice() public {
        uint256 tokenId = _buy();
        uint64 trigger = uint64(block.timestamp) + 2 hours;
        vm.warp(trigger);
        _record(1, Classification.Cause.SMART_CONTRACT_EXPLOIT, 600, trigger);
        treasury.settle(1, tokenId);
        // Second settle → policy no longer Active → markClaimable reverts.
        vm.expectRevert(abi.encodeWithSelector(SentinelPolicy.NotActive.selector, tokenId));
        treasury.settle(1, tokenId);
    }

    function test_settle_ineligible_policy_reverts() public {
        // Policy bought AFTER trigger → not eligible.
        uint64 trigger = uint64(block.timestamp);
        vm.warp(trigger + 1);
        uint256 tokenId = _buy();
        _record(1, Classification.Cause.SMART_CONTRACT_EXPLOIT, 600, trigger);
        vm.expectRevert(abi.encodeWithSelector(SentinelPolicy.NotEligibleAtTrigger.selector, tokenId));
        treasury.settle(1, tokenId);
    }

    // ─────────────────────────── access control ───────────────────────────

    function test_only_oracle_records_verdict() public {
        vm.prank(buyer);
        vm.expectRevert();
        treasury.recordVerdict(
            1, stable, Classification.Cause.SMART_CONTRACT_EXPLOIT, 600, uint64(block.timestamp)
        );
    }

    function test_settle_unknown_verdict_reverts() public {
        uint256 tokenId = _buy();
        vm.expectRevert(abi.encodeWithSelector(SentinelTreasury.UnknownVerdict.selector, 99));
        treasury.settle(99, tokenId);
    }

    function test_duplicate_verdict_reverts() public {
        uint64 trigger = uint64(block.timestamp);
        _record(1, Classification.Cause.SMART_CONTRACT_EXPLOIT, 600, trigger);
        vm.prank(oracle);
        vm.expectRevert(abi.encodeWithSelector(SentinelTreasury.VerdictExists.selector, 1));
        treasury.recordVerdict(1, stable, Classification.Cause.BANK_RUN, 600, trigger);
    }

    // ─────────────────────────── reserved ≥ paid invariant ───────────────────────────

    function test_paid_never_exceeds_reserved_across_classes() public {
        // Two policies, two events, different classes.
        uint256 t1 = _buy();
        asset.mint(buyer, 1_000_000e18);
        uint256 t2 = _buy();

        uint64 trigger = uint64(block.timestamp) + 2 hours;
        vm.warp(trigger);
        _record(1, Classification.Cause.SMART_CONTRACT_EXPLOIT, 600, trigger);
        _record(2, Classification.Cause.BANK_RUN, 1_000, trigger);

        treasury.settle(1, t1); // immediate
        treasury.settle(2, t2); // vested
        vm.warp(trigger + treasury.VESTED_24H_DELAY());
        treasury.claimVested(2, t2);

        assertLe(treasury.paidPerEvent(1), treasury.reservedPerEvent(1));
        assertLe(treasury.paidPerEvent(2), treasury.reservedPerEvent(2));
    }
}
