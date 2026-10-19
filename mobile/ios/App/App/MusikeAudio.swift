import AVFoundation
import Capacitor
import WebKit

/// Plays audio natively, so the music doesn't go through the web view's media stack.
///
/// WKWebView hands media to a separate process that YouTube cuts off after a few hundred kilobytes: the element
/// just pauses, with no error, about fifteen seconds in. AVPlayer uses the app's own network stack instead, which
/// reads the same URL from beginning to end. The web app drives it through the `musikeAudio` handler and gets
/// `window.__musikeAudioEvent(...)` back, so the player code doesn't have to know the difference.
final class MusikeAudio: NSObject, WKScriptMessageHandler {
    private weak var webView: WKWebView?
    private var player: AVPlayer?
    private var item: AVPlayerItem?
    private var ticker: Any?
    private var statusObservation: NSKeyValueObservation?
    private var endObserver: NSObjectProtocol?

    func attach(_ webView: WKWebView?) {
        self.webView = webView
    }

    // MARK: - What the web app sends

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "musikeAudio",
              let body = message.body as? [String: Any],
              let command = body["cmd"] as? String
        else { return }

        switch command {
        case "load":
            load(body["url"] as? String ?? "", startAt: body["startAt"] as? Double ?? 0)
        case "play":
            play()
        case "pause":
            player?.pause()
        case "seek":
            seek(body["to"] as? Double ?? 0)
        case "volume":
            player?.volume = Float(body["value"] as? Double ?? 1)
        case "muted":
            player?.isMuted = body["value"] as? Bool ?? false
        default:
            break
        }
    }

    // MARK: - Playback

    private func load(_ link: String, startAt: Double) {
        tearDown()
        guard let url = URL(string: link), !link.isEmpty else {
            emit("error", ["message": "No stream"])
            return
        }
        let asset = AVURLAsset(url: url, options: [
            "AVURLAssetHTTPHeaderFieldsKey": [
                "User-Agent": "com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_1_0 like Mac OS X;)",
            ],
        ])
        let newItem = AVPlayerItem(asset: asset)
        // Keep a visible amount ahead of the playhead, so the buffered part of the progress bar means something.
        newItem.preferredForwardBufferDuration = 30
        let newPlayer = AVPlayer(playerItem: newItem)
        newPlayer.automaticallyWaitsToMinimizeStalling = true
        newPlayer.volume = player?.volume ?? 1
        player = newPlayer
        item = newItem

        statusObservation = newItem.observe(\.status, options: [.initial, .new]) { [weak self] item, _ in
            guard let self else { return }
            switch item.status {
            case .readyToPlay:
                let seconds = CMTimeGetSeconds(item.duration)
                self.emit("ready", ["duration": seconds.isFinite ? seconds : 0])
                if startAt > 0 { self.seek(startAt) }
            case .failed:
                self.emit("error", ["message": item.error?.localizedDescription ?? "Playback failed"])
            default:
                break
            }
        }
        endObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime, object: newItem, queue: .main
        ) { [weak self] _ in
            self?.emit("ended")
        }
        ticker = newPlayer.addPeriodicTimeObserver(forInterval: CMTime(seconds: 0.5, preferredTimescale: 600), queue: .main) { [weak self] time in
            guard let self, let item = self.item else { return }
            let duration = CMTimeGetSeconds(item.duration)
            self.emit("time", [
                "position": CMTimeGetSeconds(time),
                "duration": duration.isFinite ? duration : 0,
                "buffered": self.bufferedEnd(),
            ])
        }
    }

    private func play() {
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .default)
        try? session.setActive(true)
        player?.play()
        emit("playing")
    }

    private func seek(_ to: Double) {
        guard let player else { return }
        player.seek(
            to: CMTime(seconds: max(0, to), preferredTimescale: 600),
            toleranceBefore: .zero,
            toleranceAfter: .zero
        ) { [weak self] finished in
            guard finished else { return }
            // AVPlayer reports the old position until the seek lands; the web side waits for this.
            self?.emit("seeked", ["position": to])
        }
    }

    private func bufferedEnd() -> Double {
        guard let range = item?.loadedTimeRanges.last?.timeRangeValue else { return 0 }
        return CMTimeGetSeconds(CMTimeAdd(range.start, range.duration))
    }

    private func tearDown() {
        if let ticker { player?.removeTimeObserver(ticker) }
        ticker = nil
        statusObservation = nil
        if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
        endObserver = nil
        player?.pause()
        player = nil
        item = nil
    }

    private func emit(_ event: String, _ payload: [String: Any] = [:]) {
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8)
        else { return }
        let js = "window.__musikeAudioEvent && window.__musikeAudioEvent('\(event)', \(json))"
        if Thread.isMainThread {
            webView?.evaluateJavaScript(js)
        } else {
            DispatchQueue.main.async { [weak self] in self?.webView?.evaluateJavaScript(js) }
        }
    }
}
