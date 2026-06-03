// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { SomniaEventHandler } from "@somnia-chain/reactivity-contracts/contracts/SomniaEventHandler.sol";
import { SomniaExtensions } from "@somnia-chain/reactivity-contracts/contracts/interfaces/SomniaExtensions.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IAgentPlatform, IAgentCallback, IJsonApiAgent } from "./interfaces/IAgentPlatform.sol";

/// @notice Minimal surface of the (operator-owned) MockPriceOracle this poller drives.
interface IPriceOracleWritable {
    function setPrice(address asset, uint256 price) external;
    function transferOwnership(address newOwner) external;
    function owner() external view returns (address);
}

/// @title PriceFeedPoller
/// @notice Autonomous, keeperless price monitor for the "Sentinel detects depegs" thesis. A
///         self-rescheduling Somnia Reactivity CRON dispatches a JSON-API agent to fetch a real
///         stablecoin price on-chain, then writes it to the MockPriceOracle for a DEDICATED monitored
///         asset (e.g. "USDC·live"). The SentinelOracle's existing detection subscription watches that
///         oracle, so a genuine depeg on the monitored asset autonomously fires the full
///         detect→investigate→classify→pay pipeline — no human, no off-chain keeper.
///
/// @dev    Integration model (see docs/ARCHITECTURE.md):
///         - This contract OWNS the MockPriceOracle (only the owner may setPrice), so the operator's
///           manual "Simulate depeg" is routed through `operatorSetPrice` (a thin owner-gated
///           passthrough). The monitored asset is written ONLY by the cron, so the autonomous feed
///           never fights a manual simulation on the demo stables.
///         - Like any subscription owner, this contract must hold ≥ 32 STT (held, not consumed) plus a
///           budget for agent-request deposits. `_onEvent` (the cron tick) and the dispatch are
///           funding-safe: they never revert the precompile callback.
///         - Reversible: `returnPriceOracleOwnership` hands the oracle back to the operator.
///         - Uses `Ownable` (not AccessControl) for the same reason as SentinelOracle — to avoid the
///           `supportsInterface` clash with `SomniaEventHandler`.
contract PriceFeedPoller is SomniaEventHandler, IAgentCallback, Ownable {
    /// @notice Verified JSON API Request agent id.
    uint256 public constant DEFAULT_JSON_API_AGENT_ID = 13174292974160097713;

    IAgentPlatform public immutable platform;
    IPriceOracleWritable public immutable priceOracle;

    // ── monitor config (operator-settable) ──
    uint256 public jsonApiAgentId = DEFAULT_JSON_API_AGENT_ID;
    address public monitoredAsset; // the dedicated "USDC·live" asset the cron writes
    string public priceUrl; // real price endpoint (e.g. CoinGecko USDC)
    string public priceSelector; // JSON dot-path, e.g. "usd-coin.usd"
    uint8 public priceDecimals = 18; // scale the fetched value to WAD
    uint32 public pollIntervalSeconds = 120; // cron cadence
    uint256 public perAgentBudget = 0.05 ether; // per-validator budget for the fetch

    // ── cron + observation state ──
    uint256 public cronSubscriptionId;
    bool public armed;
    uint256 public lastObservedPrice;
    uint64 public lastObservedAt;
    uint256 public pollCount;
    mapping(uint256 requestId => bool pending) public pendingRequest;

    event MonitorConfigured(address indexed asset, string url, string selector, uint8 decimals);
    event Armed(uint256 indexed subscriptionId, uint32 intervalSeconds);
    event Disarmed(uint256 indexed subscriptionId);
    event Rescheduled(uint256 indexed subscriptionId, uint256 whenMillis);
    event PollDispatched(uint256 indexed requestId);
    event PollDispatchFailed(string reason);
    event PriceObserved(address indexed asset, uint256 price, uint64 timestamp);
    event PollUnusable(uint256 indexed requestId, IAgentPlatform.ResponseStatus status);
    event OperatorPriceSet(address indexed asset, uint256 price);

    error NotPlatform();

    constructor(address platform_, address priceOracle_, address operator_) Ownable(operator_) {
        platform = IAgentPlatform(platform_);
        priceOracle = IPriceOracleWritable(priceOracle_);
    }

    // ─────────────────────────────── config ───────────────────────────────

    /// @notice Set the monitored asset + the real price source the cron reads.
    function setMonitor(address asset, string calldata url, string calldata selector, uint8 decimals)
        external
        onlyOwner
    {
        monitoredAsset = asset;
        priceUrl = url;
        priceSelector = selector;
        priceDecimals = decimals;
        emit MonitorConfigured(asset, url, selector, decimals);
    }

    function setPollInterval(uint32 seconds_) external onlyOwner {
        pollIntervalSeconds = seconds_;
    }

    function setPerAgentBudget(uint256 wei_) external onlyOwner {
        perAgentBudget = wei_;
    }

    function setAgentId(uint256 id) external onlyOwner {
        jsonApiAgentId = id;
    }

    // ─────────────────────────────── operator passthrough ───────────────────────────────

    /// @notice Operator-gated passthrough so the dashboard's Simulate/Reset still set prices on the
    ///         demo stables (this contract owns the MockPriceOracle). Identical to calling setPrice
    ///         directly, but routed through the owner.
    function operatorSetPrice(address asset, uint256 price) external onlyOwner {
        priceOracle.setPrice(asset, price);
        emit OperatorPriceSet(asset, price);
    }

    /// @notice Hand the price oracle back to `to` (reverses the ownership transfer).
    function returnPriceOracleOwnership(address to) external onlyOwner {
        priceOracle.transferOwnership(to);
    }

    // ─────────────────────────────── cron (arm / reschedule) ───────────────────────────────

    /// @notice Arm the autonomous monitor: schedule the first cron tick. This contract must hold
    ///         ≥ 32 STT at call time (the subscription-owner minimum) plus an agent budget.
    function arm() external onlyOwner returns (uint256 id) {
        require(!armed, "armed");
        id = _scheduleNext();
        armed = true;
        emit Armed(id, pollIntervalSeconds);
    }

    /// @notice Stop the monitor (cancel the pending cron tick).
    function disarm() external onlyOwner {
        require(armed, "not armed");
        armed = false;
        SomniaExtensions.unsubscribe(cronSubscriptionId);
        emit Disarmed(cronSubscriptionId);
    }

    function _scheduleNext() private returns (uint256 id) {
        // Absolute unix timestamp in MILLISECONDS, strictly in the future.
        uint256 whenMillis = (block.timestamp + pollIntervalSeconds) * 1000 + 1;
        id = SomniaExtensions.scheduleSubscriptionAtTimestamp(
            address(this), whenMillis, SomniaExtensions.defaultSubscriptionOptions()
        );
        cronSubscriptionId = id;
        emit Rescheduled(id, whenMillis);
    }

    /// @dev External self-call wrapper so a failed reschedule (e.g. balance dropped below the 32-STT
    ///      minimum) is caught instead of reverting the precompile callback.
    function reschedule() external {
        require(msg.sender == address(this), "self");
        _scheduleNext();
    }

    // ─────────────────────────────── cron tick (precompile callback) ───────────────────────────────

    /// @inheritdoc SomniaEventHandler
    /// @dev Fired by the reactivity precompile at each scheduled tick (base `onEvent` enforces the
    ///      caller). MUST NOT revert. Keeps the cron alive by scheduling the next tick, then dispatches
    ///      the price fetch. Both steps are funding-safe.
    function _onEvent(address, /* emitter */ bytes32[] calldata, /* topics */ bytes calldata /* data */ )
        internal
        override
    {
        // 1) keep the cron alive (re-arm the next tick), tolerating a failure.
        if (armed) {
            try this.reschedule() { }
            catch {
                armed = false; // out of funds / precompile rejected — stop cleanly, operator can re-arm
            }
        }

        // 2) dispatch the real-price fetch.
        if (monitoredAsset == address(0) || bytes(priceUrl).length == 0) return;
        uint256 deposit = platform.getRequestDeposit() + (perAgentBudget * 3);
        if (address(this).balance < deposit) {
            emit PollDispatchFailed("insufficient balance");
            return;
        }
        bytes memory payload =
            abi.encodeWithSelector(IJsonApiAgent.fetchUint.selector, priceUrl, priceSelector, priceDecimals);
        try platform.createRequest{ value: deposit }(
            jsonApiAgentId, address(this), IAgentCallback.handleResponse.selector, payload
        ) returns (uint256 requestId) {
            pendingRequest[requestId] = true;
            emit PollDispatched(requestId);
        } catch {
            emit PollDispatchFailed("createRequest reverted");
        }
    }

    // ─────────────────────────────── agent callback ───────────────────────────────

    /// @inheritdoc IAgentCallback
    /// @dev Writes the observed price to the monitored asset (we own the oracle) → PriceUpdated →
    ///      SentinelOracle detection. Idempotent; never trusts a non-Success response.
    function handleResponse(
        uint256 requestId,
        IAgentPlatform.Response[] memory responses,
        IAgentPlatform.ResponseStatus status,
        IAgentPlatform.Request memory /* details */
    ) external override {
        if (msg.sender != address(platform)) revert NotPlatform();
        if (!pendingRequest[requestId]) return; // unknown / replayed
        delete pendingRequest[requestId];

        if (status != IAgentPlatform.ResponseStatus.Success) {
            emit PollUnusable(requestId, status);
            return;
        }

        // Take the first Success response's decoded price (the monitor is not payout-gating — the
        // SentinelOracle re-confirms at strict 3/3 before any payout).
        uint256 price;
        bool got;
        for (uint256 i; i < responses.length; ++i) {
            if (responses[i].status == IAgentPlatform.ResponseStatus.Success && responses[i].result.length >= 32) {
                price = abi.decode(responses[i].result, (uint256));
                got = true;
                break;
            }
        }
        if (!got || price == 0) {
            emit PollUnusable(requestId, status);
            return;
        }

        lastObservedPrice = price;
        lastObservedAt = uint64(block.timestamp);
        unchecked {
            ++pollCount;
        }
        priceOracle.setPrice(monitoredAsset, price); // → PriceUpdated → autonomous detection
        emit PriceObserved(monitoredAsset, price, uint64(block.timestamp));
    }

    /// @notice Accept the unused-deposit rebate from the platform + top-ups.
    receive() external payable { }
}
