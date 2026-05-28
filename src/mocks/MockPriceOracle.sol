// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title MockPriceOracle
/// @notice Owner-controlled price oracle for deterministic demos. Not for production use.
///         Emits PriceUpdated so a Somnia Reactivity subscription can be filtered against it.
contract MockPriceOracle {
    address public owner;

    /// @notice asset => latest price (fixed-point: 1e18 == $1.00)
    mapping(address asset => uint256 price) public priceOf;

    event PriceUpdated(address indexed asset, uint256 price, uint64 timestamp);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error NotOwner();
    error ZeroAddress();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address initialOwner) {
        if (initialOwner == address(0)) revert ZeroAddress();
        owner = initialOwner;
        emit OwnershipTransferred(address(0), initialOwner);
    }

    function setPrice(address asset, uint256 price) external onlyOwner {
        priceOf[asset] = price;
        emit PriceUpdated(asset, price, uint64(block.timestamp));
    }

    function setPrices(address[] calldata assets, uint256[] calldata prices) external onlyOwner {
        uint256 len = assets.length;
        require(len == prices.length, "length mismatch");
        for (uint256 i; i < len; ++i) {
            priceOf[assets[i]] = prices[i];
            emit PriceUpdated(assets[i], prices[i], uint64(block.timestamp));
        }
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }
}
