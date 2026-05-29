// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockStable
/// @notice Test stablecoin for the demo/test environment. Freely mintable so we can seed LPs,
///         policyholders, and the pool deterministically. Not for production.
contract MockStable is ERC20 {
    uint8 private immutable _decimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    /// @notice Mint `amount` to `to`. Open by design — this is a mock.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @notice Burn `amount` from caller.
    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
    }
}
