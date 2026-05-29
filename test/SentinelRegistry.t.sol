// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";
import { SentinelRegistry } from "../src/SentinelRegistry.sol";
import { PayoutMath } from "../src/libraries/PayoutMath.sol";
import { IAccessControl } from "@openzeppelin/contracts/access/IAccessControl.sol";

contract SentinelRegistryTest is Test {
    SentinelRegistry internal reg;
    address internal operator;
    address internal stranger = address(0xBEEF);
    address internal stable = address(0x57AB);

    PayoutMath.DeviationTiers internal tiers =
        PayoutMath.DeviationTiers({ noPayoutBps: 200, partialBps: 500, highBps: 1000 });

    function setUp() public {
        operator = makeAddr("operator");
        reg = new SentinelRegistry(operator);
    }

    function _register(address s) internal {
        vm.prank(operator);
        reg.registerStable(
            s,
            1e18,
            50,
            60,
            50,
            tiers,
            "https://issuer.xyz",
            "https://x.com/issuer",
            "https://github.com/issuer"
        );
    }

    // ───────────────────────── happy path ─────────────────────────

    function test_register_then_insurable() public {
        _register(stable);
        assertTrue(reg.isInsurable(stable));
        assertEq(reg.pegTargetOf(stable), 1e18);
        assertEq(reg.stableCount(), 1);
        assertEq(reg.allStables()[0], stable);

        SentinelRegistry.StableConfig memory c = reg.getConfig(stable);
        assertEq(c.annualRateBps, 50);
        assertEq(c.tiers.highBps, 1000);
        assertTrue(c.active);
        assertTrue(c.exists);
    }

    function test_setActive_gates_insurability() public {
        _register(stable);
        vm.prank(operator);
        reg.setActive(stable, false);
        assertFalse(reg.isInsurable(stable), "deactivated not insurable");
        // still registered
        assertTrue(reg.getConfig(stable).exists);

        vm.prank(operator);
        reg.setActive(stable, true);
        assertTrue(reg.isInsurable(stable));
    }

    function test_updateConfig_changes_params_preserves_active() public {
        _register(stable);
        vm.prank(operator);
        reg.updateConfig(stable, 1e18, 75, 120, 80, tiers, "a", "b", "c");
        SentinelRegistry.StableConfig memory c = reg.getConfig(stable);
        assertEq(c.annualRateBps, 80);
        assertEq(c.minDurationSeconds, 120);
        assertTrue(c.active);
    }

    // ───────────────────────── access control ─────────────────────────

    function test_stranger_cannot_register() public {
        bytes32 role = reg.OPERATOR_ROLE();
        bytes memory expectedErr =
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, role);
        vm.prank(stranger);
        vm.expectRevert(expectedErr);
        reg.registerStable(stable, 1e18, 50, 60, 50, tiers, "", "", "");
    }

    function test_stranger_cannot_setActive() public {
        _register(stable);
        vm.prank(stranger);
        vm.expectRevert();
        reg.setActive(stable, false);
    }

    // ───────────────────────── validation / reverts ─────────────────────────

    function test_double_register_reverts() public {
        _register(stable);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(SentinelRegistry.AlreadyRegistered.selector, stable));
        reg.registerStable(stable, 1e18, 50, 60, 50, tiers, "", "", "");
    }

    function test_update_unregistered_reverts() public {
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(SentinelRegistry.NotRegistered.selector, stable));
        reg.updateConfig(stable, 1e18, 50, 60, 50, tiers, "", "", "");
    }

    function test_getConfig_unregistered_reverts() public {
        vm.expectRevert(abi.encodeWithSelector(SentinelRegistry.NotRegistered.selector, stable));
        reg.getConfig(stable);
    }

    function test_zero_peg_rejected() public {
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(SentinelRegistry.InvalidConfig.selector, "peg=0"));
        reg.registerStable(stable, 0, 50, 60, 50, tiers, "", "", "");
    }

    function test_bad_tiers_rejected() public {
        PayoutMath.DeviationTiers memory bad =
            PayoutMath.DeviationTiers({ noPayoutBps: 500, partialBps: 500, highBps: 1000 });
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(SentinelRegistry.InvalidConfig.selector, "tiers"));
        reg.registerStable(stable, 1e18, 50, 60, 50, bad, "", "", "");
    }

    function test_zero_rate_rejected() public {
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(SentinelRegistry.InvalidConfig.selector, "rate"));
        reg.registerStable(stable, 1e18, 50, 60, 0, tiers, "", "", "");
    }

    function test_isInsurable_false_for_unregistered() public view {
        assertFalse(reg.isInsurable(address(0x1234)));
    }
}
