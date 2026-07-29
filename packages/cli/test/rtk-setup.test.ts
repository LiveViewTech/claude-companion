import { describe, expect, it } from "vitest";
import { expectedDigest, hasUnsafeEntry, rtkAsset, rtkHookEntry, rtkInstallDir } from "../src/rtk-setup.ts";

const DIGEST = "986f29704469b3d1051e2474105c6c75ab8b73651068dcd61612c1fb3938ad95";

describe("expectedDigest", () => {
  it("finds the digest for the requested asset", () => {
    const body = [
      `${"a".repeat(64)}  rtk-aarch64-apple-darwin.tar.gz`,
      `${DIGEST}  rtk-x86_64-unknown-linux-musl.tar.gz`,
    ].join("\n");
    expect(expectedDigest(body, "rtk-x86_64-unknown-linux-musl.tar.gz")).toBe(DIGEST);
  });

  it("does not substring-match a different asset", () => {
    // "rtk-x86_64-unknown-linux-musl.tar.gz" must not satisfy a lookup for the gnu build.
    const body = `${DIGEST}  rtk-x86_64-unknown-linux-musl.tar.gz`;
    expect(expectedDigest(body, "rtk-aarch64-unknown-linux-gnu.tar.gz")).toBeNull();
  });

  it("accepts the binary-mode '*' prefix and uppercase digests", () => {
    const body = `${DIGEST.toUpperCase()} *rtk-x86_64-pc-windows-msvc.zip`;
    expect(expectedDigest(body, "rtk-x86_64-pc-windows-msvc.zip")).toBe(DIGEST);
  });

  it("returns null for an empty or unlisted checksums body", () => {
    expect(expectedDigest("", "rtk-x86_64-unknown-linux-musl.tar.gz")).toBeNull();
    expect(expectedDigest("garbage\n", "rtk-x86_64-unknown-linux-musl.tar.gz")).toBeNull();
  });
});

describe("hasUnsafeEntry", () => {
  it("accepts a plain single-binary archive", () => {
    expect(hasUnsafeEntry(["rtk"])).toBe(false);
    expect(hasUnsafeEntry(["rtk-0.44.1/", "rtk-0.44.1/rtk"])).toBe(false);
  });

  it("rejects absolute unix paths", () => {
    expect(hasUnsafeEntry(["/etc/passwd"])).toBe(true);
  });

  it("rejects windows drive-absolute paths", () => {
    expect(hasUnsafeEntry(["C:\\Windows\\System32\\evil.dll"])).toBe(true);
  });

  it("rejects traversal in any position", () => {
    expect(hasUnsafeEntry(["../outside"])).toBe(true);
    expect(hasUnsafeEntry(["a/../../outside"])).toBe(true);
    expect(hasUnsafeEntry(["a\\..\\outside"])).toBe(true);
    expect(hasUnsafeEntry(["rtk", ".."])).toBe(true);
  });

  it("does not flag dotfiles or names that merely contain dots", () => {
    expect(hasUnsafeEntry([".rtkrc", "a..b", "rtk.exe"])).toBe(false);
  });
});

describe("rtkAsset", () => {
  it("maps each supported platform/arch to a published asset", () => {
    expect(rtkAsset("linux", "x64")).toBe("rtk-x86_64-unknown-linux-musl.tar.gz");
    expect(rtkAsset("linux", "arm64")).toBe("rtk-aarch64-unknown-linux-gnu.tar.gz");
    expect(rtkAsset("darwin", "arm64")).toBe("rtk-aarch64-apple-darwin.tar.gz");
    expect(rtkAsset("darwin", "x64")).toBe("rtk-x86_64-apple-darwin.tar.gz");
  });

  it("always returns the x86_64 zip on windows (no arm64 build is published)", () => {
    expect(rtkAsset("win32", "x64")).toBe("rtk-x86_64-pc-windows-msvc.zip");
    expect(rtkAsset("win32", "arm64")).toBe("rtk-x86_64-pc-windows-msvc.zip");
  });

  it("returns null for unsupported arch/platform rather than guessing", () => {
    expect(rtkAsset("linux", "ia32")).toBeNull();
    expect(rtkAsset("freebsd", "x64")).toBeNull();
  });
});

describe("rtkHookEntry", () => {
  it("emits rtk's canonical shape so `rtk verify` recognizes it", () => {
    expect(rtkHookEntry()).toEqual({
      matcher: "Bash",
      hooks: [{ type: "command", command: "rtk hook claude" }],
    });
  });
});

describe("rtkInstallDir", () => {
  it("honours RTK_INSTALL_DIR", () => {
    expect(rtkInstallDir({ RTK_INSTALL_DIR: "/opt/rtk/bin" })).toBe("/opt/rtk/bin");
  });

  it("defaults under the home directory", () => {
    expect(rtkInstallDir({})).toMatch(/[\\/]\.local[\\/]bin$/);
  });
});
