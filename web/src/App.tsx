import { useEffect, useRef } from "react";
import { Route, Routes, useLocation, useNavigate } from "react-router";
import { AddToPlaylistDialog, ShortcutsDialog } from "./components/Dialogs";
import { MiniPlayer, TabBar } from "./components/MobileChrome";
import { NowPlayingSheet, PanelDrawer, SidePanel } from "./components/NowPlaying";
import { PlayerBar } from "./components/PlayerBar";
import { Rail } from "./components/Rail";
import { TitleBar } from "./components/TitleBar";
import { desktop } from "./lib/desktop";
import { SettingsDialog } from "./components/SettingsDialog";
import { Toasts } from "./components/Toasts";
import { TrackMenu } from "./components/TrackMenu";
import { FloatingVideo, Theater } from "./components/Video";
import { MD, useMediaQuery } from "./hooks/useMediaQuery";
import { useShortcuts } from "./hooks/useShortcuts";
import { cn } from "./lib/format";
import { usePlayer } from "./player/player";
import { useLibrary } from "./stores/library";
import { openSettings, useSystem } from "./stores/system";
import { toast, useUi } from "./stores/ui";
import Collection from "./views/Collection";
import Home from "./views/Home";
import Library from "./views/Library";
import Search from "./views/Search";

const SHEET_HASH = "#tocando";

export default function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const isMd = useMediaQuery(MD);
  const panelOpen = useUi((s) => s.panelOpen);
  const hasTrack = usePlayer((s) => s.queue.length > 0);
  const loadLibrary = useLibrary((s) => s.load);
  const loadSystem = useSystem((s) => s.load);
  const main = useRef<HTMLElement>(null);

  useShortcuts();

  useEffect(() => {
    void loadLibrary();
  }, [loadLibrary]);

  // Check yt-dlp shortly after start and say so once if something needs doing.
  useEffect(() => {
    const t = setTimeout(async () => {
      await loadSystem();
      const info = useSystem.getState().info;
      if (!info) return;
      if (!info.ytdlp.path) {
        toast("O yt-dlp não foi encontrado. Sem ele nenhuma música toca.", "error", { label: "Instalar", run: openSettings });
        return;
      }
      const latest = info.ytdlp.latest[info.ytdlp.channel];
      if (info.ytdlp.updateAvailable && latest) {
        try {
          if (sessionStorage.getItem("musike:update-notice") === latest) return;
          sessionStorage.setItem("musike:update-notice", latest);
        } catch {
          /* private mode */
        }
        toast(`Nova versão do yt-dlp disponível (${latest})`, "info", { label: "Atualizar", run: openSettings });
      }
    }, 1500);
    return () => clearTimeout(t);
  }, [loadSystem]);

  // New page, back to the top (the sheet hash is not a page change).
  useEffect(() => {
    main.current?.scrollTo({ top: 0 });
  }, [location.pathname]);

  const sheetOpen = !isMd && location.hash === SHEET_HASH;
  const closeSheet = () => {
    // Pop the history entry the sheet pushed, so Back and the close button behave the same.
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (idx > 0) navigate(-1);
    else navigate({ hash: "" }, { replace: true });
  };

  return (
    <div className={cn("grain flex h-dvh flex-col bg-bg md:gap-2 md:p-2", desktop && "md:pt-0")}>
      {desktop && <TitleBar />}
      <div className="flex min-h-0 flex-1 md:gap-2">
        <Rail />
        <main
          ref={main}
          className={cn(
            "scroll-area relative min-w-0 flex-1 overflow-y-auto md:rounded-[20px] md:bg-surface-1 md:ring-1 md:ring-line",
            hasTrack ? "pb-[calc(152px+env(safe-area-inset-bottom))]" : "pb-[calc(88px+env(safe-area-inset-bottom))]",
            "md:pb-0",
          )}
        >
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/buscar" element={<Search />} />
            <Route path="/biblioteca" element={<Library />} />
            <Route path="/favoritas" element={<Collection kind="favorites" />} />
            <Route path="/historico" element={<Collection kind="history" />} />
            <Route path="/playlist/:id" element={<Collection kind="playlist" />} />
            <Route path="*" element={<Home />} />
          </Routes>
        </main>
        {panelOpen && hasTrack && <SidePanel />}
      </div>

      {isMd ? (
        <PlayerBar />
      ) : (
        <>
          <MiniPlayer />
          <TabBar />
        </>
      )}

      <PanelDrawer />
      <NowPlayingSheet open={sheetOpen} onClose={closeSheet} />
      <FloatingVideo />
      <Theater />
      <TrackMenu />
      <AddToPlaylistDialog />
      <ShortcutsDialog />
      <SettingsDialog />
      <Toasts />
    </div>
  );
}
