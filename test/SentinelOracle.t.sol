// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";
import { SentinelOracle } from "../src/SentinelOracle.sol";
import { SentinelTreasury } from "../src/SentinelTreasury.sol";
import { SentinelPool } from "../src/SentinelPool.sol";
import { SentinelPolicy } from "../src/SentinelPolicy.sol";
import { SentinelRegistry } from "../src/SentinelRegistry.sol";
import { MockStable } from "../src/mocks/MockStable.sol";
import { MockAgentPlatform } from "./mocks/MockAgentPlatform.sol";
import { Classification } from "../src/libraries/Classification.sol";
import { PayoutMath } from "../src/libraries/PayoutMath.sol";
import { IAgentPlatform, IParseWebsiteAgent } from "../src/interfaces/IAgentPlatform.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Integration tests for the SentinelOracle state machine + agent orchestration. The Somnia
///         agent platform is replaced by MockAgentPlatform (a test-driven 3-validator subcommittee);
///         detection is exercised by calling the SomniaEventHandler `onEvent` entrypoint as the
///         reactivity precompile (0x0100), since the precompile isn't deployed in the test EVM.
contract SentinelOracleTest is Test {
    SentinelRegistry internal registry;
    SentinelPool internal pool;
    SentinelPolicy internal policy;
    SentinelTreasury internal treasury;
    SentinelOracle internal oracle;
    MockAgentPlatform internal platform;
    MockStable internal asset;

    address internal operator = makeAddr("operator");
    address internal lp = makeAddr("lp");
    address internal stable = makeAddr("USDx");
    address internal priceOracle = makeAddr("priceOracle");

    address internal constant PRECOMPILE = address(0x0100);
    bytes32 internal constant PRICE_UPDATED_TOPIC = keccak256("PriceUpdated(address,uint256,uint64)");

    uint256 internal constant WAD = 1e18;
    uint16 internal constant THRESHOLD_BPS = 50; // 0.5%
    uint32 internal constant MIN_DURATION = 0;
    uint256 internal constant NOTIONAL = 1_000_000e18;

    PayoutMath.DeviationTiers internal tiers =
        PayoutMath.DeviationTiers({ noPayoutBps: 200, partialBps: 500, highBps: 1000 });

    function setUp() public {
        asset = new MockStable("USD Coin", "USDC", 18);
        platform = new MockAgentPlatform(0.01 ether);
        registry = new SentinelRegistry(operator);
        pool = new SentinelPool(IERC20(address(asset)), operator, 8_000);
        policy = new SentinelPolicy(IERC20(address(asset)), registry, pool, operator, 1 hours);
        treasury = new SentinelTreasury(registry, pool, policy, operator);
        oracle = new SentinelOracle(
            IAgentPlatform(address(platform)), registry, treasury, priceOracle, operator
        );

        vm.startPrank(operator);
        // socialUrl empty → single-source investigate for the default stable (most tests). The
        // two-source path is covered by test_two_source_investigate with a dedicated stable.
        registry.registerStable(
            stable, WAD, THRESHOLD_BPS, MIN_DURATION, 50, tiers, "https://issuer.example", "", "r"
        );
        pool.grantRole(pool.POLICY_ROLE(), address(policy));
        pool.grantRole(pool.TREASURY_ROLE(), address(treasury));
        policy.grantRole(policy.CLAIM_MANAGER_ROLE(), address(treasury));
        treasury.grantRole(treasury.ORACLE_ROLE(), address(oracle));
        oracle.setConfirmFeed(stable, "https://basket.example/price", "price", 18);
        vm.stopPrank();

        // Fund the oracle for agent-request deposits.
        vm.deal(address(oracle), 100 ether);

        // Seed pool + a policy so the verdict has something to settle against (full-flow sanity).
        asset.mint(lp, 10_000_000e18);
        vm.startPrank(lp);
        asset.approve(address(pool), type(uint256).max);
        pool.deposit(10_000_000e18, lp);
        vm.stopPrank();
    }

    // ─────────────────────────────── helpers ───────────────────────────────

    function _emit(address asset_, uint256 price) internal {
        bytes32[] memory topics = new bytes32[](2);
        topics[0] = PRICE_UPDATED_TOPIC;
        topics[1] = bytes32(uint256(uint160(asset_)));
        bytes memory data = abi.encode(price, uint64(block.timestamp));
        vm.prank(PRECOMPILE);
        oracle.onEvent(priceOracle, topics, data);
    }

    /// @dev Drive a full happy path to CLASSIFIED with the given classifier token. Returns eventId.
    function _runToClassified(uint256 detectPrice, uint256 basketPrice, string memory token)
        internal
        returns (uint256 eventId)
    {
        _emit(stable, detectPrice); // -> DETECTED -> Confirm dispatched (req 1)
        eventId = oracle.liveEventOf(stable);

        platform.deliverUnanimous(1, abi.encode(basketPrice)); // confirm -> investigate (req 2)
        platform.deliverUnanimous(2, abi.encode("Vault drained via reentrancy.")); // -> classify (req 3)
        platform.deliverUnanimous(3, abi.encode(token)); // -> CLASSIFIED + verdict
    }

    // ─────────────────────────────── full happy path ───────────────────────────────

    function test_full_flow_exploit_records_verdict() public {
        _emit(stable, 0.98e18); // dev 200 bps >= 50 -> DETECTED
        uint256 eventId = oracle.nextEventId() - 1;
        assertEq(eventId, 1);

        SentinelOracle.DepegEvent memory e = oracle.getEvent(eventId);
        assertEq(uint8(e.state), uint8(SentinelOracle.EventState.Confirming));
        assertEq(e.stable, stable);
        assertEq(e.deviationBps, 200);

        // Confirm: independent basket also off-peg (0.94 -> 600 bps) -> corroborated.
        platform.deliverUnanimous(1, abi.encode(uint256(0.94e18)));
        e = oracle.getEvent(eventId);
        assertEq(uint8(e.state), uint8(SentinelOracle.EventState.Investigating));
        assertEq(e.deviationBps, 600, "payout priced on larger basket deviation");

        // Investigate: disclosure text.
        platform.deliverUnanimous(2, abi.encode("Vault drained via reentrancy exploit."));
        e = oracle.getEvent(eventId);
        assertEq(uint8(e.state), uint8(SentinelOracle.EventState.Classifying));

        // Classify: constrained token -> CLASSIFIED + verdict recorded with Treasury.
        platform.deliverUnanimous(3, abi.encode("SMART_CONTRACT_EXPLOIT"));
        e = oracle.getEvent(eventId);
        assertEq(uint8(e.state), uint8(SentinelOracle.EventState.Classified));
        assertEq(uint8(e.cause), uint8(Classification.Cause.SMART_CONTRACT_EXPLOIT));

        // Verdict landed in the Treasury, keyed by eventId.
        (address vStable, Classification.Cause vCause, uint256 vDev,, bool exists) =
            treasury.verdicts(eventId);
        assertTrue(exists);
        assertEq(vStable, stable);
        assertEq(uint8(vCause), uint8(Classification.Cause.SMART_CONTRACT_EXPLOIT));
        assertEq(vDev, 600);

        // Live-event slot freed.
        assertEq(oracle.liveEventOf(stable), 0);
    }

    function test_full_flow_then_treasury_settles_policy() public {
        // Buy an eligible policy first.
        asset.mint(address(this), 1_000_000e18);
        asset.approve(address(policy), type(uint256).max);
        uint256 tokenId = policy.buy(stable, NOTIONAL, 365 days);
        vm.warp(block.timestamp + 2 hours); // past min-age

        uint256 eventId = _runToClassified(0.98e18, 0.94e18, "SMART_CONTRACT_EXPLOIT");

        // The end-to-end proof: Oracle's verdict -> Treasury settle -> payout to the holder.
        uint256 balBefore = asset.balanceOf(address(this));
        treasury.settle(eventId, tokenId);
        assertEq(asset.balanceOf(address(this)) - balBefore, NOTIONAL, "exploit pays 100% immediately");
    }

    // ─────────────────────────────── dismissal ───────────────────────────────

    function test_confirm_not_corroborated_dismisses() public {
        _emit(stable, 0.98e18);
        uint256 eventId = oracle.nextEventId() - 1;

        // Basket says peg is fine (1.00) -> single-source false positive -> DISMISSED, no payout.
        platform.deliverUnanimous(1, abi.encode(uint256(1e18)));

        SentinelOracle.DepegEvent memory e = oracle.getEvent(eventId);
        assertEq(uint8(e.state), uint8(SentinelOracle.EventState.Dismissed));
        assertEq(oracle.liveEventOf(stable), 0, "dismissal frees the live slot");

        // No verdict recorded.
        (,,,, bool exists) = treasury.verdicts(eventId);
        assertFalse(exists);
    }

    // ─────────────────────────────── ResponseStatus branches ───────────────────────────────

    function test_confirm_failed_parks_event_retriable() public {
        _emit(stable, 0.98e18);
        uint256 eventId = oracle.nextEventId() - 1;

        platform.deliverFailed(1);
        SentinelOracle.DepegEvent memory e = oracle.getEvent(eventId);
        assertEq(uint8(e.state), uint8(SentinelOracle.EventState.Failed));

        // Operator retries the confirm stage; a fresh request is dispatched (req 2).
        vm.prank(operator);
        oracle.retry(eventId);
        e = oracle.getEvent(eventId);
        assertEq(uint8(e.state), uint8(SentinelOracle.EventState.Confirming));

        // And it can now succeed through to classification.
        platform.deliverUnanimous(2, abi.encode(uint256(0.94e18)));
        platform.deliverUnanimous(3, abi.encode("Disclosure."));
        platform.deliverUnanimous(4, abi.encode("BANK_RUN"));
        e = oracle.getEvent(eventId);
        assertEq(uint8(e.state), uint8(SentinelOracle.EventState.Classified));
        assertEq(uint8(e.cause), uint8(Classification.Cause.BANK_RUN));
    }

    function test_timed_out_parks_event() public {
        _emit(stable, 0.98e18);
        uint256 eventId = oracle.nextEventId() - 1;
        platform.deliverTimedOut(1);
        assertEq(uint8(oracle.getEvent(eventId).state), uint8(SentinelOracle.EventState.Failed));
    }

    function test_overall_success_but_no_consensus_parks_event() public {
        _emit(stable, 0.98e18);
        uint256 eventId = oracle.nextEventId() - 1;
        // Three different payloads under a Success umbrella -> no agreed bytes -> Failed (not a revert).
        platform.deliverNoConsensus(1, abi.encode(uint256(1)), abi.encode(uint256(2)), abi.encode(uint256(3)));
        assertEq(uint8(oracle.getEvent(eventId).state), uint8(SentinelOracle.EventState.Failed));
    }

    /// @notice CONFIRM is a payout-gating stage → strict 3/3. A 2-of-3 majority (one dissenter) is NOT
    ///         consensus there → Failed.
    function test_confirm_majority_2of3_fails() public {
        _emit(stable, 0.98e18);
        uint256 eventId = oracle.nextEventId() - 1;
        // Two agree on 0.94, one dissents → not unanimous → no payout path.
        platform.deliverMajority(1, abi.encode(uint256(0.94e18)), abi.encode(uint256(1e18)));
        assertEq(uint8(oracle.getEvent(eventId).state), uint8(SentinelOracle.EventState.Failed));
    }

    /// @notice CONFIRM strict 3/3: only 2 of 3 validators responding is NOT enough → Failed.
    function test_confirm_partial_2_responders_fails() public {
        _emit(stable, 0.98e18);
        uint256 eventId = oracle.nextEventId() - 1;
        platform.deliverPartial(1, abi.encode(uint256(0.94e18)));
        assertEq(uint8(oracle.getEvent(eventId).state), uint8(SentinelOracle.EventState.Failed));
    }

    // ─────────────────────── tiered consensus: investigate = 2-of-3 majority ───────────────────────

    /// @notice INVESTIGATE (Parse-Website evidence) advances on a 2-of-3 majority — two validators agree,
    ///         one dissents. The heavy scraper agent only reliably musters a quorum on testnet, so
    ///         evidence gathering takes a majority (the Classify verdict still takes 3/3). Single-source
    ///         stable → advances straight to Classifying.
    function test_investigate_advances_on_2of3_majority() public {
        _emit(stable, 0.98e18);
        uint256 eventId = oracle.nextEventId() - 1;
        platform.deliverUnanimous(1, abi.encode(uint256(0.94e18))); // confirm 3/3 → investigate (req 2)
        platform.deliverMajority(2, abi.encode("Exploit confirmed."), abi.encode("unrelated"));
        assertEq(uint8(oracle.getEvent(eventId).state), uint8(SentinelOracle.EventState.Classifying));
    }

    /// @notice INVESTIGATE advances when only 2 of 3 validators respond (both agreeing) — the absent 3rd
    ///         is the exact testnet failure this tiering fixes.
    function test_investigate_advances_on_2_responders() public {
        _emit(stable, 0.98e18);
        uint256 eventId = oracle.nextEventId() - 1;
        platform.deliverUnanimous(1, abi.encode(uint256(0.94e18))); // → investigate (req 2)
        platform.deliverPartial(2, abi.encode("Exploit confirmed."));
        assertEq(uint8(oracle.getEvent(eventId).state), uint8(SentinelOracle.EventState.Classifying));
    }

    /// @notice Majority still demands byte-identical agreement: 3 divergent investigate results (no two
    ///         alike) is below the 2-of-3 quorum → Failed.
    function test_investigate_fails_when_no_two_agree() public {
        _emit(stable, 0.98e18);
        uint256 eventId = oracle.nextEventId() - 1;
        platform.deliverUnanimous(1, abi.encode(uint256(0.94e18))); // → investigate (req 2)
        platform.deliverNoConsensus(2, abi.encode("a"), abi.encode("b"), abi.encode("c"));
        assertEq(uint8(oracle.getEvent(eventId).state), uint8(SentinelOracle.EventState.Failed));
    }

    /// @notice CLASSIFY is the payout-signing verdict → strict 3/3. A 2-of-3 majority on the classifier
    ///         (two say EXPLOIT, one says BANK_RUN) does NOT sign → Failed, even though investigate only
    ///         needed a majority. This is the heart of the thesis: the verdict requires unanimity.
    function test_classify_majority_2of3_fails() public {
        _emit(stable, 0.98e18);
        uint256 eventId = oracle.nextEventId() - 1;
        platform.deliverUnanimous(1, abi.encode(uint256(0.94e18))); // → investigate (req 2)
        platform.deliverUnanimous(2, abi.encode("Exploit confirmed.")); // → classify (req 3, single-source)
        platform.deliverMajority(3, abi.encode("SMART_CONTRACT_EXPLOIT"), abi.encode("BANK_RUN"));
        assertEq(uint8(oracle.getEvent(eventId).state), uint8(SentinelOracle.EventState.Failed));
    }

    // ─────────────────────────────── agent payload signatures ───────────────────────────────

    /// @notice Locks the verified Parse Website signature: the investigate dispatch must encode
    ///         `IParseWebsiteAgent.ExtractString` (capital E — selector-significant). Guards against a
    ///         silent regression to the old guessed `parseString` selector that would fail live.
    function test_investigate_payload_uses_ExtractString_selector() public {
        _emit(stable, 0.98e18); // req 1 = confirm
        platform.deliverUnanimous(1, abi.encode(uint256(0.94e18))); // corroborated → req 2 = investigate

        (,,, bytes memory payload,,) = platform.requests(2);
        bytes4 sel;
        assembly {
            sel := mload(add(payload, 0x20))
        }
        assertEq(sel, IParseWebsiteAgent.ExtractString.selector, "investigate uses ExtractString");
        assertTrue(sel != bytes4(0), "selector must be non-zero");
    }

    // ─────────────────────────────── classification fallback ───────────────────────────────

    function test_unrecognized_token_classifies_unknown() public {
        uint256 eventId = _runToClassified(0.98e18, 0.94e18, "GIBBERISH_NOT_A_TOKEN");
        SentinelOracle.DepegEvent memory e = oracle.getEvent(eventId);
        assertEq(uint8(e.cause), uint8(Classification.Cause.UNKNOWN), "fail-safe to UNKNOWN");
        (,, uint256 vDev,, bool exists) = treasury.verdicts(eventId);
        assertTrue(exists);
        assertEq(vDev, 600);
    }

    // ─────────────────────── on-chain receipts (audit centerpiece data) ───────────────────────

    /// @notice Every validator vote across all three stages is persisted on-chain (the `/audit` screen
    ///         reads these via `getReceipts` — no off-chain indexer). Locks the shape the UI depends on.
    function test_getReceipts_records_every_validator_vote_across_stages() public {
        uint256 eventId = _runToClassified(0.98e18, 0.94e18, "SMART_CONTRACT_EXPLOIT");

        SentinelOracle.Receipt[] memory rs = oracle.getReceipts(eventId);
        // 3 stages × 3 validators (deliverUnanimous sends 3 each).
        assertEq(rs.length, 9, "one receipt per validator per stage");
        assertEq(oracle.receiptCount(eventId), 9);

        // Stage 1: Confirm (JSON API agent), grouped under requestId 1, all Success.
        for (uint256 i; i < 3; ++i) {
            assertEq(uint8(rs[i].stage), uint8(SentinelOracle.Stage.Confirm));
            assertEq(rs[i].agentId, oracle.jsonApiAgentId());
            assertEq(rs[i].requestId, 1);
            assertEq(uint8(rs[i].status), uint8(IAgentPlatform.ResponseStatus.Success));
        }
        // Stage 2: Investigate (Parse Website agent), requestId 2.
        assertEq(uint8(rs[3].stage), uint8(SentinelOracle.Stage.Investigate));
        assertEq(rs[3].agentId, oracle.parseWebsiteAgentId());
        assertEq(rs[3].requestId, 2);
        // Stage 3: Classify (LLM Inference agent), requestId 3; result decodes to the token.
        assertEq(uint8(rs[6].stage), uint8(SentinelOracle.Stage.Classify));
        assertEq(rs[6].agentId, oracle.llmInferenceAgentId());
        assertEq(rs[6].requestId, 3);
        assertEq(abi.decode(rs[6].result, (string)), "SMART_CONTRACT_EXPLOIT");
    }

    /// @notice Failed-stage votes are persisted too — the audit trail shows *why* a stage failed.
    function test_getReceipts_captures_failed_stage_votes() public {
        _emit(stable, 0.98e18);
        uint256 eventId = oracle.nextEventId() - 1;
        platform.deliverFailed(1); // confirm fails (3 validators, status Failed)

        SentinelOracle.Receipt[] memory rs = oracle.getReceipts(eventId);
        assertEq(rs.length, 3, "failed-stage votes are still persisted for the audit trail");
        assertEq(uint8(rs[0].status), uint8(IAgentPlatform.ResponseStatus.Failed));
        assertEq(uint8(rs[0].stage), uint8(SentinelOracle.Stage.Confirm));
    }

    // ─────────────────────── multi-source investigation (2nd agent target) ───────────────────────

    /// @notice With a distinct secondary source (`socialUrl`), the Oracle runs TWO Parse-Website calls
    ///         (Investigate → Investigate2) and merges both disclosures before classifying.
    function test_two_source_investigate() public {
        address two = makeAddr("TWOx");
        vm.startPrank(operator);
        registry.registerStable(
            two,
            WAD,
            THRESHOLD_BPS,
            MIN_DURATION,
            50,
            tiers,
            "https://home.example",
            "https://social.example",
            "r"
        );
        oracle.setConfirmFeed(two, "https://basket.example/price", "price", 18);
        vm.stopPrank();

        _emit(two, 0.98e18); // confirm = req 1
        uint256 eventId = oracle.nextEventId() - 1;

        platform.deliverUnanimous(1, abi.encode(uint256(0.94e18))); // → investigate (req 2)
        assertEq(uint8(oracle.getEvent(eventId).state), uint8(SentinelOracle.EventState.Investigating));

        platform.deliverUnanimous(2, abi.encode("Homepage: exploit confirmed.")); // → investigate2 (req 3)
        SentinelOracle.DepegEvent memory e = oracle.getEvent(eventId);
        assertEq(
            uint8(e.state),
            uint8(SentinelOracle.EventState.Investigating),
            "stays investigating for 2nd source"
        );
        assertEq(e.disclosure, "Homepage: exploit confirmed.");

        platform.deliverUnanimous(3, abi.encode("Social: team confirms reentrancy drain.")); // → classify (req 4)
        e = oracle.getEvent(eventId);
        assertEq(uint8(e.state), uint8(SentinelOracle.EventState.Classifying));
        assertEq(e.disclosure2, "Social: team confirms reentrancy drain.");

        platform.deliverUnanimous(4, abi.encode("SMART_CONTRACT_EXPLOIT")); // → classified
        e = oracle.getEvent(eventId);
        assertEq(uint8(e.state), uint8(SentinelOracle.EventState.Classified));
        assertEq(uint8(e.cause), uint8(Classification.Cause.SMART_CONTRACT_EXPLOIT));

        // 4 requests (confirm + 2 investigates + classify) × 3 validators = 12 receipts.
        SentinelOracle.Receipt[] memory rs = oracle.getReceipts(eventId);
        assertEq(rs.length, 12, "both investigate stages recorded");
        assertEq(uint8(rs[3].stage), uint8(SentinelOracle.Stage.Investigate));
        assertEq(uint8(rs[6].stage), uint8(SentinelOracle.Stage.Investigate2));
        assertEq(uint8(rs[9].stage), uint8(SentinelOracle.Stage.Classify));
    }

    /// @notice Regression for the M-15 investigate stall: an investigate stage where only 2 of 3
    ///         validators respond (byte-identical Success) but the platform reports the request as
    ///         TimedOut must STILL advance, because the investigate stage only requires a 2-of-3
    ///         majority. The callback must re-derive consensus from the votes, not trust the status.
    function test_investigate_advances_on_majority_despite_timedout_status() public {
        address two = makeAddr("MAJx");
        vm.startPrank(operator);
        registry.registerStable(
            two, WAD, THRESHOLD_BPS, MIN_DURATION, 50, tiers, "https://home.example", "https://social.example", "r"
        );
        oracle.setConfirmFeed(two, "https://basket.example/price", "price", 18);
        vm.stopPrank();

        _emit(two, 0.98e18); // confirm = req 1
        uint256 eventId = oracle.nextEventId() - 1;
        platform.deliverUnanimous(1, abi.encode(uint256(0.94e18))); // → investigate (req 2)
        assertEq(uint8(oracle.getEvent(eventId).state), uint8(SentinelOracle.EventState.Investigating));

        // Only 2 validators muster on the homepage scrape, and the platform reports TimedOut. The
        // majority agrees byte-for-byte, so the stage must advance to the 2nd source — not fail.
        platform.deliverMajorityTimedOut(2, abi.encode("Homepage: regulatory enforcement action."));
        SentinelOracle.DepegEvent memory e = oracle.getEvent(eventId);
        assertEq(
            uint8(e.state), uint8(SentinelOracle.EventState.Investigating), "advances to 2nd source on 2/3 majority"
        );
        assertEq(e.disclosure, "Homepage: regulatory enforcement action.");

        // Same again on the 2nd source: 2-of-3 TimedOut majority → proceed to classify.
        platform.deliverMajorityTimedOut(3, abi.encode("Social: regulator confirms enforcement."));
        e = oracle.getEvent(eventId);
        assertEq(uint8(e.state), uint8(SentinelOracle.EventState.Classifying), "advances to classify");
        assertEq(e.disclosure2, "Social: regulator confirms enforcement.");

        // Classify is payout-gating: a 2/3 TimedOut there must NOT settle (needs 3/3).
        platform.deliverMajorityTimedOut(4, abi.encode("REGULATORY"));
        assertEq(
            uint8(oracle.getEvent(eventId).state),
            uint8(SentinelOracle.EventState.Failed),
            "classify still requires 3/3 unanimity"
        );
    }

    // ──────────────────────── callback access control & robustness ────────────────────────

    function test_handleResponse_only_platform() public {
        _emit(stable, 0.98e18);
        IAgentPlatform.Response[] memory rs = new IAgentPlatform.Response[](0);
        vm.expectRevert(SentinelOracle.NotPlatform.selector);
        oracle.handleResponse(1, rs, IAgentPlatform.ResponseStatus.Success, _emptyReq(1));
    }

    function test_unknown_requestId_is_noop() public {
        _emit(stable, 0.98e18); // req 1 pending
        uint256 eventId = oracle.nextEventId() - 1;

        // A callback for a requestId we never dispatched: ignored, no state change.
        IAgentPlatform.Response[] memory rs = new IAgentPlatform.Response[](0);
        vm.prank(address(platform));
        oracle.handleResponse(999, rs, IAgentPlatform.ResponseStatus.Success, _emptyReq(999));

        assertEq(uint8(oracle.getEvent(eventId).state), uint8(SentinelOracle.EventState.Confirming));
    }

    function test_duplicate_callback_is_idempotent() public {
        _emit(stable, 0.98e18);
        uint256 eventId = oracle.nextEventId() - 1;

        platform.deliverUnanimous(1, abi.encode(uint256(0.94e18))); // confirm handled -> investigating
        assertEq(uint8(oracle.getEvent(eventId).state), uint8(SentinelOracle.EventState.Investigating));

        // Replay the SAME confirm callback -- context was deleted, so it's a no-op (no re-advance).
        IAgentPlatform.Response[] memory rs = new IAgentPlatform.Response[](3);
        rs[0] = _succ(abi.encode(uint256(0.94e18)));
        rs[1] = _succ(abi.encode(uint256(0.94e18)));
        rs[2] = _succ(abi.encode(uint256(0.94e18)));
        platform.redeliver(1, rs, IAgentPlatform.ResponseStatus.Success);

        // Still exactly in Investigating -- no second investigate dispatched, no double-advance.
        assertEq(uint8(oracle.getEvent(eventId).state), uint8(SentinelOracle.EventState.Investigating));
    }

    // ─────────────────────────────── detection gating ───────────────────────────────

    function test_not_insurable_is_ignored() public {
        address other = makeAddr("UNREGISTERED");
        _emit(other, 0.5e18);
        assertEq(oracle.nextEventId(), 1, "no event opened for an unregistered stable");
    }

    function test_below_threshold_is_ignored() public {
        _emit(stable, 0.999e18); // 10 bps < 50 bps threshold
        assertEq(oracle.nextEventId(), 1, "no event under threshold");
        assertEq(oracle.breachStartedAt(stable), 0);
    }

    function test_min_duration_must_elapse() public {
        // Register a second stable with a non-zero sustained-deviation requirement.
        address slow = makeAddr("SLOWx");
        vm.prank(operator);
        registry.registerStable(slow, WAD, THRESHOLD_BPS, 1 hours, 50, tiers, "h", "s", "r");

        _emit(slow, 0.98e18); // first breach -- starts the timer, no event yet
        assertEq(oracle.nextEventId(), 1, "no event before min-duration");
        assertGt(oracle.breachStartedAt(slow), 0, "breach timer armed");

        vm.warp(block.timestamp + 1 hours + 1);
        _emit(slow, 0.98e18); // sustained -> opens the case
        assertEq(oracle.nextEventId(), 2, "event opens after min-duration");
    }

    function test_breach_clears_when_price_recovers() public {
        address slow = makeAddr("SLOWy");
        vm.prank(operator);
        registry.registerStable(slow, WAD, THRESHOLD_BPS, 1 hours, 50, tiers, "h", "s", "r");

        _emit(slow, 0.98e18); // arm timer
        assertGt(oracle.breachStartedAt(slow), 0);
        _emit(slow, 1e18); // back to peg -> timer cleared
        assertEq(oracle.breachStartedAt(slow), 0);
    }

    function test_one_live_event_per_stable() public {
        _emit(stable, 0.98e18);
        assertEq(oracle.nextEventId(), 2);
        // A second price update while an event is live does NOT open a duplicate.
        _emit(stable, 0.97e18);
        assertEq(oracle.nextEventId(), 2, "deduped while live");
    }

    function test_new_event_after_previous_settles() public {
        // First event runs to terminal (dismissed) -> live slot frees -> a new one can open.
        _emit(stable, 0.98e18);
        platform.deliverUnanimous(1, abi.encode(uint256(1e18))); // dismissed
        assertEq(oracle.liveEventOf(stable), 0);

        _emit(stable, 0.95e18);
        assertEq(oracle.nextEventId(), 3, "a fresh event opens after the prior closes");
    }

    // ─────────────────────────────── dispatch funding ───────────────────────────────

    function test_unfunded_dispatch_parks_event() public {
        // Drain the oracle so it can't cover the next request deposit.
        vm.prank(operator);
        oracle.withdraw(operator, address(oracle).balance);

        _emit(stable, 0.98e18);
        uint256 eventId = oracle.nextEventId() - 1;
        assertEq(uint8(oracle.getEvent(eventId).state), uint8(SentinelOracle.EventState.Failed));

        // Re-fund and retry succeeds.
        vm.deal(address(oracle), 100 ether);
        vm.prank(operator);
        oracle.retry(eventId);
        assertEq(uint8(oracle.getEvent(eventId).state), uint8(SentinelOracle.EventState.Confirming));
    }

    function test_missing_confirm_feed_parks_event() public {
        address noFeed = makeAddr("NOFEEDx");
        vm.prank(operator);
        registry.registerStable(noFeed, WAD, THRESHOLD_BPS, 0, 50, tiers, "h", "s", "r");
        // No setConfirmFeed for noFeed.
        _emit(noFeed, 0.98e18);
        uint256 eventId = oracle.nextEventId() - 1;
        assertEq(uint8(oracle.getEvent(eventId).state), uint8(SentinelOracle.EventState.Failed));
    }

    // ─────────────────────────────── access control ───────────────────────────────

    function test_only_owner_arms_and_configures() public {
        vm.startPrank(makeAddr("rando"));
        vm.expectRevert();
        oracle.setBudgets(1, 2, 3);
        vm.expectRevert();
        oracle.setConfirmFeed(stable, "u", "s", 18);
        vm.expectRevert();
        oracle.pause();
        vm.stopPrank();
    }

    function test_paused_oracle_ignores_detection() public {
        vm.prank(operator);
        oracle.pause();
        _emit(stable, 0.9e18);
        assertEq(oracle.nextEventId(), 1, "paused: no detection");
    }

    function test_retry_reverts_when_not_failed() public {
        _emit(stable, 0.98e18); // Confirming, not Failed
        uint256 eventId = oracle.nextEventId() - 1;
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(SentinelOracle.NotRetriable.selector, eventId));
        oracle.retry(eventId);
    }

    // ─────────────────────── failed events free the live slot (re-runnable) ───────────────────────

    /// @notice A failed event must release the stable's live slot so a fresh depeg can be detected —
    ///         otherwise a single failure permanently bricks detection for that stable (a later
    ///         `setPrice` would silently no-op on the dedupe guard). Regression test for that bug.
    function test_failed_event_frees_slot_for_new_detection() public {
        _emit(stable, 0.98e18); // event 1 -> Confirming (req 1)
        uint256 first = oracle.nextEventId() - 1;

        platform.deliverFailed(1); // event 1 -> Failed
        assertEq(uint8(oracle.getEvent(first).state), uint8(SentinelOracle.EventState.Failed));
        assertEq(oracle.liveEventOf(stable), 0, "failed event frees the live slot");
        assertEq(oracle.breachStartedAt(stable), 0, "failed event clears the breach timer");

        // A fresh depeg now opens a NEW event instead of silently no-op'ing.
        _emit(stable, 0.95e18);
        uint256 second = oracle.nextEventId() - 1;
        assertEq(second, first + 1, "a new event opens after a failure");
        assertEq(oracle.liveEventOf(stable), second);
    }

    /// @notice `retry` re-acquires the freed slot, but must refuse if a newer event already holds it
    ///         (the one-live-event-per-stable invariant survives the free-on-failure change).
    function test_retry_reverts_when_stable_has_newer_live_event() public {
        _emit(stable, 0.98e18); // event 1
        uint256 first = oracle.nextEventId() - 1;
        platform.deliverFailed(1); // event 1 Failed, slot freed

        _emit(stable, 0.95e18); // event 2 opens, claims the slot
        uint256 second = oracle.nextEventId() - 1;
        assertEq(oracle.liveEventOf(stable), second);

        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(SentinelOracle.StableHasLiveEvent.selector, stable, second));
        oracle.retry(first);
    }

    // ─────────────────────────────── utils ───────────────────────────────

    function _succ(bytes memory result) internal pure returns (IAgentPlatform.Response memory) {
        return IAgentPlatform.Response({
            validator: address(0xABCD),
            result: result,
            status: IAgentPlatform.ResponseStatus.Success,
            receipt: 1,
            timestamp: 1,
            executionCost: 0
        });
    }

    function _emptyReq(uint256 id) internal pure returns (IAgentPlatform.Request memory r) {
        r.id = id;
    }

    /// @dev Lets this test contract receive the policy NFT in the full-flow settlement test.
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }
}
