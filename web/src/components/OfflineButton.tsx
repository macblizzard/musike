import { CheckCircleIcon, DownloadSimpleIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useT } from "../i18n";
import { approxBytes, drop, formatBytes, keep, keptIds, offlineSupported } from "../lib/offline";
import type { Track } from "../lib/types";
import { toast } from "../stores/ui";
import { useOffline } from "../stores/offline";
import { IconButton } from "./IconButton";

/** Keeps a whole collection available offline, or releases it again. */
export function OfflineButton({ tracks }: { tracks: Track[] }) {
  const t = useT();
  const ids = useMemo(() => tracks.map((tr) => tr.id).filter(Boolean), [tracks]);
  const [kept, setKept] = useState<number | null>(null);
  const [busy, setBusy] = useState<{ done: number; total: number } | null>(null);

  const refresh = useCallback(async () => {
    const have = await keptIds();
    setKept(ids.filter((id) => have.has(id)).length);
  }, [ids]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const total = approxBytes(tracks.reduce((sum, tr) => sum + (tr.duration || 0), 0));
  const all = ids.length > 0 && kept === ids.length;

  const save = async () => {
    const have = await keptIds();
    const missing = tracks.filter((tr) => tr.id && !have.has(tr.id));
    if (!missing.length) return;
    setBusy({ done: 0, total: missing.length });
    let failed = 0;
    for (let i = 0; i < missing.length; i++) {
      try {
        await keep(missing[i]);
      } catch {
        failed++;
      }
      setBusy({ done: i + 1, total: missing.length });
    }
    setBusy(null);
    await refresh();
    await useOffline.getState().refresh();
    const t = useT();
    if (failed) toast(t.offline.someFailed(failed, missing.length), "error");
    else toast(t.offline.saved(missing.length));
  };

  const release = async () => {
    setBusy({ done: 0, total: ids.length });
    for (let i = 0; i < ids.length; i++) {
      await drop(ids[i]);
      setBusy({ done: i + 1, total: ids.length });
    }
    setBusy(null);
    await refresh();
    await useOffline.getState().refresh();
    toast(useT().offline.removed);
  };

  if (!offlineSupported() || !ids.length) return null;
  const size = formatBytes(total);

  return (
    <IconButton
      label={busy ? t.offline.saving(busy.done, busy.total) : all ? t.offline.remove(size) : t.offline.keep(size)}
      size="lg"
      active={all}
      disabled={!!busy}
      onClick={() => void (all ? release() : save())}
    >
      {busy ? (
        <span className="block size-[18px] animate-spin rounded-full border-2 border-current border-t-transparent" />
      ) : all ? (
        <CheckCircleIcon size={24} weight="fill" />
      ) : (
        <DownloadSimpleIcon size={24} />
      )}
    </IconButton>
  );
}
