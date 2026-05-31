// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IAgentPlatform, IAgentCallback, IJsonApiAgent } from "../interfaces/IAgentPlatform.sol";

/// @title SpikeJsonApi
/// @notice Minimal Phase-0 / Step-3 spike. Fires one JSON API agent request, stores the
///         consensus response, emits a receipt-per-validator. NO business logic.
///         If this compiles and the testnet round-trip lands, we've de-risked the platform.
contract SpikeJsonApi is IAgentCallback {
    /// @notice Verified ID for the Somnia JSON API Request agent (per dev blog / docs).
    uint256 public constant JSON_API_AGENT_ID = 13174292974160097713;

    /// @notice Default per-validator price for JSON API at subcommittee size 3.
    uint256 public constant PRICE_PER_AGENT_HINT = 0.03 ether;

    IAgentPlatform public immutable platform;
    address public immutable owner;

    uint256 public lastRequestId;
    string public lastUrl;

    mapping(uint256 requestId => IAgentPlatform.Response[] responses) private _responsesByRequest;
    mapping(uint256 requestId => IAgentPlatform.ResponseStatus status) public statusByRequest;
    mapping(uint256 requestId => bool seen) public callbackSeen;

    event Dispatched(uint256 indexed requestId, string url, bytes payload);
    event JsonApiReceipt(
        uint256 indexed requestId,
        address indexed validator,
        bytes result,
        IAgentPlatform.ResponseStatus status,
        uint256 executionCost,
        uint256 receipt
    );
    event Finalized(uint256 indexed requestId, IAgentPlatform.ResponseStatus status, uint256 responseCount);
    event UnknownCallback(uint256 indexed requestId);

    error NotOwner();
    error NotPlatform();
    error InsufficientValue();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address platform_) {
        platform = IAgentPlatform(platform_);
        owner = msg.sender;
    }

    /// @notice Fire a JSON API request against `url`, extracting `selector` from the response.
    /// @param  url       Public HTTP URL returning JSON the agent can fetch.
    /// @param  selector  Dot-path into the JSON response, e.g. "price" or "bitcoin.usd".
    ///                   NO leading "$." — the agent uses bare dot-paths.
    /// @dev    The payload is CALLDATA for the agent: a 4-byte method selector + ABI args.
    ///         We call fetchString(url, selector). A bare abi.encode(...) has no selector and
    ///         the agent rejects it with "unknown function selector 0x00000000" (the bug the
    ///         first spike run hit). Sender must forward
    ///         platform.getRequestDeposit() + perAgentBudget × subcommitteeSize.
    function fire(string calldata url, string calldata selector)
        external
        payable
        onlyOwner
        returns (uint256 requestId)
    {
        if (msg.value == 0) revert InsufficientValue();

        bytes memory payload = abi.encodeWithSelector(IJsonApiAgent.fetchString.selector, url, selector);

        requestId = platform.createRequest{ value: msg.value }(
            JSON_API_AGENT_ID, address(this), this.handleResponse.selector, payload
        );

        lastRequestId = requestId;
        lastUrl = url;
        emit Dispatched(requestId, url, payload);
    }

    /// @notice Like `fire`, but via `createAdvancedRequest` with an explicit subcommittee size +
    ///         threshold + Threshold consensus. Used by the 3/3-consensus gating spike to measure how
    ///         many validators Somnia testnet actually returns when we request a full committee.
    function fireAdvanced(
        string calldata url,
        string calldata selector,
        uint256 subcommitteeSize,
        uint256 threshold,
        uint256 timeout
    ) external payable onlyOwner returns (uint256 requestId) {
        if (msg.value == 0) revert InsufficientValue();

        bytes memory payload = abi.encodeWithSelector(IJsonApiAgent.fetchString.selector, url, selector);

        requestId = platform.createAdvancedRequest{ value: msg.value }(
            JSON_API_AGENT_ID,
            address(this),
            this.handleResponse.selector,
            payload,
            subcommitteeSize,
            threshold,
            IAgentPlatform.ConsensusType.Threshold,
            timeout
        );

        lastRequestId = requestId;
        lastUrl = url;
        emit Dispatched(requestId, url, payload);
    }

    /// @inheritdoc IAgentCallback
    function handleResponse(
        uint256 requestId,
        IAgentPlatform.Response[] memory responses,
        IAgentPlatform.ResponseStatus status,
        IAgentPlatform.Request memory /* details */
    ) external override {
        if (msg.sender != address(platform)) revert NotPlatform();

        // Idempotency — ignore replays of an already-seen callback.
        if (callbackSeen[requestId]) {
            emit UnknownCallback(requestId);
            return;
        }
        callbackSeen[requestId] = true;

        statusByRequest[requestId] = status;
        IAgentPlatform.Response[] storage stored = _responsesByRequest[requestId];

        // Defensive copy + per-response receipt event.
        for (uint256 i; i < responses.length; ++i) {
            stored.push(responses[i]);
            emit JsonApiReceipt(
                requestId,
                responses[i].validator,
                responses[i].result,
                responses[i].status,
                responses[i].executionCost,
                responses[i].receipt
            );
        }

        emit Finalized(requestId, status, responses.length);
    }

    /// @notice Read back the stored responses for a given requestId.
    function responsesFor(uint256 requestId) external view returns (IAgentPlatform.Response[] memory) {
        return _responsesByRequest[requestId];
    }

    /// @notice Accept the unused-deposit rebate from the platform.
    receive() external payable { }
}
