import { describe, expect, it } from "vitest";
import { isOurs } from "../src/install.ts";

/**
 * Regression guard: the marker is the repo directory name, and `git clone` produces
 * `Claude-Companion` (capitalized). A case-sensitive match made every ccc entry look
 * foreign, so `ccc uninstall` silently removed nothing.
 */
describe("isOurs", () => {
  it("matches a capitalized clone directory", () => {
    expect(isOurs('node "/home/dev/code/Claude-Companion/packages/hooks/src/turn-signal.mjs"')).toBe(true);
  });

  it("matches a lowercase clone directory", () => {
    expect(isOurs('node "/home/dev/code/claude-companion/packages/hooks/src/turn-signal.mjs"')).toBe(true);
  });

  it("matches a Windows-style path", () => {
    expect(isOurs('node "C:\\Users\\dev\\Claude-Companion\\packages\\statusline\\src\\statusline.mjs"')).toBe(true);
  });

  it("does not claim a foreign statusline", () => {
    expect(isOurs("starship prompt")).toBe(false);
    expect(isOurs("node /home/dev/other-tool/statusline.js")).toBe(false);
  });

  it("does not claim another tool's hook", () => {
    expect(isOurs("some-other-tool hook claude")).toBe(false);
  });
});
