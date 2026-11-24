import { AlertDialog, Dialog } from "radix-ui";
import { useEffect, useState, type ReactNode } from "react";
import type { Device } from "../../shared/types";
import { api } from "../api";
import { Age, Button, CopyCommand, IconClose } from "./ui";

export const connectCommand = () => `agentblip hub connect ${location.origin}`;

export function SharingNote() {
  return (
    <p className="text-[12.5px] leading-relaxed text-muted">
      Only sessions in <span className="font-mono text-[12px] text-text">b3-fun</span> repos are shared, and only
      metadata: tool names, paths, branches, issue ids. Prompts, output and file contents stay on the machine.
    </p>
  );
}

function RevokeButton({ device, onRevoked }: { device: Device; onRevoked: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <AlertDialog.Root>
      <AlertDialog.Trigger asChild>
        <Button variant="ghost" className="h-7 px-2 text-[12px] max-sm:h-9">
          Revoke
        </Button>
      </AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="overlay-in fixed inset-0 z-50 bg-black/40" />
        <AlertDialog.Content className="dialog-in fixed top-1/2 left-1/2 z-50 w-[calc(100vw-32px)] max-w-[24rem] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-line bg-surface p-5 shadow-pop">
          <AlertDialog.Title className="text-[15px] font-semibold text-fg">
            Revoke <span className="font-mono text-[14px]">{device.machine}</span>?
          </AlertDialog.Title>
          <AlertDialog.Description className="mt-2 text-[13px] text-muted">
            Its relay stops sending at once and its sessions leave the board. Connect it again to bring it back.
          </AlertDialog.Description>
          <div className="mt-5 flex justify-end gap-2">
            <AlertDialog.Cancel asChild>
              <Button variant="secondary">Cancel</Button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <Button
                variant="danger"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await api.revoke(device.id);
                    onRevoked();
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Revoke
              </Button>
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

function MyMachines() {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const load = () =>
    api
      .devices()
      .then((r) => setDevices(r.devices.filter((d) => d.revokedAt == null)))
      .catch(() => setDevices([]));
  useEffect(() => {
    void load();
  }, []);
  if (!devices || devices.length === 0) return null;
  return (
    <div className="mt-6">
      <h3 className="text-[12px] font-semibold text-muted">Your machines</h3>
      <ul className="mt-1">
        {devices.map((d) => (
          <li key={d.id} className="flex items-center justify-between gap-3 border-t border-line py-2 first:border-t-0">
            <div className="min-w-0">
              <div className="truncate font-mono text-[12.5px] text-fg">{d.machine}</div>
              <div className="truncate text-[12px] text-faint">
                <span className="font-mono">{d.client}</span>
                {d.lastSeenAt ? (
                  <>
                    {" · seen "}
                    <Age ts={d.lastSeenAt} /> ago
                  </>
                ) : (
                  " · not seen yet"
                )}
              </div>
            </div>
            <RevokeButton device={d} onRevoked={() => void load()} />
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ConnectDialog({
  open,
  onOpenChange,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children?: ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      {children}
      <Dialog.Portal>
        <Dialog.Overlay className="overlay-in fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content className="dialog-in fixed top-1/2 left-1/2 z-40 max-h-[calc(100dvh-32px)] w-[calc(100vw-32px)] max-w-[32rem] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-line bg-surface p-5 shadow-pop">
          <div className="flex items-start justify-between gap-4">
            <Dialog.Title className="text-[16px] font-semibold tracking-[-0.01em] text-fg">Connect a machine</Dialog.Title>
            <Dialog.Close asChild>
              <Button variant="ghost" className="-mt-1 -mr-2 h-8 w-8 px-0 max-sm:h-10 max-sm:w-10" aria-label="Close">
                <IconClose size={16} />
              </Button>
            </Dialog.Close>
          </div>
          <Dialog.Description className="mt-1 text-[13px] text-muted">
            Run this where your agents run, then approve the code it prints.
          </Dialog.Description>
          <div className="mt-4">
            <CopyCommand command={connectCommand()} />
          </div>
          <div className="mt-3">
            <SharingNote />
          </div>
          {open && <MyMachines />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
