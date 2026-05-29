// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";
import { StdInvariant } from "forge-std/StdInvariant.sol";
import { SentinelPool } from "../src/SentinelPool.sol";
import { MockStable } from "../src/mocks/MockStable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Drives random sequences of pool operations through the documented roles, bounding inputs
///         so each call is individually valid. The invariants below must hold after ANY sequence.
contract PoolHandler is Test {
    SentinelPool public pool;
    MockStable public asset;
    address public policy;
    address public treasury;

    address[] internal lps;

    constructor(SentinelPool pool_, MockStable asset_, address policy_, address treasury_) {
        pool = pool_;
        asset = asset_;
        policy = policy_;
        treasury = treasury_;
        lps.push(makeAddr("lp1"));
        lps.push(makeAddr("lp2"));
        lps.push(makeAddr("lp3"));
        for (uint256 i; i < lps.length; i++) {
            asset.mint(lps[i], 1e30);
            vm.prank(lps[i]);
            asset.approve(address(pool), type(uint256).max);
        }
        asset.mint(policy, 1e30);
        vm.prank(policy);
        asset.approve(address(pool), type(uint256).max);
    }

    function _lp(uint256 seed) internal view returns (address) {
        return lps[seed % lps.length];
    }

    function deposit(uint256 seed, uint256 amt) external {
        amt = bound(amt, 1e9, 1e24);
        address lp = _lp(seed);
        vm.prank(lp);
        pool.deposit(amt, lp);
    }

    function redeem(uint256 seed, uint256 shareFraction) external {
        address lp = _lp(seed);
        uint256 bal = pool.sharesOf(lp);
        if (bal == 0) return;
        uint256 shares = bound(shareFraction, 1, bal);
        // Cap to what's currently withdrawable so the call is valid.
        uint256 maxAssets = pool.availableCapital();
        if (pool.convertToAssets(shares) > maxAssets) {
            shares = pool.convertToShares(maxAssets);
        }
        if (shares == 0) return;
        vm.prank(lp);
        pool.redeem(shares, lp);
    }

    function accruePremium(uint256 amt) external {
        amt = bound(amt, 1e6, 1e24);
        vm.prank(policy);
        pool.accruePremium(amt);
    }

    function reserve(uint256 amt) external {
        uint256 avail = pool.availableCapital();
        if (avail == 0) return;
        amt = bound(amt, 1, avail);
        vm.prank(treasury);
        pool.reserveForEvent(amt);
    }

    function payOut(uint256 amt) external {
        uint256 reserved = pool.reservedCapital();
        if (reserved == 0) return;
        amt = bound(amt, 1, reserved);
        vm.prank(treasury);
        pool.payOut(address(0xCA11), amt);
    }

    function increaseLiability(uint256 amt) external {
        uint256 room = pool.maxNewLiability();
        if (room == 0) return;
        amt = bound(amt, 1, room);
        vm.prank(policy);
        pool.increaseLiability(amt);
    }
}

contract SentinelPoolInvariantTest is StdInvariant, Test {
    SentinelPool internal pool;
    MockStable internal asset;
    PoolHandler internal handler;

    function setUp() public {
        address operator = makeAddr("operator");
        address policy = makeAddr("policy");
        address treasury = makeAddr("treasury");
        asset = new MockStable("USD Coin", "USDC", 18);
        pool = new SentinelPool(IERC20(address(asset)), operator, 8_000);

        vm.startPrank(operator);
        pool.grantRole(pool.POLICY_ROLE(), policy);
        pool.grantRole(pool.TREASURY_ROLE(), treasury);
        vm.stopPrank();

        handler = new PoolHandler(pool, asset, policy, treasury);
        // Grant the handler's internal pranking the roles it needs by re-pointing roles at it?
        // No — the handler pranks as policy/treasury directly, which already hold the roles.
        targetContract(address(handler));
    }

    /// Reserved capital can never exceed total assets (you can't lock more than you hold).
    function invariant_reserved_le_total() public view {
        assertLe(pool.reservedCapital(), pool.totalAssets());
    }

    /// The pool's real token balance always backs its internal accounting (no phantom assets).
    function invariant_balance_backs_accounting() public view {
        assertGe(asset.balanceOf(address(pool)), pool.totalAssets());
    }

    /// Accounting identity: every asset is either freely available or reserved, exactly.
    /// This holds after ANY sequence and is the load-bearing solvency property.
    function invariant_capital_accounting_identity() public view {
        assertEq(pool.availableCapital() + pool.reservedCapital(), pool.totalAssets());
    }

    /// NOTE — why there is no "outstandingLiability ≤ totalAssets × cap" invariant:
    /// The utilization cap is ADMISSION CONTROL enforced at policy-sale time (`increaseLiability`
    /// reverts if the new liability would breach it — see SentinelPool.t.sol
    /// `test_increaseLiability_enforces_cap`). It is NOT a perpetual invariant: a payout or LP
    /// redemption legitimately shrinks `totalAssets`, which lowers the ceiling and can push the
    /// *ratio* above the cap. That's correct behavior for an insurance pool that has taken a loss —
    /// it simply cannot originate new coverage until capital recovers. Asserting the ratio
    /// continuously would be asserting a property the protocol intentionally does not guarantee.
    /// (Finding from the M2 invariant run; see docs/ARCHITECTURE.md §8.)
}
