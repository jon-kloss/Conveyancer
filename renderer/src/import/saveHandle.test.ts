import { describe, it, expect } from "vitest";
import { relTime, driftConflictCount } from "./saveHandle";

describe("driftConflictCount (Option B gate)", () => {
  it("is zero when no item carries a conflict → auto-apply", () => {
    expect(driftConflictCount([{}, { conflict: undefined }, {}])).toBe(0);
  });
  it("counts only the conflicting items → any >0 means review", () => {
    expect(driftConflictCount([{ conflict: { mine: "a", theirs: "b" } }, {}, { conflict: {} }])).toBe(2);
  });
  it("handles an empty drift", () => {
    expect(driftConflictCount([])).toBe(0);
  });
});

describe("relTime", () => {
  const now = 1_000_000_000_000;
  it("reads recent syncs as 'just now'", () => {
    expect(relTime(now, now)).toBe("just now");
    expect(relTime(now - 44_000, now)).toBe("just now");
  });
  it("rolls up to minutes, hours, and days", () => {
    expect(relTime(now - 3 * 60_000, now)).toBe("3m ago");
    expect(relTime(now - 2 * 3_600_000, now)).toBe("2h ago");
    expect(relTime(now - 26 * 3_600_000, now)).toBe("yesterday");
    expect(relTime(now - 5 * 86_400_000, now)).toBe("5d ago");
  });
  it("never renders a negative age from clock skew", () => {
    expect(relTime(now + 10_000, now)).toBe("just now");
  });
});
