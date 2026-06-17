import { generateHumanCode, normalizeCodeInput, validateSelection } from "../src/lib/core";

describe("core helpers", () => {
  it("normalizes access codes", () => {
    expect(normalizeCodeInput(" a9k2-m7qp ")).toBe("A9K2M7QP");
  });

  it("generates grouped codes", () => {
    const code = generateHumanCode();
    expect(code).toMatch(/^[A-Z2-9]{4}(?:-[A-Z2-9]{4}){2}$/);
  });

  it("validates single choice ballots", () => {
    expect(validateSelection(["a"], ["a", "b"], "single", 1).ok).toBe(true);
    expect(validateSelection(["a", "b"], ["a", "b"], "single", 1).ok).toBe(false);
  });

  it("validates multiple choice limits", () => {
    expect(validateSelection(["a", "b"], ["a", "b", "c"], "multiple", 2).ok).toBe(true);
    expect(validateSelection(["a", "b", "c"], ["a", "b", "c"], "multiple", 2).ok).toBe(false);
  });
});

