// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {MockPriceOracle} from "../src/mocks/MockPriceOracle.sol";

contract MockPriceOracleTest is Test {
    MockPriceOracle internal oracle;
    address internal owner = address(0xABCD);
    address internal asset = address(0xDEAD);
    address internal stranger = address(0xBEEF);

    function setUp() public {
        oracle = new MockPriceOracle(owner);
    }

    function test_owner_can_set_price() public {
        vm.prank(owner);
        oracle.setPrice(asset, 0.998e18);
        assertEq(oracle.priceOf(asset), 0.998e18);
    }

    function test_setPrice_emits_PriceUpdated() public {
        vm.prank(owner);
        vm.expectEmit(true, false, false, false, address(oracle));
        emit MockPriceOracle.PriceUpdated(asset, 0.998e18, 0);
        oracle.setPrice(asset, 0.998e18);
    }

    function test_stranger_cannot_set_price() public {
        vm.prank(stranger);
        vm.expectRevert(MockPriceOracle.NotOwner.selector);
        oracle.setPrice(asset, 1e18);
    }

    function test_setPrices_batch() public {
        address[] memory assets = new address[](2);
        assets[0] = address(0x1111);
        assets[1] = address(0x2222);
        uint256[] memory prices = new uint256[](2);
        prices[0] = 0.997e18;
        prices[1] = 0.999e18;

        vm.prank(owner);
        oracle.setPrices(assets, prices);

        assertEq(oracle.priceOf(assets[0]), 0.997e18);
        assertEq(oracle.priceOf(assets[1]), 0.999e18);
    }

    function test_transferOwnership() public {
        vm.prank(owner);
        oracle.transferOwnership(stranger);
        assertEq(oracle.owner(), stranger);
    }
}
