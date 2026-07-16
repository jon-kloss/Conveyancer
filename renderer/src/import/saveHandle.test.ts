import { describe, it, expect } from "vitest";
import { relTime } from "./saveHandle";

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
