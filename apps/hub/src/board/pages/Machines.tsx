import { useCallback, useEffect, useState } from "react";
import { OFFLINE_AFTER_MS, type Device } from "../../shared/types";
import { RowCard } from "../b3os/ds/kit/cards";
import { InlineError } from "../b3os/ds/kit/charts/frame";
import { ConfirmDialog } from "../b3os/ds/kit/dialog";
import { EmptyState } from "../b3os/ds/kit/empty-state";
import { PageHeaderView } from "../b3os/ds/kit/page-header";
import { PageReveal } from "../b3os/ds/kit/page-reveal";
import { SkeletonRows } from "../b3os/ds/kit/skeleton";
import { Status } from "../b3os/ds/kit/status";
import { Button } from "../b3os/app/ui/primitives";
import { Icon } from "../b3os/ui/Icon";
import { ApiError, api } from "../api";
import { useBoardData } from "../board-context";
import { age, useNow } from "../time";

type Read = { state: "reading" } | { state: "done"; devices: Device[] } | { state: "failed"; error: unknown; devices: Device[] | null };

function MachineRow({ d, onRevoke }: { d: Device; onRevoke: (d: Device) => void }) {
  const now = useNow();
  const online = d.lastSeenAt != null && now - d.lastSeenAt <= OFFLINE_AFTER_MS;
  return (
    <RowCard
      icon="terminal"
      title={d.machine}
      status={
        <Status
          status={
            online
              ? { tone: "ok", word: "Connected" }
              : d.lastSeenAt
                ? { tone: "off", word: "Offline" }
                : { tone: "off", word: "Not seen yet" }
          }
        />
      }
      meta={[
        <span key="client" className="font-mono">
          {d.client}
        </span>,
        d.share === "conversation" ? "Shares prompts and messages" : "Activity only",
        d.lastSeenAt && !online ? `seen ${age(now - d.lastSeenAt)} ago` : null,
      ]}
      actions={
        <button
          type="button"
          className="kit-icon-btn kit-press"
          data-size="sm"
          aria-label={`Revoke ${d.machine}`}
          title="Revoke"
          onClick={() => onRevoke(d)}
        >
          <Icon name="trash" size={14} />
        </button>
      }
    />
  );
}

/** The machines you connected, each revocable through the shared confirm. */
export function MachinesPage() {
  const { setConnectOpen } = useBoardData();
  const [read, setRead] = useState<Read>({ state: "reading" });
  const [retrying, setRetrying] = useState(false);
  const [revoking, setRevoking] = useState<Device | null>(null);
  const load = useCallback(async () => {
    try {
      const r = await api.devices();
      setRead({ state: "done", devices: r.devices.filter((d) => d.revokedAt == null) });
    } catch (error) {
      setRead((prev) => ({ state: "failed", error, devices: prev.state === "reading" ? null : prev.devices }));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const devices = read.state === "reading" ? null : read.devices;
  const err = read.state === "failed" && read.error instanceof ApiError ? read.error : null;
  return (
    <PageReveal
      className="kit-page-floor"
      header={
        <PageHeaderView
          title="Machines"
          line="The machines you connected to B3."
          actions={
            <Button variant="brand" icon="plus" onClick={() => setConnectOpen(true)}>
              Connect a machine
            </Button>
          }
        />
      }
      loading={read.state === "reading"}
      skeleton={
        <div data-page-slot="panel">
          <SkeletonRows rows={3} />
        </div>
      }
    >
      <div data-page-slot="panel">
        {read.state === "failed" ? (
          <InlineError
            align="start"
            onRetry={() => {
              setRetrying(true);
              void load().finally(() => setRetrying(false));
            }}
            retrying={retrying}
            requestId={err?.requestId ?? undefined}
            retryAfter={err?.retryAfterS ?? undefined}
            retryKey={read.error}
          >
            Your machines did not load
          </InlineError>
        ) : null}
        {devices && devices.length === 0 ? (
          <EmptyState
            kind="start"
            title="No machines yet"
            body="Run one command where your agents run. Its sessions show on the board within seconds."
            action={
              <Button variant="brand" icon="plus" onClick={() => setConnectOpen(true)}>
                Connect a machine
              </Button>
            }
          />
        ) : devices ? (
          <div className="home-rows">
            {devices.map((d) => (
              <MachineRow key={d.id} d={d} onRevoke={setRevoking} />
            ))}
          </div>
        ) : null}
      </div>
      <ConfirmDialog
        open={revoking != null}
        onClose={() => setRevoking(null)}
        title={`Revoke ${revoking?.machine ?? "this machine"}?`}
        body="Its relay stops sending at once and its sessions leave the board. Connect it again to bring it back."
        confirm="Revoke"
        onConfirm={async () => {
          if (!revoking) return;
          await api.revoke(revoking.id);
          await load();
        }}
      />
    </PageReveal>
  );
}
