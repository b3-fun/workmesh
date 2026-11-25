import { describe, expect, it } from "vitest";
import { shellWriteTargets } from "../src/hub/shell-writes";

/** v1 (SPEC §23): files a shell command clearly writes, for lease checks on Bash and Codex shell calls. */

const CWD = "/w/repo";
const HOME = "/home/me";
const t = (cmd: string, cwd: string | undefined = CWD) => shellWriteTargets(cmd, cwd, HOME);

describe("shellWriteTargets", () => {
  it("redirections write their target, dups and /dev don't", () => {
    expect(t("echo hi > out.txt")).toEqual(["/w/repo/out.txt"]);
    expect(t("cat a >> logs/x.log 2>&1")).toEqual(["/w/repo/logs/x.log"]);
    expect(t("npm test 2> err.txt")).toEqual(["/w/repo/err.txt"]);
    expect(t("make &> build.log")).toEqual(["/w/repo/build.log"]);
    expect(t("ls >/dev/null 2>&1")).toEqual([]);
    expect(t("echo x >&2")).toEqual([]);
    expect(t('printf "a > b" > "my file.md"')).toEqual(["/w/repo/my file.md"]);
    expect(t("wc -l < input.txt")).toEqual([]);
  });

  it("file-writing programs: tee, rm, mv, cp, touch, truncate, ln, dd", () => {
    expect(t("echo x | tee -a a.txt b.txt")).toEqual(["/w/repo/a.txt", "/w/repo/b.txt"]);
    expect(t("rm -rf build dist/x.js")).toEqual(["/w/repo/build", "/w/repo/dist/x.js"]);
    expect(t("mv src/a.ts src/b.ts")).toEqual(["/w/repo/src/a.ts", "/w/repo/src/b.ts"]);
    expect(t("cp -r templates/x.ts src/")).toEqual(["/w/repo/src", "/w/repo/src/x.ts"]);
    expect(t("touch README.md")).toEqual(["/w/repo/README.md"]);
    expect(t("truncate -s 0 big.log")).toEqual(["/w/repo/big.log"]);
    expect(t("ln -s ../a link")).toEqual(["/w/repo/link"]);
    expect(t("dd if=/dev/zero of=disk.img bs=1m count=1")).toEqual(["/w/repo/disk.img"]);
  });

  it("in-place editors and git's working-tree writers", () => {
    expect(t("sed -i '' 's/a/b/' src/x.ts")).toEqual(["/w/repo/src/x.ts"]);
    expect(t("sed -i 's/a/b/' src/x.ts src/y.ts")).toEqual(["/w/repo/src/x.ts", "/w/repo/src/y.ts"]);
    expect(t("sed -i.bak -e 's/a/b/' -e 's/c/d/' f.txt")).toEqual(["/w/repo/f.txt"]);
    expect(t("sed 's/a/b/' f.txt")).toEqual([]); // not in place
    expect(t("perl -pi -e 's/a/b/' f.txt")).toEqual(["/w/repo/f.txt"]);
    expect(t("git rm -r --cached old/")).toEqual(["/w/repo/old"]);
    expect(t("git checkout -- src/a.ts")).toEqual(["/w/repo/src/a.ts"]);
    expect(t("git checkout main")).toEqual([]);
    expect(t("git restore src/a.ts")).toEqual(["/w/repo/src/a.ts"]);
    expect(t("git commit -m 'rm x'")).toEqual([]);
  });

  it("follows cd, wrappers, env assignments, and separators", () => {
    expect(t("cd packages/cli && rm dist/index.js")).toEqual(["/w/repo/packages/cli/dist/index.js"]);
    expect(t("cd /other/repo; touch x")).toEqual(["/other/repo/x"]);
    expect(t("FOO=1 sudo -E rm a")).toEqual(["/w/repo/a"]);
    expect(t("true || rm b; echo c > d")).toEqual(["/w/repo/b", "/w/repo/d"]);
    expect(t("rm ~/notes.md")).toEqual(["/home/me/notes.md"]);
    expect(shellWriteTargets("rm a", undefined, HOME)).toEqual([]); // relative without a cwd
  });

  it("reads plainly or not at all: variables, substitutions, heredoc bodies, comments, quoted text", () => {
    expect(t("rm $TARGET")).toEqual([]);
    expect(t("rm $(git ls-files -d)")).toEqual([]);
    expect(t("cat > notes.md <<'EOF'\nrm important.ts\nEOF\necho done")).toEqual(["/w/repo/notes.md"]);
    expect(t("# rm x\necho ok")).toEqual([]);
    expect(t("git commit -m \"touch README > x\"")).toEqual([]);
    expect(t("echo 'rm -rf /'")).toEqual([]);
  });

  it("keeps globs for the caller to match as globs", () => {
    expect(t("rm src/*.ts")).toEqual(["/w/repo/src/*.ts"]);
  });

  it("never throws on odd input", () => {
    for (const odd of ["", "'unterminated", '"also', "$(", "`", "<<", "> ", "rm", "\\", "a | | b", "x".repeat(70_000)]) {
      expect(() => t(odd)).not.toThrow();
    }
  });
});
