// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title IAgentPlatform
/// @notice Solidity surface of the Somnia Agents platform.
///         Verified against docs.somnia.network/agents/invoking-agents/from-solidity (2026-05-28).
///         Cached and refined in the project plan; see [[reference_plan_file]].
///         Authoritative testnet address: 0x037Bb9C718F3f7fe5eCBDB0b600D607b52706776
interface IAgentPlatform {
    enum ConsensusType {
        Majority,
        Threshold
    }

    enum ResponseStatus {
        None,
        Pending,
        Success,
        Failed,
        TimedOut
    }

    struct Response {
        address validator;
        bytes result;
        ResponseStatus status;
        uint256 receipt;
        uint256 timestamp;
        uint256 executionCost;
    }

    struct Request {
        uint256 id;
        address requester;
        address callbackAddress;
        bytes4 callbackSelector;
        address[] subcommittee;
        Response[] responses;
        uint256 responseCount;
        uint256 failureCount;
        uint256 threshold;
        uint256 createdAt;
        uint256 deadline;
        ResponseStatus status;
        ConsensusType consensusType;
        uint256 remainingBudget;
        uint256 perAgentBudget;
    }

    /// @notice Create a basic request; uses the platform's default subcommittee size,
    ///         Majority consensus, and default timeout.
    /// @dev    `msg.value` MUST be ≥ getRequestDeposit() + pricePerAgent * subcommitteeSize.
    ///         Sending only the floor sets perAgentBudget = 0 and runners IGNORE the request.
    function createRequest(
        uint256 agentId,
        address callbackAddress,
        bytes4 callbackSelector,
        bytes calldata payload
    ) external payable returns (uint256 requestId);

    /// @notice Advanced request — caller-specified subcommittee size, threshold, consensus, timeout.
    function createAdvancedRequest(
        uint256 agentId,
        address callbackAddress,
        bytes4 callbackSelector,
        bytes calldata payload,
        uint256 subcommitteeSize,
        uint256 threshold,
        ConsensusType consensusType,
        uint256 timeout
    ) external payable returns (uint256 requestId);

    /// @notice Floor deposit required for a basic createRequest.
    function getRequestDeposit() external view returns (uint256);

    /// @notice Floor deposit for an advanced request at a given subcommittee size.
    function getAdvancedRequestDeposit(uint256 subcommitteeSize) external view returns (uint256);
}

/// @notice The platform calls this selector back on the consumer contract once
///         the subcommittee has responded (or timed out / failed).
/// @dev    The consumer MUST require `msg.sender == platform`, MUST be idempotent
///         on repeat invocations for the same requestId, and SHOULD implement
///         `receive() external payable {}` to accept the unused-deposit rebate.
interface IAgentCallback {
    function handleResponse(
        uint256 requestId,
        IAgentPlatform.Response[] memory responses,
        IAgentPlatform.ResponseStatus status,
        IAgentPlatform.Request memory details
    ) external;
}

/// @notice Method surface of the JSON API Request agent (id 13174292974160097713).
/// @dev    The `payload` passed to createRequest is treated as CALLDATA: the first 4 bytes
///         are the agent-method selector, the rest are the ABI-encoded args. Build it with
///         `abi.encodeWithSelector(IJsonApiAgent.fetchString.selector, url, selector)` — NOT
///         a bare `abi.encode(...)` (that has no selector → "unknown function selector 0x00000000").
///         `selector` here is a dot-path into the JSON response, e.g. "price" or "bitcoin.usd"
///         (no leading `$.`). Verified against docs.somnia.network/agents/base-agents/json-api-request
///         and /agents/invoking-agents/from-solidity (2026-05-29 spike).
interface IJsonApiAgent {
    function fetchString(string calldata url, string calldata selector) external returns (string memory);
    function fetchUint(string calldata url, string calldata selector, uint8 decimals)
        external
        returns (uint256);
    function fetchInt(string calldata url, string calldata selector, uint8 decimals) external returns (int256);
    function fetchBool(string calldata url, string calldata selector) external returns (bool);
    function fetchStringArray(string calldata url, string calldata selector)
        external
        returns (string[] memory);
    function fetchUintArray(string calldata url, string calldata selector, uint8 decimals)
        external
        returns (uint256[] memory);
}

/// @notice Method surface of the LLM Inference agent (Qwen3-30B, id 12847293847561029384).
/// @dev    Same calldata-with-selector convention as the JSON API agent.
///         Verified against docs.somnia.network/agents/base-agents/llm-inference (2026-05-29).
///         `inferString` is the classification workhorse: pass `allowedValues` to CONSTRAIN the
///         model to return exactly one of a fixed set (e.g. the Classification enum tokens) — this
///         is what makes subcommittee consensus achievable. Keep `chainOfThought=false` so the
///         output is just the token (no reasoning preamble to diverge on).
///         `system` is an optional system prompt ("" if unused).
interface ILlmInferenceAgent {
    function inferString(
        string calldata prompt,
        string calldata system,
        bool chainOfThought,
        string[] calldata allowedValues
    ) external returns (string memory response);

    /// @dev Numeric variant with clamping — not used by the spike, kept for the Oracle later.
    function inferNumber(
        string calldata prompt,
        string calldata system,
        int256 minValue,
        int256 maxValue,
        bool chainOfThought
    ) external returns (int256 response);
}

/// @notice Method surface of the LLM Parse Website agent (id 12875401142070969085).
/// @dev    Verified 2026-05-30 against docs.somnia.network/agents/base-agents/llm-parse-website
///         (two independent fetches). Same calldata-with-selector convention as the other agents:
///         build with `abi.encodeWithSelector(IParseWebsiteAgent.ExtractString.selector, ...args)`.
///         ⚠ Capitalization is selector-significant — it is `ExtractString` (capital E), NOT
///         `extractString`/`parseString`; the wrong case yields a different 4-byte selector and the
///         agent rejects it with "unknown function selector". Per-validator cost ≈0.10 STT.
///
///         `ExtractString` params:
///           key                 field name to extract (e.g. "incident")
///           description         field description for the LLM
///           options             literal allowed values; pass an EMPTY array to leave unconstrained
///           prompt              natural-language extraction prompt (also used as the search term)
///           url                 base or direct URL
///           resolveUrl          true = search the domain; false = scrape the direct URL
///           numPages            max pages to fetch (capped at 1 when resolveUrl is false)
///           confidenceThreshold 0–100 minimum extraction confidence required to return a result
///         Response decodes to a single string via `abi.decode(result, (string))`.
///         `ExtractANumber` is the numeric-clamped variant (kept for completeness/future use).
interface IParseWebsiteAgent {
    function ExtractString(
        string calldata key,
        string calldata description,
        string[] calldata options,
        string calldata prompt,
        string calldata url,
        bool resolveUrl,
        uint8 numPages,
        uint8 confidenceThreshold
    ) external returns (string memory);

    function ExtractANumber(
        string calldata key,
        string calldata description,
        uint256 min,
        uint256 max,
        string calldata prompt,
        string calldata url,
        bool resolveUrl,
        uint8 numPages,
        uint8 confidenceThreshold
    ) external returns (uint256);
}
