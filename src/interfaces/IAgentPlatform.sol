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
