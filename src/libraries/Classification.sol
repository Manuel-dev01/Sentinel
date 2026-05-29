// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title Classification
/// @notice The fixed cause taxonomy for a depeg event and strict parsing of the LLM agent's
///         token output back into the enum. This taxonomy is a CONTRACT — do not add or rename
///         cases without an explicit decision (CLAUDE.md §3).
/// @dev    The LLM Inference agent is constrained (via `allowedValues`) to return exactly one of
///         the token strings below; `parse` maps that token to the enum. UNKNOWN is the safe
///         default and the only value `parse` returns for unrecognized input.
library Classification {
    enum Cause {
        UNKNOWN, // 0 — default / no-consensus / unrecognized
        SMART_CONTRACT_EXPLOIT, // 1
        BANK_RUN, // 2
        REGULATORY, // 3
        TECHNICAL_GLITCH // 4
    }

    /// @notice The exact tokens passed to the agent as `allowedValues` and matched here.
    ///         Order is irrelevant to the agent but kept aligned with the enum for readability.
    function tokenFor(Cause cause) internal pure returns (string memory) {
        if (cause == Cause.SMART_CONTRACT_EXPLOIT) return "SMART_CONTRACT_EXPLOIT";
        if (cause == Cause.BANK_RUN) return "BANK_RUN";
        if (cause == Cause.REGULATORY) return "REGULATORY";
        if (cause == Cause.TECHNICAL_GLITCH) return "TECHNICAL_GLITCH";
        return "UNKNOWN";
    }

    /// @notice Parse an agent token string into a Cause. Unrecognized → UNKNOWN (fail-safe).
    /// @dev    Compares keccak hashes; the agent returns a bare token (no quotes/whitespace) when
    ///         constrained by allowedValues + chainOfThought=false, but we hash-compare exactly.
    function parse(string memory token) internal pure returns (Cause) {
        bytes32 h = keccak256(bytes(token));
        if (h == keccak256("SMART_CONTRACT_EXPLOIT")) return Cause.SMART_CONTRACT_EXPLOIT;
        if (h == keccak256("BANK_RUN")) return Cause.BANK_RUN;
        if (h == keccak256("REGULATORY")) return Cause.REGULATORY;
        if (h == keccak256("TECHNICAL_GLITCH")) return Cause.TECHNICAL_GLITCH;
        return Cause.UNKNOWN;
    }

    /// @notice The five tokens as an array, for passing to the agent as `allowedValues`.
    function allowedValues() internal pure returns (string[] memory vals) {
        vals = new string[](5);
        vals[0] = "SMART_CONTRACT_EXPLOIT";
        vals[1] = "BANK_RUN";
        vals[2] = "REGULATORY";
        vals[3] = "TECHNICAL_GLITCH";
        vals[4] = "UNKNOWN";
    }
}
