import { App } from "@capacitor/app";
import { Capacitor, SystemBars, SystemBarsStyle } from "@capacitor/core";

// How the app fits into Android itself: the Back button and the system bars.
if (Capacitor.isNativePlatform()) {
  // Back closes what's on top (a dialog, a menu), then goes back through pages, then sends the app to the
  // background, where the music keeps playing.
  void App.addListener("backButton", () => {
    const overlay = [...document.querySelectorAll("[data-escape-closes]")].some((el) => el.getClientRects().length > 0);
    if (overlay) {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      return;
    }
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (idx > 0) window.history.back();
    else void App.minimizeApp();
  });

  // Status and navigation bar icons stay readable in both themes.
  const syncBars = () => {
    const light = document.documentElement.dataset.theme === "light";
    void SystemBars.setStyle({ style: light ? SystemBarsStyle.Light : SystemBarsStyle.Dark });
  };
  syncBars();
  new MutationObserver(syncBars).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
}
