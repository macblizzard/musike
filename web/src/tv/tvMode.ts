/**
 * Android TV mode: 10-foot UI plus D-pad spatial navigation.
 *
 * Enabled by VITE_TV=1 at build time (see tools/build-apk-tv.sh) or by opening the app with ?tv=1,
 * so the normal desktop/mobile builds are untouched.
 */

const FOCUSABLE = [
  "button:not([disabled])",
  "a[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
  '[role="button"]',
  '[role="slider"]',
  "[data-tv-focusable]",
].join(",");

export function isTvMode(): boolean {
  if (typeof window === "undefined") return false;
  if (new URLSearchParams(window.location.search).has("tv")) return true;
  if (import.meta.env.VITE_TV === "1") return true;
  return document.documentElement.dataset.tv === "1";
}

const rectOf = (el: HTMLElement) => el.getBoundingClientRect();

function visible(el: HTMLElement): boolean {
  if (el === document.body) return false;
  const r = rectOf(el);
  if (r.width < 4 || r.height < 4) return false;
  if (r.bottom < -40 || r.top > window.innerHeight + 40) return false;
  const style = window.getComputedStyle(el);
  if (style.visibility === "hidden" || style.opacity === "0") return false;
  return true;
}

function candidates(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(visible);
}

function center(el: HTMLElement) {
  const r = rectOf(el);
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

function move(direction: "left" | "right" | "up" | "down"): boolean {
  const current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const from = current && visible(current) ? center(current) : { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  let best: HTMLElement | null = null;
  let bestScore = Number.POSITIVE_INFINITY;

  for (const el of candidates()) {
    if (el === current) continue;
    const to = center(el);
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const primary =
      direction === "left" ? -dx : direction === "right" ? dx : direction === "up" ? -dy : dy;
    if (primary < 6) continue;                              // not in that direction
    const secondary = direction === "left" || direction === "right" ? Math.abs(dy) : Math.abs(dx);
    const score = primary + secondary * 2.2;                 // stay in the same row/column when possible
    if (score < bestScore) {
      bestScore = score;
      best = el;
    }
  }
  if (!best) return false;
  best.focus({ preventScroll: true });
  best.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  return true;
}

function activate(): boolean {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement) || el === document.body) return false;
  if (el instanceof HTMLInputElement && /^(text|search)$/.test(el.type)) return false;
  el.click();
  return true;
}

let installed = false;

export function installTvMode() {
  if (installed || !isTvMode()) return;
  installed = true;
  document.documentElement.dataset.tv = "1";

  window.addEventListener(
    "keydown",
    (event) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target instanceof HTMLElement &&
        (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
      const key = event.key;
      const handled = () => {
        event.preventDefault();
        event.stopPropagation();
      };

      if (key === "ArrowLeft" || key === "ArrowRight" || key === "ArrowUp" || key === "ArrowDown") {
        if (typing) return;
        if (move(key.replace("Arrow", "").toLowerCase() as "left" | "right" | "up" | "down")) handled();
        return;
      }
      if ((key === "Enter" || key === " ") && !typing) {
        // Buttons already activate themselves on Enter/Space.
        if (document.activeElement instanceof HTMLButtonElement) return;
        if (activate()) handled();
        return;
      }
      if (key === "Escape" || key === "BrowserBack") {
        // Let the app's own handlers/dialogs deal with Escape first.
      }
    },
    { capture: true },
  );

  // First focus so the remote is immediately useful.
  const focusFirst = () => {
    const first = candidates()[0];
    if (first && document.activeElement === document.body) first.focus({ preventScroll: true });
  };
  window.setTimeout(focusFirst, 400);
  document.addEventListener("route-change", focusFirst as EventListener);
}
