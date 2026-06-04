// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { SomniaEventHandler } from "@somnia-chain/reactivity-contracts/contracts/SomniaEventHandler.sol";
import {
    SomniaExtensions
} from "@somnia-chain/reactivity-contracts/contracts/interfaces/SomniaExtensions.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IAgentPlatform, IAgentCallback, IJsonApiAgent } from "./interfaces/IAgentPlatform.sol";

/// @notice Minimal surface of the (operator-owned) MockPriceOracle this poller drives.
interface IPriceOracleWritable {
    function setPrice(address asset, uint256 price) external;
    function transferOwnership(address newOwner) external;
    function owner() external view returns (address);
}

/// @title PriceFeedPoller
/// @notice Autonomous, keeperless **multi-asset** price monitor for the "Sentinel detects depegs"
///         thesis. A single self-rescheduling Somnia Reactivity CRON dispatches a JSON-API agent per
///         configured feed to fetch the REAL price of each monitored stablecoin on-chain, then writes
///         it to the MockPriceOracle for that asset (USDC·live, USDT·live, DAI·live, FRAX·live). The
///         SentinelOracle's detection subscription watches that oracle, so a genuine depeg on ANY
///         monitored asset autonomously fires the full detect→investigate→classify→pay pipeline — no
///         human, no off-chain keeper.
///
/// @dev    One subscription owner covers all assets: the 32-STT owner minimum is paid ONCE (here),
///         not per asset — N separate pollers would lock N×32 STT. Only the per-tick agent fees scale
///         with the number of feeds.
///
///         Integration model (see docs/ARCHITECTURE.md):
///         - This contract OWNS the MockPriceOracle (only the owner may setPrice), so the operator's
///           manual "Simulate depeg" on the *demo* stables routes through `operatorSetPrice`. The
///           monitored (live) assets are written ONLY by the cron, so the autonomous feed never fights
///           a manual simulation.
///         - Must hold ≥ 32 STT (held, not consumed) plus an agent budget. `_onEvent` (the cron tick)
///           and every dispatch are funding-safe: they never revert the precompile callback.
///         - Reversible: `returnPriceOracleOwnership` hands the oracle back; `withdraw` reclaims STT
///           (after `disarm`).
///         - Uses `Ownable` (not AccessControl) to avoid the `supportsInterface` clash with
///           `SomniaEventHandler`.
contract PriceFeedPoller is SomniaEventHandler, IAgentCallback, Ownable {
    /// @notice Verified JSON API Request agent id.
    uint256 public constant DEFAULT_JSON_API_AGENT_ID = 13174292974160097713;

    /// @notice One monitored asset: which token to price, the real JSON endpoint, the dot-path, and
    ///         the decimals to scale the fetched value to WAD.
    struct Feed {
        address asset;
        string url;
        string selector;
        uint8 decimals;
    }

    IAgentPlatform public immutable platform;
    IPriceOracleWritable public immutable priceOracle;

    // ── monitor config (operator-settable) ──
    uint256 public jsonApiAgentId = DEFAULT_JSON_API_AGENT_ID;
    Feed[] private _feeds;
    uint32 public pollIntervalSeconds = 300; // cron cadence
    uint256 public perAgentBudget = 0.05 ether; // per-validator budget for each fetch

    // ── cron + observation state ──
    uint256 public cronSubscriptionId;
    bool public armed;
    uint256 public pollCount;
    mapping(address asset => uint256 price) public lastObservedPrice;
    mapping(address asset => uint64 at) public lastObservedAt;
    // requestId → (feed index + 1); 0 means "not ours / already handled".
    mapping(uint256 requestId => uint256 feedIndexPlus1) private _pending;

    event FeedsConfigured(uint256 count);
    event Armed(uint256 indexed subscriptionId, uint32 intervalSeconds);
    event Disarmed(uint256 indexed subscriptionId);
    event Rescheduled(uint256 indexed subscriptionId, uint256 whenMillis);
    event PollDispatched(uint256 indexed requestId, address indexed asset);
    event PollDispatchFailed(address indexed asset, string reason);
    event PriceObserved(address indexed asset, uint256 price, uint64 timestamp);
    event PollUnusable(uint256 indexed requestId, IAgentPlatform.ResponseStatus status);
    event OperatorPriceSet(address indexed asset, uint256 price);
    event Withdrawn(address indexed to, uint256 amount);

    error NotPlatform();

    constructor(address platform_, address priceOracle_, address operator_) Ownable(operator_) {
        platform = IAgentPlatform(platform_);
        priceOracle = IPriceOracleWritable(priceOracle_);
    }

    // ─────────────────────────────── config ───────────────────────────────

    /// @notice Replace the full set of monitored feeds.
    function setFeeds(Feed[] calldata feeds_) external onlyOwner {
        delete _feeds;
        for (uint256 i; i < feeds_.length; ++i) {
            _feeds.push(feeds_[i]);
        }
        emit FeedsConfigured(feeds_.length);
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

    function feedCount() external view returns (uint256) {
        return _feeds.length;
    }

    function feeds() external view returns (Feed[] memory) {
        return _feeds;
    }

    // ─────────────────────────────── operator passthrough ───────────────────────────────

    /// @notice Operator-gated passthrough so the dashboard's Simulate/Reset still set prices on the
    ///         DEMO stables (this contract owns the MockPriceOracle). The live assets are driven only
    ///         by the cron.
    function operatorSetPrice(address asset, uint256 price) external onlyOwner {
        priceOracle.setPrice(asset, price);
        emit OperatorPriceSet(asset, price);
    }

    /// @notice Hand the price oracle back to `to` (reverses the ownership transfer).
    function returnPriceOracleOwnership(address to) external onlyOwner {
        priceOracle.transferOwnership(to);
    }

    /// @notice Reclaim native balance (disarm first so the 32-STT subscription hold is freed).
    function withdraw(address to, uint256 amount) external onlyOwner {
        (bool ok,) = to.call{ value: amount }("");
        require(ok, "withdraw failed");
        emit Withdrawn(to, amount);
    }

    // ─────────────────────────────── cron (arm / reschedule) ───────────────────────────────

    function arm() external onlyOwner returns (uint256 id) {
        require(!armed, "armed");
        id = _scheduleNext();
        armed = true;
        emit Armed(id, pollIntervalSeconds);
    }

    function disarm() external onlyOwner {
        require(armed, "not armed");
        armed = false;
        SomniaExtensions.unsubscribe(cronSubscriptionId);
        emit Disarmed(cronSubscriptionId);
    }

    function _scheduleNext() private returns (uint256 id) {
        uint256 whenMillis = (block.timestamp + pollIntervalSeconds) * 1000 + 1;
        id = SomniaExtensions.scheduleSubscriptionAtTimestamp(
            address(this), whenMillis, SomniaExtensions.defaultSubscriptionOptions()
        );
        cronSubscriptionId = id;
        emit Rescheduled(id, whenMillis);
    }

    function reschedule() external {
        require(msg.sender == address(this), "self");
        _scheduleNext();
    }

    // ─────────────────────────────── cron tick (precompile callback) ───────────────────────────────

    /// @inheritdoc SomniaEventHandler
    /// @dev Fired by the reactivity precompile each tick. MUST NOT revert. Re-arms the next tick, then
    ///      dispatches one JSON-API fetch per feed. Funding-safe.
    function _onEvent(
        address,
        /* emitter */
        bytes32[] calldata,
        /* topics */
        bytes calldata /* data */
    )
        internal
        override
    {
        if (armed) {
            try this.reschedule() { }
            catch {
                armed = false;
            }
        }

        uint256 perFetch = platform.getRequestDeposit() + (perAgentBudget * 3);
        uint256 n = _feeds.length;
        for (uint256 i; i < n; ++i) {
            Feed storage f = _feeds[i];
            if (f.asset == address(0) || bytes(f.url).length == 0) continue;
            if (address(this).balance < perFetch) {
                emit PollDispatchFailed(f.asset, "insufficient balance");
                break;
            }
            bytes memory payload =
                abi.encodeWithSelector(IJsonApiAgent.fetchUint.selector, f.url, f.selector, f.decimals);
            try platform.createRequest{ value: perFetch }(
                jsonApiAgentId, address(this), IAgentCallback.handleResponse.selector, payload
            ) returns (
                uint256 requestId
            ) {
                _pending[requestId] = i + 1;
                emit PollDispatched(requestId, f.asset);
            } catch {
                emit PollDispatchFailed(f.asset, "createRequest reverted");
            }
        }
    }

    // ─────────────────────────────── agent callback ───────────────────────────────

    /// @inheritdoc IAgentCallback
    function handleResponse(
        uint256 requestId,
        IAgentPlatform.Response[] memory responses,
        IAgentPlatform.ResponseStatus status,
        IAgentPlatform.Request memory /* details */
    ) external override {
        if (msg.sender != address(platform)) revert NotPlatform();
        uint256 idxPlus1 = _pending[requestId];
        if (idxPlus1 == 0) return; // unknown / replayed
        delete _pending[requestId];

        if (status != IAgentPlatform.ResponseStatus.Success) {
            emit PollUnusable(requestId, status);
            return;
        }

        uint256 price;
        bool got;
        for (uint256 i; i < responses.length; ++i) {
            if (
                responses[i].status == IAgentPlatform.ResponseStatus.Success
                    && responses[i].result.length >= 32
            ) {
                price = abi.decode(responses[i].result, (uint256));
                got = true;
                break;
            }
        }
        if (!got || price == 0) {
            emit PollUnusable(requestId, status);
            return;
        }

        address asset = _feeds[idxPlus1 - 1].asset;
        lastObservedPrice[asset] = price;
        lastObservedAt[asset] = uint64(block.timestamp);
        unchecked {
            ++pollCount;
        }
        priceOracle.setPrice(asset, price); // → PriceUpdated → autonomous detection
        emit PriceObserved(asset, price, uint64(block.timestamp));
    }

    /// @notice Accept the unused-deposit rebate from the platform + top-ups.
    receive() external payable { }
}
