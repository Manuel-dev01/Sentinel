// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IAgentPlatform, IAgentCallback} from "../interfaces/IAgentPlatform.sol";

/// @title SpikeLlmInference
/// @notice Phase-0 / Step-3 spike for the principal pivot risk in CLAUDE.md §20:
///         does the LLM Inference agent reach validator consensus on a constrained
///         classification prompt? The whole project depends on the answer.
///
///         The configured agent (id 12847293847561029384 as of 2026-05-29) is a
///         string-in-string-out Qwen3-30B inference primitive. Payload is
///         abi.encode(prompt); response decodes to a single string per validator.
contract SpikeLlmInference is IAgentCallback {
    /// @notice User-provided ID for the Somnia Qwen3-30B LLM Inference agent.
    uint256 public constant LLM_INFERENCE_AGENT_ID = 12847293847561029384;

    /// @notice Per-validator price for LLM Inference at subcommittee size 3.
    uint256 public constant PRICE_PER_AGENT_HINT = 0.07 ether;

    IAgentPlatform public immutable platform;
    address public immutable owner;

    uint256 public lastRequestId;
    string public lastPrompt;

    mapping(uint256 requestId => IAgentPlatform.Response[] responses) private _responsesByRequest;
    mapping(uint256 requestId => IAgentPlatform.ResponseStatus status) public statusByRequest;
    mapping(uint256 requestId => bool seen) public callbackSeen;

    event Dispatched(uint256 indexed requestId, string prompt);
    event InferenceReceipt(
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

    /// @notice Fire one LLM Inference request with `prompt`.
    /// @dev    Sender must forward enough native token to cover
    ///         platform.getRequestDeposit() + perAgentBudget × subcommitteeSize.
    function fire(string calldata prompt) external payable onlyOwner returns (uint256 requestId) {
        if (msg.value == 0) revert InsufficientValue();

        bytes memory payload = abi.encode(prompt);

        requestId = platform.createRequest{value: msg.value}(
            LLM_INFERENCE_AGENT_ID,
            address(this),
            this.handleResponse.selector,
            payload
        );

        lastRequestId = requestId;
        lastPrompt = prompt;
        emit Dispatched(requestId, prompt);
    }

    /// @inheritdoc IAgentCallback
    function handleResponse(
        uint256 requestId,
        IAgentPlatform.Response[] memory responses,
        IAgentPlatform.ResponseStatus status,
        IAgentPlatform.Request memory /* details */
    ) external override {
        if (msg.sender != address(platform)) revert NotPlatform();

        if (callbackSeen[requestId]) {
            emit UnknownCallback(requestId);
            return;
        }
        callbackSeen[requestId] = true;

        statusByRequest[requestId] = status;
        IAgentPlatform.Response[] storage stored = _responsesByRequest[requestId];

        for (uint256 i; i < responses.length; ++i) {
            stored.push(responses[i]);
            emit InferenceReceipt(
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

    function responsesFor(uint256 requestId) external view returns (IAgentPlatform.Response[] memory) {
        return _responsesByRequest[requestId];
    }

    /// @notice Accept the unused-deposit rebate from the platform.
    receive() external payable {}
}
