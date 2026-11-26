import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import pkg from "../package.json";

/**
 * The published package runs nothing when it is installed. npm publishes `package.json` as it is, scripts included,
 * and runs `preinstall`, `install` and `postinstall` on every machine that installs the package, as that person, before
 * anyone has looked at the new version. Build steps (`build`, `postbuild`, `prepublishOnly`) run only for a maintainer.
 */
describe("the published CLI package (@b3os/workmesh)", () => {
  it("has no preinstall, install or postinstall script", () => {
    const scripts: Record<string, string | undefined> = pkg.scripts;
    for (const name of ["preinstall", "install", "postinstall"]) {
      expect(scripts[name], `packages/cli/package.json has a "${name}" script: it would run on every machine that installs or updates Workmesh`).toBeUndefined();
    }
  });

  it("has no binding.gyp, which npm turns into an install script when it publishes", () => {
    expect(fs.existsSync(fileURLToPath(new URL("../binding.gyp", import.meta.url)))).toBe(false);
  });
});
