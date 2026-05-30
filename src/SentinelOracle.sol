// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { SomniaEventHandler } from "@somnia-chain/reactivity-contracts/contracts/SomniaEventHandler.sol";
import {
    SomniaExtensions
} from "@somnia-chain/reactivity-contracts/contracts/interfaces/SomniaExtensions.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { Pausable } from "@openzeppelin/contracts/utils/Pausable.sol";
import { Strings } from "@openzeppelin/contracts/utils/Strings.sol";
import {
    IAgentPlatform,
    IAgentCallback,
    IJsonApiAgent,
    ILlmInferenceAgent,
    IParseWebsiteAgent
} from "./interfaces/IAgentPlatform.sol";
import { Classification } from "./libraries/Classification.sol";
import { FixedPoint } from "./libraries/FixedPoint.sol";
import { SentinelRegistry } from "./SentinelRegistry.sol";
import { SentinelTreasury } from "./SentinelTreasury.sol";

/// @title SentinelOracle
/// @notice The reactive engine and agent orchestrator — the apex that ties Sentinel together. A
///         Somnia Reactivity subscription on a price oracle's `PriceUpdated` event invokes `_onEvent`
///         on-chain with no off-chain keeper; from there the contract drives the canonical state
///         machine (CLAUDE.md §4):
///
///           MONITORING → DETECTED → CONFIRMING → INVESTIGATING → CLASSIFYING → CLASSIFIED
///                                       │
///                                       └─(basket not corroborated)→ DISMISSED
///
///         Each transition is gated on a consensus-reached agent response:
///           • Agent #1 (JSON API)        — confirm the depeg across an independent price basket.
///           • Agent #2 (LLM Parse Website) — read the issuer site for an incident disclosure.
///           • Agent #3 (LLM Inference)   — classify the cause, constrained to the Classification
///                                          enum tokens (`allowedValues`, chainOfThought=false) so
///                                          the validator subcommittee can agree byte-for-byte.
///         On a finalized classification the Oracle records the verdict with the Treasury
///         (`recordVerdict`); the Treasury then settles each policy individually (no policy loop
///         here). Every validator response is emitted as `AgentReceiptRecorded` — the audit UI's
///         data source.
///
/// @dev    ACCESS CONTROL: this contract uses `Ownable` (the owner is the operator), NOT the
///         project-standard `AccessControl`. Reason: `SomniaEventHandler.supportsInterface` is a
///         non-virtual `external pure override`, which collides irreconcilably with
///         `AccessControl.supportsInterface` under multiple inheritance. The Oracle's only human
///         role is the operator, so a single owner is sufficient and not "onlyOwner sprawl"
///         (CLAUDE.md §13). The two machine callers are gated structurally: the reactivity
///         precompile (the base `onEvent` enforces `msg.sender == precompile`) and the agent
///         platform (`handleResponse` enforces `msg.sender == platform`).
///
///         SAFETY: callbacks are idempotent (the request→context entry is deleted on first handling,
///         so replays/late/duplicate callbacks no-op) and stale-guarded (a response is ignored
///         unless it is the request the event is currently awaiting). `_onEvent` and every dispatch
///         are funding-safe — they never revert the precompile callback; an underfunded or
///         platform-rejected dispatch parks the event in `Failed` for an operator `retry`.
contract SentinelOracle is SomniaEventHandler, IAgentCallback, Ownable, ReentrancyGuard, Pausable {
    using FixedPoint for uint256;

    // ─────────────────────────────── verified platform constants ───────────────────────────────

    /// @notice topic0 for MockPriceOracle.PriceUpdated(address,uint256,uint64) — the detection event.
    bytes32 public constant PRICE_UPDATED_TOPIC = keccak256("PriceUpdated(address,uint256,uint64)");

    /// @notice Default subcommittee size for a basic `createRequest` (CLAUDE.md §8). Finalization is
    ///         by majority — 2 of 3 — so callback logic never hard-requires all three responses.
    uint256 public constant SUBCOMMITTEE_SIZE = 3;

    /// @notice Verified base-agent IDs (CLAUDE.md §8). Configurable via `setAgentIds` if the platform
    ///         re-registers an agent, but these are the spike-proven defaults.
    uint256 public constant DEFAULT_JSON_API_AGENT_ID = 13174292974160097713;
    uint256 public constant DEFAULT_PARSE_WEBSITE_AGENT_ID = 12875401142070969085;
    uint256 public constant DEFAULT_LLM_INFERENCE_AGENT_ID = 12847293847561029384;

    /// @notice Natural-language instruction handed to the Parse Website agent (Agent #2).
    string public constant INVESTIGATE_INSTRUCTION = "Report any exploit, hack, insolvency, bank run, regulatory action, or official incident "
        "statement affecting this stablecoin's peg or reserves. Be concise and factual.";

    /// @notice Optional system prompt for the classifier (Agent #3). Kept minimal; determinism comes
    ///         from `allowedValues` + chainOfThought=false, not from prompt engineering.
    string public constant CLASSIFY_SYSTEM =
        "You are a deterministic incident classifier. Answer with exactly one allowed token.";

    // ─────────────────────────────── wiring ───────────────────────────────

    IAgentPlatform public immutable platform;
    SentinelRegistry public immutable registry;
    SentinelTreasury public immutable treasury;

    /// @notice The price-oracle contract whose `PriceUpdated` events this Oracle subscribes to.
    address public immutable priceOracle;

    uint256 public jsonApiAgentId;
    uint256 public parseWebsiteAgentId;
    uint256 public llmInferenceAgentId;

    /// @notice Per-validator budget (native token) sent for each stage's request, on top of the
    ///         platform deposit floor. Tunable so the median-cost rebate cycle stays funded.
    uint256 public confirmBudget;
    uint256 public investigateBudget;
    uint256 public classifyBudget;

    /// @notice Tunable args for the Parse Website (Agent #2) `ExtractString` call. Operator-settable
    ///         so the live demo can be adjusted without redeploying if the agent rejects a value
    ///         (mirrors `setConfirmFeed`/`setBudgets`). `prompt` defaults to INVESTIGATE_INSTRUCTION.
    /// @param key                 Field name the agent extracts (audit-trail label).
    /// @param description         Field description handed to the LLM.
    /// @param prompt              Natural-language extraction prompt / search term.
    /// @param resolveUrl          false = scrape the issuer URL directly; true = search the domain.
    /// @param numPages            Max pages to fetch (capped at 1 when resolveUrl is false).
    /// @param confidenceThreshold 0–100 min confidence; 0 = always return (demo-deterministic).
    struct InvestigateParams {
        string key;
        string description;
        string prompt;
        bool resolveUrl;
        uint8 numPages;
        uint8 confidenceThreshold;
    }

    InvestigateParams public investigateParams;

    uint256 public subscriptionId;
    bool public subscribed;

    // ─────────────────────────────── state machine ───────────────────────────────

    /// @notice Which agent a given request belongs to.
    enum Stage {
        None,
        Confirm,
        Investigate,
        Classify
    }

    /// @notice Lifecycle of one depeg event (the Oracle owns up to CLASSIFIED; the Treasury settles).
    enum EventState {
        None,
        Confirming, // Agent #1 in flight
        Investigating, // Agent #2 in flight
        Classifying, // Agent #3 in flight
        Classified, // verdict recorded with the Treasury (terminal here)
        Dismissed, // basket did not corroborate — no payout
        Failed // a stage agent failed/timed out — retriable by the operator
    }

    /// @param stable          Covered stablecoin that depegged.
    /// @param detectedPrice   Price from the reactive event that opened the case (WAD).
    /// @param confirmedPrice  Independent basket price from Agent #1 (WAD).
    /// @param deviationBps    Peak deviation used for the payout factor (max of detected/confirmed).
    /// @param triggeredAt     Detection timestamp — drives policy eligibility and vesting clocks.
    /// @param state           Lifecycle state.
    /// @param stage           Stage currently/last in flight (used by `retry`).
    /// @param pendingRequestId The request this event is awaiting (stale-callback guard).
    /// @param cause           Consensus classification (set at finalize).
    /// @param disclosure      Evidence text from Agent #2 (fed to the classifier).
    struct DepegEvent {
        address stable;
        uint256 detectedPrice;
        uint256 confirmedPrice;
        uint256 deviationBps;
        uint64 triggeredAt;
        EventState state;
        Stage stage;
        uint256 pendingRequestId;
        Classification.Cause cause;
        string disclosure;
    }

    /// @notice Routes a platform callback back to the originating event + stage.
    struct AgentContext {
        uint256 eventId;
        Stage stage;
        bool exists;
    }

    mapping(uint256 eventId => DepegEvent) private _events;
    mapping(uint256 requestId => AgentContext) private _contexts;

    /// @notice Per-stable confirmation feed (the independent price basket for Agent #1).
    struct ConfirmFeed {
        string url; // public JSON endpoint the JSON API agent fetches
        string selector; // bare dot-path into the response, e.g. "price"
        uint8 decimals; // scale; use 18 so the returned uint is WAD and comparable to the peg
    }

    mapping(address stable => ConfirmFeed) public confirmFeeds;

    /// @notice The in-flight (non-terminal) event for a stable, if any — dedupes concurrent opens.
    mapping(address stable => uint256 eventId) public liveEventOf;

    /// @notice When the current sustained-deviation breach for a stable began (0 = at peg). Enables
    ///         the §4 "for ≥ minDurationSeconds" requirement across successive price updates.
    mapping(address stable => uint64 since) public breachStartedAt;

    uint256 public nextEventId = 1;

    // ─────────────────────────────── events ───────────────────────────────

    event SubscriptionArmed(uint256 indexed subscriptionId, address indexed priceOracle);
    event SubscriptionDisarmed(uint256 indexed subscriptionId);
    event DepegDetected(
        uint256 indexed eventId,
        address indexed stable,
        uint256 price,
        uint256 deviationBps,
        uint64 triggeredAt
    );
    event DepegConfirmed(uint256 indexed eventId, uint256 basketPrice, uint256 basketDeviationBps);
    event DepegDismissed(uint256 indexed eventId, uint256 basketPrice, uint256 basketDeviationBps);
    event InvestigationCompleted(uint256 indexed eventId, string disclosure);
    event ClassificationFinalized(
        uint256 indexed eventId,
        address indexed stable,
        Classification.Cause cause,
        uint256 deviationBps,
        string token
    );
    event AgentRequested(
        uint256 indexed eventId, uint256 indexed requestId, Stage stage, uint256 agentId, uint256 deposit
    );
    /// @notice One per validator response — the audit UI stitches these into the event timeline.
    event AgentReceiptRecorded(
        uint256 indexed eventId,
        uint256 indexed requestId,
        Stage stage,
        address validator,
        bytes result,
        IAgentPlatform.ResponseStatus status,
        uint256 executionCost,
        uint256 receipt
    );
    event StageFailed(
        uint256 indexed eventId, uint256 indexed requestId, Stage stage, IAgentPlatform.ResponseStatus status
    );
    event StageUnfunded(uint256 indexed eventId, Stage stage, uint256 needed, uint256 balance);
    event StageDispatchFailed(uint256 indexed eventId, Stage stage);
    event UnknownCallback(uint256 indexed requestId);
    event StaleCallback(uint256 indexed requestId, uint256 indexed eventId);
    event ConfirmFeedSet(address indexed stable, string url, string selector, uint8 decimals);
    event AgentIdsSet(uint256 jsonApi, uint256 parseWebsite, uint256 llmInference);
    event BudgetsSet(uint256 confirm, uint256 investigate, uint256 classify);
    event InvestigateParamsSet(
        string key, string prompt, bool resolveUrl, uint8 numPages, uint8 confidenceThreshold
    );
    event Withdrawn(address indexed to, uint256 amount);

    // ─────────────────────────────── errors ───────────────────────────────

    error NotPlatform();
    error AlreadySubscribed();
    error NotSubscribed();
    error ZeroAddress();
    error UnknownEvent(uint256 eventId);
    error NotRetriable(uint256 eventId);
    error ConfirmFeedMissing(address stable);
    error InsufficientBalance(uint256 have, uint256 want);

    constructor(
        IAgentPlatform platform_,
        SentinelRegistry registry_,
        SentinelTreasury treasury_,
        address priceOracle_,
        address operator
    ) Ownable(operator) {
        if (
            address(platform_) == address(0) || address(registry_) == address(0)
                || address(treasury_) == address(0) || priceOracle_ == address(0)
        ) revert ZeroAddress();

        platform = platform_;
        registry = registry_;
        treasury = treasury_;
        priceOracle = priceOracle_;

        jsonApiAgentId = DEFAULT_JSON_API_AGENT_ID;
        parseWebsiteAgentId = DEFAULT_PARSE_WEBSITE_AGENT_ID;
        llmInferenceAgentId = DEFAULT_LLM_INFERENCE_AGENT_ID;

        // Defaults above the per-validator price floors in §8 (0.03 / 0.10 / 0.07 STT) to absorb
        // median-cost variance; the unused remainder is rebated to this contract via receive().
        confirmBudget = 0.05 ether;
        investigateBudget = 0.12 ether;
        classifyBudget = 0.1 ether;

        // Parse Website defaults: scrape the issuer URL directly, one page, no confidence floor so
        // the deterministic mock-issuer page always returns a disclosure for the demo.
        investigateParams = InvestigateParams({
            key: "incident",
            description: "Official incident disclosure affecting the stablecoin's peg or reserves",
            prompt: INVESTIGATE_INSTRUCTION,
            resolveUrl: false,
            numPages: 1,
            confidenceThreshold: 0
        });
    }

    // ─────────────────────────────── subscription (operator) ───────────────────────────────

    /// @notice Arm detection: subscribe to the price oracle's `PriceUpdated` event. This contract is
    ///         the subscription owner and must already hold ≥ 32 ether (the Somnia minimum, held not
    ///         consumed) plus enough native balance to fund agent-request deposits.
    function arm() external onlyOwner returns (uint256 id) {
        if (subscribed) revert AlreadySubscribed();

        SomniaExtensions.SubscriptionFilter memory filter = SomniaExtensions.SubscriptionFilter({
            eventTopics: [PRICE_UPDATED_TOPIC, bytes32(0), bytes32(0), bytes32(0)],
            origin: address(0),
            emitter: priceOracle
        });

        id = SomniaExtensions.subscribe(address(this), filter, SomniaExtensions.defaultSubscriptionOptions());
        subscriptionId = id;
        subscribed = true;
        emit SubscriptionArmed(id, priceOracle);
    }

    /// @notice Cancel the detection subscription (frees the 32-ether hold for `withdraw`).
    function disarm() external onlyOwner {
        if (!subscribed) revert NotSubscribed();
        SomniaExtensions.unsubscribe(subscriptionId);
        subscribed = false;
        emit SubscriptionDisarmed(subscriptionId);
    }

    // ─────────────────────────────── detection (reactivity precompile) ───────────────────────────────

    /// @inheritdoc SomniaEventHandler
    /// @dev Invoked by the reactivity precompile (the base `onEvent` already enforces the caller).
    ///      MUST NOT revert — a revert here would brick the subscription callback. All failure modes
    ///      are turned into early returns + events. The subscription filters only on topic0 + emitter
    ///      (price is non-indexed and unfilterable), so the magnitude/duration gate lives here.
    function _onEvent(
        address,
        /* emitter */
        bytes32[] calldata eventTopics,
        bytes calldata data
    )
        internal
        override
    {
        if (paused()) return;

        // PriceUpdated(address indexed asset, uint256 price, uint64 timestamp)
        address asset = eventTopics.length > 1 ? address(uint160(uint256(eventTopics[1]))) : address(0);
        if (asset == address(0)) return;
        if (!registry.isInsurable(asset)) return;

        (uint256 price,) = abi.decode(data, (uint256, uint64));

        SentinelRegistry.StableConfig memory cfg = registry.getConfig(asset);
        uint256 dev = FixedPoint.deviationBps(price, cfg.pegTarget);

        // Below threshold → the peg is (back) within tolerance; clear any breach timer.
        if (dev < cfg.depegThresholdBps) {
            breachStartedAt[asset] = 0;
            return;
        }

        // Breached. Dedupe: one live event per stable at a time.
        if (liveEventOf[asset] != 0) return;

        // Start (or continue) the sustained-deviation timer; require it to persist ≥ minDuration.
        if (breachStartedAt[asset] == 0) breachStartedAt[asset] = uint64(block.timestamp);
        if (block.timestamp - breachStartedAt[asset] < cfg.minDurationSeconds) return;

        // Open the case → DETECTED, then immediately dispatch Agent #1.
        uint256 eventId = nextEventId++;
        DepegEvent storage e = _events[eventId];
        e.stable = asset;
        e.detectedPrice = price;
        e.deviationBps = dev;
        e.triggeredAt = uint64(block.timestamp);
        e.state = EventState.Confirming;
        e.cause = Classification.Cause.UNKNOWN;
        liveEventOf[asset] = eventId;

        emit DepegDetected(eventId, asset, price, dev, e.triggeredAt);
        _dispatchConfirm(eventId);
    }

    // ─────────────────────────────── agent callback (platform) ───────────────────────────────

    /// @inheritdoc IAgentCallback
    /// @dev Idempotent (context deleted on first handling) and stale-guarded. Handles every
    ///      `ResponseStatus`: non-Success parks the event in `Failed` for operator `retry`.
    function handleResponse(
        uint256 requestId,
        IAgentPlatform.Response[] memory responses,
        IAgentPlatform.ResponseStatus status,
        IAgentPlatform.Request memory /* details */
    ) external override nonReentrant {
        if (msg.sender != address(platform)) revert NotPlatform();

        AgentContext memory ctx = _contexts[requestId];
        // Unknown / duplicate / late callback — no state, no advance, no double-pay.
        if (!ctx.exists) {
            emit UnknownCallback(requestId);
            return;
        }
        delete _contexts[requestId]; // idempotency: a replay now hits the !exists branch above

        DepegEvent storage e = _events[ctx.eventId];
        // Stale guard: only the request the event is currently awaiting may advance it.
        if (e.pendingRequestId != requestId) {
            emit StaleCallback(requestId, ctx.eventId);
            return;
        }
        e.pendingRequestId = 0;

        // Record every validator response for the audit trail, regardless of outcome.
        for (uint256 i; i < responses.length; ++i) {
            emit AgentReceiptRecorded(
                ctx.eventId,
                requestId,
                ctx.stage,
                responses[i].validator,
                responses[i].result,
                responses[i].status,
                responses[i].executionCost,
                responses[i].receipt
            );
        }

        if (status != IAgentPlatform.ResponseStatus.Success) {
            e.state = EventState.Failed;
            emit StageFailed(ctx.eventId, requestId, ctx.stage, status);
            return;
        }

        bytes memory consensus = _consensusResult(responses);
        if (consensus.length == 0) {
            // Overall-Success but no usable agreed payload — treat as a failure rather than decode-revert.
            e.state = EventState.Failed;
            emit StageFailed(ctx.eventId, requestId, ctx.stage, IAgentPlatform.ResponseStatus.Failed);
            return;
        }

        if (ctx.stage == Stage.Confirm) {
            _onConfirm(ctx.eventId, e, consensus);
        } else if (ctx.stage == Stage.Investigate) {
            _onInvestigate(ctx.eventId, e, consensus);
        } else {
            _onClassify(ctx.eventId, e, consensus);
        }
    }

    // ─────────────────────────────── stage handlers ───────────────────────────────

    /// @dev Agent #1 result is a WAD price. Corroborate against the peg; a basket that does not also
    ///      breach the threshold means a single bad oracle → DISMISSED, no payout (CLAUDE.md §4 guard).
    function _onConfirm(uint256 eventId, DepegEvent storage e, bytes memory result) private {
        uint256 basketPrice = abi.decode(result, (uint256));
        e.confirmedPrice = basketPrice;

        SentinelRegistry.StableConfig memory cfg = registry.getConfig(e.stable);
        uint256 basketDev = FixedPoint.deviationBps(basketPrice, cfg.pegTarget);

        if (basketDev < cfg.depegThresholdBps) {
            e.state = EventState.Dismissed;
            _closeLive(e.stable);
            emit DepegDismissed(eventId, basketPrice, basketDev);
            return;
        }

        // Corroborated — price the payout on the larger observed deviation.
        if (basketDev > e.deviationBps) e.deviationBps = basketDev;
        e.state = EventState.Investigating;
        emit DepegConfirmed(eventId, basketPrice, basketDev);
        _dispatchInvestigate(eventId);
    }

    /// @dev Agent #2 result is the issuer disclosure text; store it and dispatch the classifier.
    function _onInvestigate(uint256 eventId, DepegEvent storage e, bytes memory result) private {
        string memory disclosure = abi.decode(result, (string));
        e.disclosure = disclosure;
        e.state = EventState.Classifying;
        emit InvestigationCompleted(eventId, disclosure);
        _dispatchClassify(eventId);
    }

    /// @dev Agent #3 result is a single Classification token. Parse it, finalize, hand to the Treasury.
    function _onClassify(uint256 eventId, DepegEvent storage e, bytes memory result) private {
        string memory token = abi.decode(result, (string));
        Classification.Cause cause = Classification.parse(token); // unrecognized → UNKNOWN (fail-safe)
        e.cause = cause;
        e.state = EventState.Classified;
        _closeLive(e.stable);

        emit ClassificationFinalized(eventId, e.stable, cause, e.deviationBps, token);
        // Treasury holds ORACLE_ROLE; it records the verdict and settles each policy individually.
        treasury.recordVerdict(eventId, e.stable, cause, e.deviationBps, e.triggeredAt);
    }

    // ─────────────────────────────── dispatch ───────────────────────────────

    function _dispatchConfirm(uint256 eventId) private {
        DepegEvent storage e = _events[eventId];
        ConfirmFeed memory feed = confirmFeeds[e.stable];
        if (bytes(feed.url).length == 0) {
            // No basket source configured — can't safely confirm; park for operator attention.
            e.state = EventState.Failed;
            emit StageDispatchFailed(eventId, Stage.Confirm);
            return;
        }
        bytes memory payload =
            abi.encodeWithSelector(IJsonApiAgent.fetchUint.selector, feed.url, feed.selector, feed.decimals);
        _dispatch(eventId, Stage.Confirm, jsonApiAgentId, confirmBudget, payload);
    }

    function _dispatchInvestigate(uint256 eventId) private {
        DepegEvent storage e = _events[eventId];
        SentinelRegistry.StableConfig memory cfg = registry.getConfig(e.stable);
        bytes memory payload = _buildInvestigatePayload(cfg.homepageUrl);
        _dispatch(eventId, Stage.Investigate, parseWebsiteAgentId, investigateBudget, payload);
    }

    function _dispatchClassify(uint256 eventId) private {
        DepegEvent storage e = _events[eventId];
        string memory prompt = _buildClassifyPrompt(e.deviationBps, e.disclosure);
        string[] memory allowed = Classification.allowedValues();
        bytes memory payload = abi.encodeWithSelector(
            ILlmInferenceAgent.inferString.selector, prompt, CLASSIFY_SYSTEM, false, allowed
        );
        _dispatch(eventId, Stage.Classify, llmInferenceAgentId, classifyBudget, payload);
    }

    /// @dev Builds the Agent #2 (Parse Website) calldata: `IParseWebsiteAgent.ExtractString` with the
    ///      operator-set `investigateParams` and an empty `options` array (unconstrained extraction).
    ///      Signature verified 2026-05-30 (see IAgentPlatform.sol). Isolated here so a tweak — or a
    ///      swap to the proven JSON-API disclosure-fetch fallback — stays a one-function change.
    function _buildInvestigatePayload(string memory url) private view returns (bytes memory) {
        string[] memory options = new string[](0); // unconstrained — free-form disclosure text
        InvestigateParams memory p = investigateParams;
        return abi.encodeWithSelector(
            IParseWebsiteAgent.ExtractString.selector,
            p.key,
            p.description,
            options,
            p.prompt,
            url,
            p.resolveUrl,
            p.numPages,
            p.confidenceThreshold
        );
    }

    /// @dev Deterministic classifier prompt from the on-chain evidence. The strict output contract
    ///      is enforced by `allowedValues` at the call site, not by this text.
    function _buildClassifyPrompt(uint256 deviationBps, string memory disclosure)
        private
        pure
        returns (string memory)
    {
        return string.concat(
            "A stablecoin has lost its peg. Observed deviation in basis points: ",
            Strings.toString(deviationBps),
            ". Issuer disclosure: ",
            disclosure,
            ". Classify the single most likely root cause."
        );
    }

    /// @dev Funding-safe dispatch: never reverts the caller. Underfunding or a platform revert parks
    ///      the event in `Failed` (retriable) instead of bricking the reactive callback chain.
    function _dispatch(
        uint256 eventId,
        Stage stage,
        uint256 agentId,
        uint256 perAgentBudget,
        bytes memory payload
    ) private {
        DepegEvent storage e = _events[eventId];
        e.stage = stage;

        uint256 deposit = platform.getRequestDeposit() + (perAgentBudget * SUBCOMMITTEE_SIZE);
        if (address(this).balance < deposit) {
            e.state = EventState.Failed;
            emit StageUnfunded(eventId, stage, deposit, address(this).balance);
            return;
        }

        try platform.createRequest{ value: deposit }(
            agentId, address(this), IAgentCallback.handleResponse.selector, payload
        ) returns (
            uint256 requestId
        ) {
            _contexts[requestId] = AgentContext({ eventId: eventId, stage: stage, exists: true });
            e.pendingRequestId = requestId;
            emit AgentRequested(eventId, requestId, stage, agentId, deposit);
        } catch {
            e.state = EventState.Failed;
            emit StageDispatchFailed(eventId, stage);
        }
    }

    /// @notice Re-dispatch the in-flight stage of a `Failed` event (e.g. after funding or a transient
    ///         platform error). Operator-only. Picks up exactly where the state machine stalled.
    function retry(uint256 eventId) external onlyOwner {
        DepegEvent storage e = _events[eventId];
        if (e.state != EventState.Failed) revert NotRetriable(eventId);

        if (e.stage == Stage.Confirm) {
            e.state = EventState.Confirming;
            _dispatchConfirm(eventId);
        } else if (e.stage == Stage.Investigate) {
            e.state = EventState.Investigating;
            _dispatchInvestigate(eventId);
        } else if (e.stage == Stage.Classify) {
            e.state = EventState.Classifying;
            _dispatchClassify(eventId);
        } else {
            revert NotRetriable(eventId);
        }
    }

    // ─────────────────────────────── consensus ───────────────────────────────

    /// @dev The agreed value among the responses — but only if a STRICT MAJORITY of the subcommittee
    ///      returned it. Returns empty (→ the caller parks the event as Failed) when no value clears
    ///      `floor(SUBCOMMITTEE_SIZE/2) + 1` matching Success responses. This is the on-chain consensus
    ///      gate: even if the platform's overall `status` is Success, we never advance on a plurality
    ///      (e.g. three distinct answers, or a 1-1-1 split). A 2-of-3 majority is enough (CLAUDE.md §8);
    ///      a 2-responder partial that agrees also clears it. O(n²) over ≤3 responses — trivially cheap.
    function _consensusResult(IAgentPlatform.Response[] memory responses)
        private
        pure
        returns (bytes memory agreed)
    {
        uint256 majority = (SUBCOMMITTEE_SIZE / 2) + 1; // 2 of 3
        uint256 bestCount;
        for (uint256 i; i < responses.length; ++i) {
            if (responses[i].status != IAgentPlatform.ResponseStatus.Success) continue;
            uint256 count;
            bytes32 h = keccak256(responses[i].result);
            for (uint256 j; j < responses.length; ++j) {
                if (
                    responses[j].status == IAgentPlatform.ResponseStatus.Success
                        && keccak256(responses[j].result) == h
                ) {
                    ++count;
                }
            }
            if (count > bestCount) {
                bestCount = count;
                agreed = responses[i].result;
            }
        }
        // No strict majority agreed → not consensus.
        if (bestCount < majority) return "";
    }

    function _closeLive(address stable) private {
        liveEventOf[stable] = 0;
        breachStartedAt[stable] = 0;
    }

    // ─────────────────────────────── operator config ───────────────────────────────

    /// @notice Set the independent price-basket feed for a stable (the Agent #1 source). Use 18
    ///         decimals so the agent returns a WAD comparable to the registry peg target.
    function setConfirmFeed(address stable, string calldata url, string calldata selector, uint8 decimals)
        external
        onlyOwner
    {
        confirmFeeds[stable] = ConfirmFeed({ url: url, selector: selector, decimals: decimals });
        emit ConfirmFeedSet(stable, url, selector, decimals);
    }

    function setAgentIds(uint256 jsonApi, uint256 parseWebsite, uint256 llmInference) external onlyOwner {
        jsonApiAgentId = jsonApi;
        parseWebsiteAgentId = parseWebsite;
        llmInferenceAgentId = llmInference;
        emit AgentIdsSet(jsonApi, parseWebsite, llmInference);
    }

    function setBudgets(uint256 confirm, uint256 investigate, uint256 classify) external onlyOwner {
        confirmBudget = confirm;
        investigateBudget = investigate;
        classifyBudget = classify;
        emit BudgetsSet(confirm, investigate, classify);
    }

    /// @notice Tune the Parse Website (Agent #2) `ExtractString` args — lets the live demo be adjusted
    ///         without redeploying if the agent rejects a value. `options` is always sent empty.
    function setInvestigateParams(
        string calldata key,
        string calldata description,
        string calldata prompt,
        bool resolveUrl,
        uint8 numPages,
        uint8 confidenceThreshold
    ) external onlyOwner {
        investigateParams = InvestigateParams({
            key: key,
            description: description,
            prompt: prompt,
            resolveUrl: resolveUrl,
            numPages: numPages,
            confidenceThreshold: confidenceThreshold
        });
        emit InvestigateParamsSet(key, prompt, resolveUrl, numPages, confidenceThreshold);
    }

    /// @notice Reclaim native balance (e.g. after `disarm`). Cannot be used while subscribed in a way
    ///         that would drop below the 32-ether owner minimum — the operator should `disarm` first.
    function withdraw(address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        if (amount > address(this).balance) revert InsufficientBalance(address(this).balance, amount);
        (bool ok,) = to.call{ value: amount }("");
        if (!ok) revert InsufficientBalance(address(this).balance, amount);
        emit Withdrawn(to, amount);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ─────────────────────────────── views ───────────────────────────────

    /// @notice Full event record (incl. disclosure text) for the audit UI.
    function getEvent(uint256 eventId) external view returns (DepegEvent memory) {
        if (_events[eventId].state == EventState.None) revert UnknownEvent(eventId);
        return _events[eventId];
    }

    /// @notice The event + stage a given platform request maps to.
    function contextOf(uint256 requestId) external view returns (AgentContext memory) {
        return _contexts[requestId];
    }

    /// @notice Native value forwarded for one request at a given per-validator budget.
    function requestValue(uint256 perAgentBudget) external view returns (uint256) {
        return platform.getRequestDeposit() + (perAgentBudget * SUBCOMMITTEE_SIZE);
    }

    /// @notice Accept native funding (operator top-ups) and the platform's deposit rebate.
    receive() external payable { }
}
