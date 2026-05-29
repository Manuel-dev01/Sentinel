// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { SomniaEventHandler } from "@somnia-chain/reactivity-contracts/contracts/SomniaEventHandler.sol";
import {
    SomniaExtensions
} from "@somnia-chain/reactivity-contracts/contracts/interfaces/SomniaExtensions.sol";

/// @title SpikeReactivity
/// @notice Phase-0 / Step-4 / M0 micro-spike: prove the Somnia Reactivity round-trip.
///         A subscription on MockPriceOracle's `PriceUpdated` event invokes `_onEvent`
///         directly (no off-chain keeper). We decode + store the payload to prove it fired.
///
///         The agent platform was already de-risked in Step 3; this de-risks the other
///         Somnia primitive Sentinel depends on. The production SentinelOracle extends the
///         same SomniaEventHandler base and subscribes the same way.
///
///         NOTE: the subscription owner is this contract; it must hold
///         SomniaExtensions.SUBSCRIPTION_OWNER_MINIMUM_BALANCE (32 ether) at subscribe time.
contract SpikeReactivity is SomniaEventHandler {
    /// @notice topic0 for MockPriceOracle.PriceUpdated(address,uint256,uint64).
    bytes32 public constant PRICE_UPDATED_TOPIC = keccak256("PriceUpdated(address,uint256,uint64)");

    address public immutable owner;

    uint256 public subscriptionId;
    bool public subscribed;

    // Last decoded event — proof that _onEvent fired.
    uint256 public eventCount;
    address public lastAsset;
    uint256 public lastPrice;
    uint64 public lastTimestamp;

    event Armed(uint256 indexed subscriptionId, address indexed emitter);
    event PriceObserved(address indexed asset, uint256 price, uint64 timestamp, uint256 count);

    error NotOwner();
    error AlreadySubscribed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    /// @notice Subscribe to PriceUpdated events emitted by `priceOracle`.
    /// @dev    Filters on (emitter == priceOracle, topic0 == PriceUpdated). Asset/price/ts are
    ///         left as wildcards so any asset triggers the handler. Requires this contract to
    ///         already hold ≥ 32 ether (the subscription-owner minimum).
    function arm(address priceOracle) external onlyOwner returns (uint256 id) {
        if (subscribed) revert AlreadySubscribed();

        SomniaExtensions.SubscriptionFilter memory filter = SomniaExtensions.SubscriptionFilter({
            eventTopics: [PRICE_UPDATED_TOPIC, bytes32(0), bytes32(0), bytes32(0)],
            origin: address(0),
            emitter: priceOracle
        });

        id = SomniaExtensions.subscribe(address(this), filter, SomniaExtensions.defaultSubscriptionOptions());

        subscriptionId = id;
        subscribed = true;
        emit Armed(id, priceOracle);
    }

    /// @notice Cancel the subscription (frees the handler; owner can reclaim funds afterward).
    function disarm() external onlyOwner {
        SomniaExtensions.unsubscribe(subscriptionId);
        subscribed = false;
    }

    /// @inheritdoc SomniaEventHandler
    /// @dev Invoked by the reactivity precompile (base contract already gates msg.sender).
    function _onEvent(
        address,
        /* emitter */
        bytes32[] calldata eventTopics,
        bytes calldata data
    )
        internal
        override
    {
        // PriceUpdated(address indexed asset, uint256 price, uint64 timestamp)
        //   topic0 = signature, topic1 = asset (indexed); data = abi.encode(price, timestamp)
        address asset = eventTopics.length > 1 ? address(uint160(uint256(eventTopics[1]))) : address(0);
        (uint256 price, uint64 timestamp) = abi.decode(data, (uint256, uint64));

        lastAsset = asset;
        lastPrice = price;
        lastTimestamp = timestamp;
        unchecked {
            ++eventCount;
        }
        emit PriceObserved(asset, price, timestamp, eventCount);
    }

    /// @notice Accept native-token funding (needs ≥32 STT before `arm`).
    receive() external payable { }
}
