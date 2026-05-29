// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";
import { SentinelTreasury } from "../src/SentinelTreasury.sol";
import { SentinelPolicy } from "../src/SentinelPolicy.sol";
import { SentinelPool } from "../src/SentinelPool.sol";
import { SentinelRegistry } from "../src/SentinelRegistry.sol";
import { PayoutMath } from "../src/libraries/PayoutMath.sol";
import { Classification } from "../src/libraries/Classification.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice ERC-20 whose transfer re-enters the Treasury. Models a malicious/hookful capital asset —
///         the worst case for a payout path. The nonReentrant guard must stop it.
contract ReentrantToken is ERC20 {
    SentinelTreasury public treasury;
    uint256 public eventId;
    uint256 public tokenId;
    bool public armed;
    bool public reentered;

    constructor() ERC20("Reentrant", "RE") { }

    function arm(SentinelTreasury t, uint256 e, uint256 id) external {
        treasury = t;
        eventId = e;
        tokenId = id;
        armed = true;
    }

    function mint(address to, uint256 amt) external {
        _mint(to, amt);
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        // On the pool→claimant payout, try to re-enter claimVested.
        if (armed && from != address(0) && to != address(0)) {
            armed = false; // single shot
            try treasury.claimVested(eventId, tokenId) {
                reentered = true; // should never reach here
            } catch {
                reentered = false;
            }
        }
    }
}

contract SentinelTreasuryReentrancyTest is Test {
    SentinelRegistry internal registry;
    SentinelPool internal pool;
    SentinelPolicy internal policy;
    SentinelTreasury internal treasury;
    ReentrantToken internal asset;

    address internal operator;
    address internal oracle;
    address internal stable = makeAddr("USDx");
    uint256 internal constant NOTIONAL = 1_000e18;

    PayoutMath.DeviationTiers internal tiers =
        PayoutMath.DeviationTiers({ noPayoutBps: 200, partialBps: 500, highBps: 1000 });

    /// Accept the policy NFT (this test contract is the buyer/holder).
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }

    function setUp() public {
        operator = makeAddr("operator");
        oracle = makeAddr("oracle");
        asset = new ReentrantToken();
        registry = new SentinelRegistry(operator);
        pool = new SentinelPool(IERC20(address(asset)), operator, 8_000);
        policy = new SentinelPolicy(IERC20(address(asset)), registry, pool, operator, 0);
        treasury = new SentinelTreasury(registry, pool, policy, operator);

        vm.startPrank(operator);
        registry.registerStable(stable, 1e18, 50, 60, 50, tiers, "h", "s", "r");
        pool.grantRole(pool.POLICY_ROLE(), address(policy));
        pool.grantRole(pool.TREASURY_ROLE(), address(treasury));
        policy.grantRole(policy.CLAIM_MANAGER_ROLE(), address(treasury));
        treasury.grantRole(treasury.ORACLE_ROLE(), oracle);
        vm.stopPrank();

        // Seed pool + buyer.
        asset.mint(address(this), 1_000_000e18);
        asset.approve(address(pool), type(uint256).max);
        pool.deposit(1_000_000e18, address(this));
        asset.mint(address(this), 1_000_000e18);
        asset.approve(address(policy), type(uint256).max);
    }

    /// A vested claim whose payout token re-enters claimVested must not pay twice.
    function test_reentrancy_on_claimVested_blocked() public {
        uint256 tokenId = policy.buy(stable, NOTIONAL, 365 days);
        uint64 trigger = uint64(block.timestamp) + 1;
        vm.warp(trigger);
        vm.prank(oracle);
        treasury.recordVerdict(1, stable, Classification.Cause.BANK_RUN, 1_000, trigger);
        treasury.settle(1, tokenId);

        vm.warp(trigger + treasury.VESTED_24H_DELAY());
        asset.arm(treasury, 1, tokenId);

        treasury.claimVested(1, tokenId);

        // The re-entrant inner call must have been rejected, and only ONE payout made.
        assertFalse(asset.reentered(), "reentrancy must be caught");
        (,, bool claimed) = treasury.vestings(1, tokenId);
        assertTrue(claimed);
        assertEq(treasury.paidPerEvent(1), NOTIONAL, "paid exactly once");
    }
}
