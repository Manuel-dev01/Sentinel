// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IAgentPlatform, IAgentCallback } from "../../src/interfaces/IAgentPlatform.sol";

/// @title MockAgentPlatform
/// @notice Test double for the Somnia Agents platform. Records each `createRequest`, then lets a
///         test drive the callback explicitly via `deliver*` — simulating a 3-validator subcommittee
///         that agrees, disagrees, partially responds, fails, or times out. This exercises the
///         Oracle's consensus + ResponseStatus branches deterministically, with no live testnet.
///
/// @dev    `createRequest` mirrors the real platform: it's `payable`, returns an incrementing
///         requestId, and stores the call so the test can assert on the dispatched payload/agent.
///         `getRequestDeposit` returns a configurable floor. The platform calls back via
///         `IAgentCallback.handleResponse` on the recorded callbackAddress, exactly as production.
contract MockAgentPlatform is IAgentPlatform {
    struct Recorded {
        uint256 agentId;
        address callbackAddress;
        bytes4 callbackSelector;
        bytes payload;
        uint256 value;
        bool delivered;
    }

    uint256 public nextRequestId = 1;
    uint256 public requestDeposit; // configurable floor
    mapping(uint256 requestId => Recorded) public requests;

    event Created(uint256 indexed requestId, uint256 agentId, address callback, uint256 value);

    constructor(uint256 requestDeposit_) {
        requestDeposit = requestDeposit_;
    }

    function setRequestDeposit(uint256 floor) external {
        requestDeposit = floor;
    }

    // ─────────────────────────────── IAgentPlatform ───────────────────────────────

    function createRequest(
        uint256 agentId,
        address callbackAddress,
        bytes4 callbackSelector,
        bytes calldata payload
    ) external payable override returns (uint256 requestId) {
        requestId = nextRequestId++;
        requests[requestId] = Recorded({
            agentId: agentId,
            callbackAddress: callbackAddress,
            callbackSelector: callbackSelector,
            payload: payload,
            value: msg.value,
            delivered: false
        });
        emit Created(requestId, agentId, callbackAddress, msg.value);
    }

    function createAdvancedRequest(
        uint256 agentId,
        address callbackAddress,
        bytes4 callbackSelector,
        bytes calldata payload,
        uint256, /* subcommitteeSize */
        uint256, /* threshold */
        ConsensusType, /* consensusType */
        uint256 /* timeout */
    ) external payable override returns (uint256 requestId) {
        return this.createRequest{ value: msg.value }(agentId, callbackAddress, callbackSelector, payload);
    }

    function getRequestDeposit() external view override returns (uint256) {
        return requestDeposit;
    }

    function getAdvancedRequestDeposit(uint256) external view override returns (uint256) {
        return requestDeposit;
    }

    // ─────────────────────────────── delivery helpers (test-driven) ───────────────────────────────

    /// @notice Deliver a unanimous 3-validator Success with the same `result` bytes from all three.
    function deliverUnanimous(uint256 requestId, bytes memory result) external {
        IAgentPlatform.Response[] memory rs = _three(result, result, result);
        _deliver(requestId, rs, IAgentPlatform.ResponseStatus.Success);
    }

    /// @notice Deliver a 2-of-3 majority Success: two validators return `agreed`, one dissents.
    function deliverMajority(uint256 requestId, bytes memory agreed, bytes memory dissent) external {
        IAgentPlatform.Response[] memory rs = _three(agreed, agreed, dissent);
        _deliver(requestId, rs, IAgentPlatform.ResponseStatus.Success);
    }

    /// @notice Deliver a partial response: only 2 validators respond (both Success, agreeing). Mirrors
    ///         "majority finalizes — 2 of 3 responding is enough" (CLAUDE.md §8).
    function deliverPartial(uint256 requestId, bytes memory agreed) external {
        IAgentPlatform.Response[] memory rs = new IAgentPlatform.Response[](2);
        rs[0] = _r(address(0xA11CE), agreed, IAgentPlatform.ResponseStatus.Success);
        rs[1] = _r(address(0xB0B), agreed, IAgentPlatform.ResponseStatus.Success);
        _deliver(requestId, rs, IAgentPlatform.ResponseStatus.Success);
    }

    /// @notice Deliver an overall-Failed outcome (e.g. all validators failed). Per-response status Failed.
    function deliverFailed(uint256 requestId) external {
        IAgentPlatform.Response[] memory rs = new IAgentPlatform.Response[](3);
        rs[0] = _r(address(0xA11CE), "", IAgentPlatform.ResponseStatus.Failed);
        rs[1] = _r(address(0xB0B), "", IAgentPlatform.ResponseStatus.Failed);
        rs[2] = _r(address(0xC0C0), "", IAgentPlatform.ResponseStatus.Failed);
        _deliver(requestId, rs, IAgentPlatform.ResponseStatus.Failed);
    }

    /// @notice Deliver an overall-TimedOut outcome (no responses).
    function deliverTimedOut(uint256 requestId) external {
        IAgentPlatform.Response[] memory rs = new IAgentPlatform.Response[](0);
        _deliver(requestId, rs, IAgentPlatform.ResponseStatus.TimedOut);
    }

    /// @notice Deliver overall-Success but with NO agreed Success payload (e.g. all three differ, or
    ///         all per-response Failed under a Success umbrella) — tests the "no usable consensus" path.
    function deliverNoConsensus(uint256 requestId, bytes memory a, bytes memory b, bytes memory c) external {
        IAgentPlatform.Response[] memory rs = _three(a, b, c);
        _deliver(requestId, rs, IAgentPlatform.ResponseStatus.Success);
    }

    /// @notice Fully custom delivery for edge cases.
    function deliverCustom(
        uint256 requestId,
        IAgentPlatform.Response[] memory responses,
        IAgentPlatform.ResponseStatus status
    ) external {
        _deliver(requestId, responses, status);
    }

    /// @notice Re-invoke a callback for an already-delivered request (tests idempotency / replay).
    function redeliver(
        uint256 requestId,
        IAgentPlatform.Response[] memory responses,
        IAgentPlatform.ResponseStatus status
    ) external {
        Recorded memory rec = requests[requestId];
        IAgentCallback(rec.callbackAddress)
            .handleResponse(requestId, responses, status, _emptyRequest(requestId));
    }

    // ─────────────────────────────── internals ───────────────────────────────

    function _deliver(
        uint256 requestId,
        IAgentPlatform.Response[] memory responses,
        IAgentPlatform.ResponseStatus status
    ) private {
        Recorded storage rec = requests[requestId];
        rec.delivered = true;
        IAgentCallback(rec.callbackAddress)
            .handleResponse(requestId, responses, status, _emptyRequest(requestId));
    }

    function _three(bytes memory a, bytes memory b, bytes memory c)
        private
        pure
        returns (IAgentPlatform.Response[] memory rs)
    {
        rs = new IAgentPlatform.Response[](3);
        rs[0] = _r(address(0xA11CE), a, IAgentPlatform.ResponseStatus.Success);
        rs[1] = _r(address(0xB0B), b, IAgentPlatform.ResponseStatus.Success);
        rs[2] = _r(address(0xC0C0), c, IAgentPlatform.ResponseStatus.Success);
    }

    function _r(address validator, bytes memory result, IAgentPlatform.ResponseStatus status)
        private
        pure
        returns (IAgentPlatform.Response memory)
    {
        return IAgentPlatform.Response({
            validator: validator,
            result: result,
            status: status,
            receipt: 42,
            timestamp: 1_700_000_000,
            executionCost: 0.03 ether
        });
    }

    function _emptyRequest(uint256 requestId) private pure returns (IAgentPlatform.Request memory r) {
        r.id = requestId;
    }

    receive() external payable { }
}
