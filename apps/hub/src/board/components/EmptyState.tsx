import { SharingNote, connectCommand } from "./ConnectDialog";
import { CopyCommand } from "./ui";

export function EmptyState() {
  return (
    <div className="flex flex-1 items-start justify-center px-4 pt-[14vh] pb-16">
      <div className="w-full max-w-[30rem]">
        <h1 className="text-[22px] font-semibold tracking-[-0.02em] text-fg">No machines yet</h1>
        <p className="mt-2 text-[14px] text-muted">
          Connect the machine your agents run on. Its Claude Code and Codex sessions appear here within seconds.
        </p>
        <ol className="mt-7 flex flex-col gap-5">
          <li className="grid grid-cols-[1.25rem_minmax(0,1fr)] gap-3">
            <span className="tnum pt-px font-mono text-[12px] text-accent">1</span>
            <div className="flex min-w-0 flex-col gap-2">
              <span className="text-[13.5px] text-text">Run this in a terminal</span>
              <CopyCommand command={connectCommand()} />
            </div>
          </li>
          <li className="grid grid-cols-[1.25rem_minmax(0,1fr)] gap-3">
            <span className="tnum pt-px font-mono text-[12px] text-accent">2</span>
            <span className="text-[13.5px] text-text">Open the link it prints and approve the code.</span>
          </li>
          <li className="grid grid-cols-[1.25rem_minmax(0,1fr)] gap-3">
            <span className="tnum pt-px font-mono text-[12px] text-accent">3</span>
            <span className="text-[13.5px] text-text">Start an agent in any b3-fun repo.</span>
          </li>
        </ol>
        <div className="mt-8 border-t border-line pt-4">
          <SharingNote />
        </div>
      </div>
    </div>
  );
}
