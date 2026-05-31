import { describe, it, expect } from "vitest";
import {
  fmtWad,
  fmtCompact,
  fmtPrice,
  fmtBpsPct,
  shortAddr,
  deviationBps,
  timeAgo,
} from "./format";

const WAD = 1_000_000_000_000_000_000n; // 1e18

describe("fmtWad", () => {
  it("renders an em-dash for undefined", () => expect(fmtWad(undefined)).toBe("—"));
  it("formats 1 WAD with grouping + default 2dp", () => expect(fmtWad(WAD)).toBe("1.00"));
  it("groups thousands", () => expect(fmtWad(1_000_000n * WAD)).toBe("1,000,000.00"));
  it("honours the dp argument", () => expect(fmtWad(WAD / 2n, 4)).toBe("0.5000"));
});

describe("fmtCompact", () => {
  it("compacts a million", () => expect(fmtCompact(1_000_000n * WAD)).toBe("1M"));
  it("em-dash for undefined", () => expect(fmtCompact(undefined)).toBe("—"));
});

describe("fmtPrice", () => {
  it("prefixes $ and uses 4dp peg precision", () => expect(fmtPrice(WAD)).toBe("$1.0000"));
  it("renders a depegged price", () => expect(fmtPrice((WAD * 92n) / 100n)).toBe("$0.9200"));
});

describe("fmtBpsPct", () => {
  it("800 bps -> 8.00%", () => expect(fmtBpsPct(800)).toBe("8.00%"));
  it("accepts bigint", () => expect(fmtBpsPct(50n)).toBe("0.50%"));
  it("em-dash for undefined", () => expect(fmtBpsPct(undefined)).toBe("—"));
});

describe("shortAddr", () => {
  it("shortens a 0x address", () =>
    expect(shortAddr("0x1234567890abcdef1234567890abcdef12345678")).toBe("0x1234…5678"));
  it("em-dash for empty", () => expect(shortAddr(undefined)).toBe("—"));
});

describe("deviationBps", () => {
  it("0 when at peg", () => expect(deviationBps(WAD, WAD)).toBe(0));
  it("800 bps for an 8% drop", () => expect(deviationBps((WAD * 92n) / 100n, WAD)).toBe(800));
  it("symmetric above peg", () => expect(deviationBps((WAD * 105n) / 100n, WAD)).toBe(500));
  it("guards divide-by-zero peg", () => expect(deviationBps(WAD, 0n)).toBe(0));
});

describe("timeAgo", () => {
  it("seconds bucket", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(timeAgo(now - 5)).toBe("5s ago");
  });
  it("minutes bucket", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(timeAgo(now - 120)).toBe("2m ago");
  });
  it("future reads as just now", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(timeAgo(now + 100)).toBe("just now");
  });
  it("em-dash for undefined", () => expect(timeAgo(undefined)).toBe("—"));
});
