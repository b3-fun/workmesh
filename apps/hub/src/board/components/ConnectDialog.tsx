import { Note } from "../b3os/ds/kit/attention";
import { CopyButton } from "../b3os/ds/kit/copy";
import { ResponsiveDialog } from "../b3os/ds/kit/dialog";
import { Button } from "../b3os/app/ui/primitives";

export const connectCommand = () => `agentblip hub connect ${location.origin}`;

/** The command on the kit's dark code island, with its copy button. */
export function Command({ command }: { command: string }) {
  return (
    <div className="bp-command">
      <code className="bp-command__text">
        <span className="bp-command__prompt" aria-hidden="true">
          ${" "}
        </span>
        {command}
      </code>
      <CopyButton value={command} label="Copy the command" inverse />
    </div>
  );
}

/** What connecting shares, said once (SPEC.md §8). */
export function SharingNote() {
  return (
    <Note>
      Only sessions in b3-fun repos are shared. You choose in the terminal whether that includes prompts and the
      agent's messages, or tool activity only.
    </Note>
  );
}

export function ConnectDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <ResponsiveDialog
      open={open}
      onClose={onClose}
      title="Connect a machine"
      description="Run this where your agents run, then approve the code it prints."
      footer={
        <Button variant="neutral" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div className="grid gap-4">
        <Command command={connectCommand()} />
        <SharingNote />
      </div>
    </ResponsiveDialog>
  );
}
