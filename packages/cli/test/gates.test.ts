import { describe, expect, it } from "vitest";
import { matchGates, unwrap } from "../src/daemon/gates";

const HOME = "/Users/dev";
const repoOf = (dir: string): string | undefined =>
  dir.startsWith("/Users/dev/b3os-beta") ? "b3-fun/b3os-beta" : dir.startsWith("/Users/dev/workmesh") ? "b3-fun/workmesh" : undefined;
const m = (cmd: string, cwd = "/Users/dev/b3os-beta", custom?: string[]) => matchGates(cmd, cwd, { repoOf, home: HOME, custom });

describe("gate matcher (SPEC §31)", () => {
  const table: Array<[string, string, string] | [string, undefined]> = [
    // merge
    ["gh pr merge 212 --merge", "merge", "gh pr merge 212 --merge in b3-fun/b3os-beta"],
    ["gh pr merge 212 --squash --delete-branch", "merge", "gh pr merge 212 --squash --delete-branch in b3-fun/b3os-beta"],
    // `#` starts a shell comment: the shell runs a bare `gh pr merge` (the current branch's PR).
    ["gh pr merge #212", "merge", "gh pr merge in b3-fun/b3os-beta"],
    ["gh pr merge https://github.com/b3-fun/workmesh/pull/22 --merge", "merge", "gh pr merge 22 --merge in b3-fun/workmesh"],
    ["gh pr merge 5 -R b3-fun/workmesh --admin", "merge", "gh pr merge 5 --admin in b3-fun/workmesh"],
    ["gh pr merge --auto --squash", "merge", "gh pr merge --auto --squash in b3-fun/b3os-beta"],
    ["gh api -X PUT repos/b3-fun/x/pulls/9/merge", "merge", "gh api merge 9 in b3-fun/x"],
    ["glab mr merge 14", "merge", "glab mr merge 14 in b3-fun/b3os-beta"],
    // not merges
    ["gh pr view 212", undefined],
    ["gh pr create --fill", undefined],
    ["gh api repos/b3-fun/x/pulls/9/merge", undefined],
    ["git merge origin/main", undefined],
    // force push
    ["git push --force origin main", "force_push", "git push --force origin main in b3-fun/b3os-beta"],
    ["git push -f", "force_push", "git push -f in b3-fun/b3os-beta"],
    ["git push -uf origin feat", "force_push", "git push -uf origin feat in b3-fun/b3os-beta"],
    ["git push --force-with-lease=main:abc origin main", "force_push", "git push --force-with-lease origin main in b3-fun/b3os-beta"],
    ["git push origin +feat:feat", "force_push", "git push origin feat:feat in b3-fun/b3os-beta"],
    ["git push --mirror", "force_push", "git push --mirror in b3-fun/b3os-beta"],
    ["git push origin main", undefined],
    ["git push -u origin feat", undefined],
    ["git push --delete origin old", undefined],
    // deploy
    ["wrangler deploy", "deploy", "wrangler deploy in b3-fun/b3os-beta"],
    ["npx wrangler deploy --env production", "deploy", "wrangler deploy --env production in b3-fun/b3os-beta"],
    ["CLOUDFLARE_API_TOKEN=abc123 npx -y wrangler@4 deploy", "deploy", "wrangler deploy in b3-fun/b3os-beta"],
    ["bunx wrangler pages deploy dist", "deploy", "wrangler pages deploy in b3-fun/b3os-beta"],
    ["wrangler versions deploy", "deploy", "wrangler versions deploy in b3-fun/b3os-beta"],
    ["wrangler dev", undefined],
    ["wrangler secret put X", undefined],
    ["vercel --prod", "deploy", "vercel deploy --prod in b3-fun/b3os-beta"],
    ["vercel deploy", undefined],
    ["vercel promote dpl_1", "deploy", "vercel promote in b3-fun/b3os-beta"],
    ["netlify deploy --prod", "deploy", "netlify deploy --prod in b3-fun/b3os-beta"],
    ["netlify deploy", undefined],
    ["fly deploy", "deploy", "fly deploy in b3-fun/b3os-beta"],
    ["railway up", "deploy", "railway up in b3-fun/b3os-beta"],
    ["firebase deploy --only hosting", "deploy", "firebase deploy in b3-fun/b3os-beta"],
    ["kubectl apply -f k8s/", "deploy", "kubectl apply in b3-fun/b3os-beta"],
    ["kubectl get pods", undefined],
    ["helm upgrade api ./chart", "deploy", "helm upgrade in b3-fun/b3os-beta"],
    ["terraform apply -auto-approve", "deploy", "terraform apply in b3-fun/b3os-beta"],
    ["terraform plan", undefined],
    ["pulumi up --yes", "deploy", "pulumi up in b3-fun/b3os-beta"],
    ["cdk deploy", "deploy", "cdk deploy in b3-fun/b3os-beta"],
    ["gcloud run deploy api --region us", "deploy", "gcloud run deploy in b3-fun/b3os-beta"],
    ["aws cloudformation deploy --stack-name x", "deploy", "aws cloudformation deploy in b3-fun/b3os-beta"],
    ["npm run deploy", "deploy", "npm run deploy in b3-fun/b3os-beta"],
    ["pnpm run deploy:prod", "deploy", "pnpm run deploy:prod in b3-fun/b3os-beta"],
    ["pnpm deploy ./out", undefined],
    ["yarn deploy", "deploy", "yarn deploy in b3-fun/b3os-beta"],
    ["bun run deploy", "deploy", "bun run deploy in b3-fun/b3os-beta"],
    ["npm run build", undefined],
    ["npm run deployment-notes", undefined],
    ["make deploy ENV=prod", "deploy", "make deploy in b3-fun/b3os-beta"],
    ["make test", undefined],
    // publish
    ["npm publish --access public", "publish", "npm publish in b3-fun/b3os-beta"],
    ["npm publish --dry-run", "publish", "npm publish --dry-run in b3-fun/b3os-beta"],
    ["pnpm publish -r", "publish", "pnpm publish in b3-fun/b3os-beta"],
    ["yarn npm publish", "publish", "yarn publish in b3-fun/b3os-beta"],
    ["npm run release", "publish", "npm run release in b3-fun/b3os-beta"],
    ["cargo publish", "publish", "cargo publish in b3-fun/b3os-beta"],
    ["twine upload dist/*", "publish", "twine upload in b3-fun/b3os-beta"],
    ["uv publish", "publish", "uv publish in b3-fun/b3os-beta"],
    ["docker push ghcr.io/b3-fun/api:1", "publish", "docker push in b3-fun/b3os-beta"],
    ["docker buildx build --push .", "publish", "docker push in b3-fun/b3os-beta"],
    ["gh release create v1.2.0 --generate-notes", "publish", "gh release create v1.2.0 in b3-fun/b3os-beta"],
    ["npx changeset publish", "publish", "changeset publish in b3-fun/b3os-beta"],
    ["npm install", undefined],
    // spend
    ["aws ec2 run-instances --image-id ami-1", "spend", "aws ec2 run-instances in b3-fun/b3os-beta"],
    ["gcloud compute instances create gpu-1", "spend", "gcloud compute instances create in b3-fun/b3os-beta"],
    ["hcloud server create --name x", "spend", "hcloud server create in b3-fun/b3os-beta"],
    // nothing
    ["ls -la", undefined],
    ["echo 'gh pr merge 1'", undefined],
    ["cat <<EOF\ngh pr merge 1\nEOF", undefined],
  ];

  for (const row of table) {
    const [cmd, gate] = row;
    it(`${JSON.stringify(cmd)} → ${gate ?? "nothing"}`, () => {
      const got = m(cmd);
      if (gate === undefined) {
        expect(got).toEqual([]);
      } else {
        expect(got).toEqual([{ gate, detail: row[2] }]);
      }
    });
  }

  it("reads compound commands, cd, wrappers and sh -c", () => {
    expect(m("cd /Users/dev/workmesh && npm test && gh pr merge 3 --squash")).toEqual([
      { gate: "merge", detail: "gh pr merge 3 --squash in b3-fun/workmesh" },
    ]);
    expect(m("npm run build; npx wrangler deploy && git push --force")).toEqual([
      { gate: "deploy", detail: "wrangler deploy in b3-fun/b3os-beta" },
      { gate: "force_push", detail: "git push --force in b3-fun/b3os-beta" },
    ]);
    expect(m(`bash -lc "cd /Users/dev/workmesh && npm publish"`)).toEqual([{ gate: "publish", detail: "npm publish in b3-fun/workmesh" }]);
    expect(m("sudo -E env FOO=1 nohup wrangler deploy")).toEqual([{ gate: "deploy", detail: "wrangler deploy in b3-fun/b3os-beta" }]);
    expect(m("gh pr merge 1", "/tmp/elsewhere")).toEqual([{ gate: "merge", detail: "gh pr merge 1" }]);
  });

  it("never puts a secret-looking value in a detail", () => {
    const [hit] = m("GH_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789 gh pr merge 7 --merge --body=ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(hit?.detail).toBe("gh pr merge 7 --merge in b3-fun/b3os-beta");
    const [push] = m("git push --force https://x-access-token:ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/b3-fun/x main");
    expect(push?.detail).toBe("git push --force main in b3-fun/b3os-beta");
    expect(push?.detail).not.toContain("ghp_");
  });

  it("custom patterns match as `custom` (bad regexes are ignored)", () => {
    expect(m("./scripts/rotate-keys.sh prod", "/tmp", ["rotate-keys", "(unclosed"])).toEqual([{ gate: "custom", detail: "rotate-keys.sh prod" }]);
    expect(m("./scripts/other.sh", "/tmp", ["rotate-keys"])).toEqual([]);
  });

  it("unwraps package runners", () => {
    expect(unwrap(["npx", "-y", "wrangler", "deploy"])).toEqual(["wrangler", "deploy"]);
    expect(unwrap(["pnpm", "dlx", "vercel", "--prod"])).toEqual(["vercel", "--prod"]);
    expect(unwrap(["npm", "exec", "--", "wrangler", "deploy"])).toEqual(["wrangler", "deploy"]);
    expect(unwrap(["A=1", "B=2", "time", "make", "deploy"])).toEqual(["make", "deploy"]);
  });
});
