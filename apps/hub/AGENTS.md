# Working in this repo

- **Contract:** `SPEC.md` is the build contract for v0. Change it in the same commit as any code that departs from it.
- **Linear:** parent B3-7165, v0 is B3-7166 (project "B3OS Beta", team NPC Labs). Sean's agents prefix every Linear
  comment with "(Claude, for Sean)", comment at each merge and deploy, and re-read the issue's comments before each
  merge or deploy. A person's comment is an instruction; "hold" pauses the work.
- **Deploy:** Cloudflare account NPC Labs `4300a93c2dcb252fa91df03f18e8e44c` only, pinned in `wrangler.jsonc`. Run
  `npx wrangler whoami` and compare the account id first. Never run two wrangler commands at once.
- **Privacy:** the hub stores metadata only (SPEC.md §3.3). A change that would store prompt text, tool input or
  output, file contents or full commands is out of scope without Sean's word.
- **Commits:** small, pushed after each one. Never force-push, never skip hooks. Commit messages end with the
  Co-Authored-By line for the model that wrote them.
- **UI:** Radix primitives for dialogs, menus and form controls; no native `alert()`/`confirm()`. B3 brand per
  `docs/research.html`.
