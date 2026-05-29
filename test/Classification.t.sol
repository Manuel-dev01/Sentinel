// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";
import { Classification } from "../src/libraries/Classification.sol";

contract ClassificationTest is Test {
    function test_parse_round_trips_every_token() public pure {
        for (uint8 i = 0; i <= 4; i++) {
            Classification.Cause c = Classification.Cause(i);
            string memory token = Classification.tokenFor(c);
            assertTrue(Classification.parse(token) == c, "round-trip");
        }
    }

    function test_parse_unknown_token_is_UNKNOWN() public pure {
        assertTrue(Classification.parse("EXPLOIT") == Classification.Cause.UNKNOWN);
        assertTrue(
            Classification.parse("smart_contract_exploit") == Classification.Cause.UNKNOWN, "case-sensitive"
        );
        assertTrue(
            Classification.parse(" SMART_CONTRACT_EXPLOIT") == Classification.Cause.UNKNOWN, "whitespace"
        );
        assertTrue(Classification.parse("") == Classification.Cause.UNKNOWN, "empty");
    }

    function test_parse_exact_tokens() public pure {
        assertTrue(
            Classification.parse("SMART_CONTRACT_EXPLOIT") == Classification.Cause.SMART_CONTRACT_EXPLOIT
        );
        assertTrue(Classification.parse("BANK_RUN") == Classification.Cause.BANK_RUN);
        assertTrue(Classification.parse("REGULATORY") == Classification.Cause.REGULATORY);
        assertTrue(Classification.parse("TECHNICAL_GLITCH") == Classification.Cause.TECHNICAL_GLITCH);
        assertTrue(Classification.parse("UNKNOWN") == Classification.Cause.UNKNOWN);
    }

    function test_allowedValues_has_all_five_and_matches_tokens() public pure {
        string[] memory vals = Classification.allowedValues();
        assertEq(vals.length, 5);
        // every allowed value parses to a valid non-default cause (except the literal UNKNOWN)
        assertTrue(Classification.parse(vals[0]) == Classification.Cause.SMART_CONTRACT_EXPLOIT);
        assertTrue(Classification.parse(vals[1]) == Classification.Cause.BANK_RUN);
        assertTrue(Classification.parse(vals[2]) == Classification.Cause.REGULATORY);
        assertTrue(Classification.parse(vals[3]) == Classification.Cause.TECHNICAL_GLITCH);
        assertTrue(Classification.parse(vals[4]) == Classification.Cause.UNKNOWN);
    }

    function test_enum_ordering_is_stable() public pure {
        // UNKNOWN must stay 0 — it's the fail-safe default for uninitialized storage.
        assertEq(uint8(Classification.Cause.UNKNOWN), 0);
    }
}
