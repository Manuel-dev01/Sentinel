import { describe, it, expect } from "vitest";
import { STAGE, EVENT_STATE, CAUSE, RESPONSE_STATUS, POLICY_STATUS } from "./contracts";

/**
 * These arrays mirror Solidity enums by INDEX — order is contract-significant. A drift here
 * silently mislabels the audit screen / pipeline stepper. Lock the exact ordering.
 */
describe("enum mirrors (order matches Solidity)", () => {
  it("SentinelOracle.Stage — Investigate2 sits between Investigate and Classify", () => {
    expect([...STAGE]).toEqual(["None", "Confirm", "Investigate", "Investigate2", "Classify"]);
    expect(STAGE[3]).toBe("Investigate2");
    expect(STAGE[4]).toBe("Classify");
  });

  it("SentinelOracle.EventState", () => {
    expect([...EVENT_STATE]).toEqual([
      "None",
      "Confirming",
      "Investigating",
      "Classifying",
      "Classified",
      "Dismissed",
      "Failed",
    ]);
  });

  it("Classification.Cause — UNKNOWN is 0, exploit is 1", () => {
    expect(CAUSE[0]).toBe("UNKNOWN");
    expect(CAUSE[1]).toBe("SMART_CONTRACT_EXPLOIT");
    expect([...CAUSE]).toEqual([
      "UNKNOWN",
      "SMART_CONTRACT_EXPLOIT",
      "BANK_RUN",
      "REGULATORY",
      "TECHNICAL_GLITCH",
    ]);
  });

  it("IAgentPlatform.ResponseStatus — Success is 2", () => {
    expect([...RESPONSE_STATUS]).toEqual(["None", "Pending", "Success", "Failed", "TimedOut"]);
    expect(RESPONSE_STATUS[2]).toBe("Success");
  });

  it("SentinelPolicy.Status", () => {
    expect([...POLICY_STATUS]).toEqual(["None", "Active", "Claimable", "Claimed", "Expired"]);
  });
});
