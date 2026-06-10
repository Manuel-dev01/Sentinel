// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice The owner-gated controls of `PriceFeedPoller` that this gateway needs to forward.
interface IPriceFeedPoller {
    function operatorSetPrice(address asset, uint256 price) external;
    function arm() external returns (uint256 id);
    function disarm() external;
    function setPollInterval(uint32 seconds_) external;
    function withdraw(address to, uint256 amount) external;
    function returnPriceOracleOwnership(address to) external;
    function transferOwnership(address newOwner) external;
}

/// @title  SimGateway
/// @notice Public, griefing-bounded depeg simulator for the Sentinel demo.
/// @dev    The poller's price-write (`operatorSetPrice`) is `onlyOwner`, which means only the operator
///         can trigger a simulated depeg. That blocks a judge from testing the product self-serve. This
///         gateway becomes the poller's owner and re-exposes that one capability to ANYONE, but only for
///         a curated allow-list of demo stables — so the four real-price live assets can never be moved
///         here and the autonomous monitor cannot be corrupted. The poller keeps owning the price oracle,
///         so its autonomous polling is untouched. All other owner-only poller admin is forwarded to the
///         operator (this gateway's owner), and `pollerTransferOwnership` lets the operator reclaim full
///         control at any time.
contract SimGateway is Ownable {
    IPriceFeedPoller public immutable poller;

    /// @notice Assets a depeg may be simulated on (the demo stables). Live assets stay false.
    mapping(address asset => bool) public simulatable;

    event Simulated(address indexed caller, address indexed asset, uint256 price);
    event SimulatableSet(address indexed asset, bool ok);

    error NotSimulatable(address asset);

    constructor(address poller_, address operator_) Ownable(operator_) {
        poller = IPriceFeedPoller(poller_);
    }

    /// @notice PERMISSIONLESS. Push `asset` to `price` (e.g. 0.92e18 to depeg, 1e18 to reset). Restricted
    ///         to allow-listed demo stables. The caller pays only gas; the Oracle funds the agent pipeline
    ///         the resulting `PriceUpdated` triggers.
    function simulate(address asset, uint256 price) external {
        if (!simulatable[asset]) revert NotSimulatable(asset);
        poller.operatorSetPrice(asset, price);
        emit Simulated(msg.sender, asset, price);
    }

    // ─────────────────────────────── operator config ───────────────────────────────

    /// @notice Allow or disallow public simulation of `asset`. Operator-only.
    function setSimulatable(address asset, bool ok) external onlyOwner {
        simulatable[asset] = ok;
        emit SimulatableSet(asset, ok);
    }

    function setSimulatableBatch(address[] calldata assets, bool ok) external onlyOwner {
        for (uint256 i; i < assets.length; ++i) {
            simulatable[assets[i]] = ok;
            emit SimulatableSet(assets[i], ok);
        }
    }

    // ──────────────────── forwarded poller admin (operator keeps control) ────────────────────

    function pollerArm() external onlyOwner returns (uint256) {
        return poller.arm();
    }

    function pollerDisarm() external onlyOwner {
        poller.disarm();
    }

    function pollerSetPollInterval(uint32 seconds_) external onlyOwner {
        poller.setPollInterval(seconds_);
    }

    function pollerWithdraw(address to, uint256 amount) external onlyOwner {
        poller.withdraw(to, amount);
    }

    function pollerReturnPriceOracleOwnership(address to) external onlyOwner {
        poller.returnPriceOracleOwnership(to);
    }

    /// @notice Hand the poller's ownership back to the operator (or elsewhere), e.g. to call `setFeeds`.
    function pollerTransferOwnership(address newOwner) external onlyOwner {
        poller.transferOwnership(newOwner);
    }
}
