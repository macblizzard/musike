import { MusicNotesIcon } from "@phosphor-icons/react";
import { useCallback, useState } from "react";
import { cn } from "../lib/format";

interface Props {
  src?: string;
  /** Used when `src` fails, e.g. hq720 thumbnails that do not exist for older videos. */
  fallback?: string;
  alt?: string;
  className?: string;
  iconSize?: number;
}

export function Artwork(props: Props) {
  // Keyed by source so a new image starts from a clean loading state, without a reset effect
  // (an effect could run after a cached image already fired onLoad and leave it stuck invisible).
  return <ArtworkImage key={`${props.src ?? ""}|${props.fallback ?? ""}`} {...props} />;
}

/**
 * YouTube answers a request for a thumbnail a video does not have with a 120x120 stand-in image
 * and an ordinary 200, so a missing cover never fires `error` — it just renders as a grey tile.
 * Anything that small is treated as a failure so the fallback gets used.
 */
const isPlaceholder = (img: HTMLImageElement) => img.naturalWidth > 0 && img.naturalWidth <= 120;

function ArtworkImage({ src, fallback, alt = "", className, iconSize = 20 }: Props) {
  const [current, setCurrent] = useState(src || fallback);
  const [state, setState] = useState<"loading" | "ok" | "error">(src || fallback ? "loading" : "error");
  const canFallBack = !!fallback && current !== fallback;

  const rejected = useCallback(() => {
    if (canFallBack) setCurrent(fallback!);
    else setState("error");
  }, [canFallBack, fallback]);

  // Images served from cache can be complete before React attaches onLoad, so the ref and onLoad
  // both run the same check. The ref also re-runs once the fallback swap changes its identity,
  // which covers a fallback that is already cached from elsewhere on the page.
  const settle = useCallback(
    (img: HTMLImageElement | null) => {
      if (!img || !img.complete) return;
      if (img.naturalWidth === 0 || (isPlaceholder(img) && canFallBack)) {
        rejected();
        return;
      }
      setState("ok");
    },
    [canFallBack, rejected],
  );

  return (
    <div className={cn("relative shrink-0 overflow-hidden bg-surface-3", className)}>
      {state !== "error" && current && (
        <img
          ref={settle}
          src={current}
          alt={alt}
          loading="lazy"
          decoding="async"
          draggable={false}
          referrerPolicy="no-referrer"
          onLoad={(e) => settle(e.currentTarget)}
          onError={rejected}
          className={cn(
            "h-full w-full object-cover transition-opacity duration-300 ease-out-expo",
            state === "ok" ? "opacity-100" : "opacity-0",
          )}
        />
      )}
      {state === "loading" && <div className="skeleton absolute inset-0" />}
      {state === "error" && (
        <div className="absolute inset-0 grid place-items-center text-fg-3">
          <MusicNotesIcon size={iconSize} />
        </div>
      )}
    </div>
  );
}
