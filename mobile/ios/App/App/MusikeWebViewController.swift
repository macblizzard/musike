import AVFoundation
import Capacitor
import UIKit
import WebKit

/// The app's web view: Capacitor's own, plus the two bridges iOS needs that Android has in its Java code —
/// the lock screen (MusikePlayback) and resolving a stream URL (MusikeYouTube).
final class MusikeWebViewController: CAPBridgeViewController {
    private let playback = MusikePlayback()
    private let youtube = MusikeYouTube()
    private let audio = MusikeAudio()
    private let offline = MusikeOffline()

    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        // Capacitor replaces the web view's userContentController after the configuration is built, so the handlers
        // are added here, once the web view exists.
        webView?.configuration.userContentController.add(playback, name: "musikeMedia")
        webView?.configuration.userContentController.add(youtube, name: "musikeResolve")
        webView?.configuration.userContentController.add(audio, name: "musikeAudio")
        webView?.configuration.userContentController.add(offline, name: "musikeOffline")
        playback.attach(webView)
        youtube.attach(webView)
        audio.attach(webView)
        offline.attach(webView)
        // Swipe from the left edge goes back, like the Android back button: dialogs close, then pages.
        webView?.allowsBackForwardNavigationGestures = true
    }
}


/// Keeps tracks on the phone so they play with no connection.
///
/// This cannot be done in the web app on iOS: googlevideo answers without CORS headers, so `fetch()` inside the
/// web view cannot read the audio at all (it works in a browser only because the request goes to our own server
/// proxy). The bytes are downloaded here with URLSession, into Documents rather than Caches, so a system cache
/// purge cannot take the user's downloads with it. The player then gets a plain file URL, which AVPlayer reads
/// directly — no network, no byte-range round trip, seeking is instant.
final class MusikeOffline: NSObject, WKScriptMessageHandler {
    private weak var webView: WKWebView?

    private static let folder = "offline"
    /// googlevideo throttles a plain GET to roughly 32 KiB/s; a byte range is served at full speed.
    private static let userAgent = "com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_1_0 like Mac OS X;)"

    func attach(_ webView: WKWebView?) {
        self.webView = webView
    }

    private var directory: URL {
        let base = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let dir = base.appendingPathComponent(Self.folder, isDirectory: true)
        if !FileManager.default.fileExists(atPath: dir.path) {
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        }
        return dir
    }

    /// Only the characters a video id can hold, so a crafted id can never climb out of the folder.
    private static func safeId(_ id: String) -> String {
        id.filter { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" }
    }

    private func file(_ id: String) -> URL {
        directory.appendingPathComponent("\(Self.safeId(id)).m4a")
    }

    private func size(_ url: URL) -> Int {
        (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int) ?? 0
    }

    // MARK: - What the web app sends

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "musikeOffline",
              let body = message.body as? [String: Any],
              let request = body["req"] as? Int,
              let command = body["cmd"] as? String
        else { return }

        switch command {
        case "download":
            download(
                id: body["id"] as? String ?? "",
                url: body["url"] as? String ?? "",
                seconds: body["duration"] as? Double ?? 0,
                request: request
            )
        case "path":
            let target = file(body["id"] as? String ?? "")
            reply(request, [
                "found": FileManager.default.fileExists(atPath: target.path),
                "path": target.path,
                "bytes": size(target),
            ])
        case "remove":
            try? FileManager.default.removeItem(at: file(body["id"] as? String ?? ""))
            reply(request, ["ok": true])
        case "list":
            let rows = (try? FileManager.default.contentsOfDirectory(
                at: directory, includingPropertiesForKeys: [.fileSizeKey]
            ))?.map { url -> [String: Any] in
                ["id": url.deletingPathExtension().lastPathComponent, "bytes": size(url)]
            } ?? []
            reply(request, ["files": rows])
        default:
            reply(request, ["error": "unknown command"])
        }
    }

    // MARK: - Downloading

    private func download(id: String, url: String, seconds: Double, request: Int) {
        guard !id.isEmpty, let link = URL(string: url), ["http", "https"].contains(link.scheme ?? "") else {
            reply(request, ["error": "No stream for this track."])
            return
        }
        var req = URLRequest(url: link)
        req.setValue("bytes=0-", forHTTPHeaderField: "Range")
        req.setValue(Self.userAgent, forHTTPHeaderField: "User-Agent")
        req.timeoutInterval = 180

        let target = file(id)
        URLSession.shared.downloadTask(with: req) { [weak self] temp, response, error in
            guard let self else { return }
            guard let temp, error == nil else {
                self.reply(request, ["error": error?.localizedDescription ?? "The download failed."])
                return
            }
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            guard status == 200 || status == 206 else {
                try? FileManager.default.removeItem(at: temp)
                self.reply(request, ["error": "YouTube refused the download (HTTP \(status))."])
                return
            }
            do {
                try? FileManager.default.removeItem(at: target)
                try FileManager.default.moveItem(at: temp, to: target)
                let bytes = self.size(target)
                guard bytes > 0 else {
                    self.reply(request, ["error": "The download was empty."])
                    return
                }
                // YouTube's audio streams carry silence past the song. Remember where it really ends, then cut it,
                // so the file is the length of the track and the seek bar agrees with it.
                self.remember(id: id, seconds: seconds)
                self.trim(target, to: seconds) {
                    self.reply(request, ["path": target.path, "bytes": self.size(target)])
                }
            } catch {
                self.reply(request, ["error": error.localizedDescription])
            }
        }.resume()
    }

    // MARK: - How long the track really is

    /// The length of the song, written beside the audio so playback knows where to stop even before it looks.
    private func remember(id: String, seconds: Double) {
        guard seconds > 0 else { return }
        let sidecar = directory.appendingPathComponent("\(Self.safeId(id)).json")
        let payload = ["duration": seconds]
        guard let data = try? JSONSerialization.data(withJSONObject: payload) else { return }
        try? data.write(to: sidecar, options: .atomic)
    }

    /// The remembered length of a downloaded track, for a file URL inside our folder.
    static func storedDuration(for url: URL) -> Double? {
        guard url.isFileURL else { return nil }
        let sidecar = url.deletingPathExtension().appendingPathExtension("json")
        guard let data = try? Data(contentsOf: sidecar),
              let object = try? JSONSerialization.jsonObject(with: data),
              let parsed = object as? [String: Any],
              let seconds = parsed["duration"] as? Double,
              seconds > 0
        else { return nil }
        return seconds
    }

    /// Cuts everything past `seconds`. Stream-copied (no re-encode, no quality loss), and skipped when the file is
    /// already the right length or the export fails — the sidecar above still stops playback in the right place.
    private func trim(_ url: URL, to seconds: Double, completion: @escaping () -> Void) {
        guard seconds > 0 else {
            completion()
            return
        }
        let asset = AVURLAsset(url: url)
        let measured = CMTimeGetSeconds(asset.duration)
        guard measured.isFinite, measured > seconds + 1 else {
            completion()
            return
        }
        guard let export = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetPassthrough) else {
            completion()
            return
        }
        let out = url.deletingPathExtension().appendingPathExtension("trim.m4a")
        try? FileManager.default.removeItem(at: out)
        export.outputURL = out
        export.outputFileType = .m4a
        export.timeRange = CMTimeRange(start: .zero, duration: CMTime(seconds: seconds, preferredTimescale: 600))
        export.exportAsynchronously {
            if export.status == .completed, self.size(out) > 0 {
                try? FileManager.default.removeItem(at: url)
                try? FileManager.default.moveItem(at: out, to: url)
            } else {
                try? FileManager.default.removeItem(at: out)
            }
            completion()
        }
    }

    private func reply(_ request: Int, _ payload: [String: Any]) {
        guard let json = try? JSONSerialization.data(withJSONObject: payload),
              let text = String(data: json, encoding: .utf8)
        else { return }
        DispatchQueue.main.async { [weak self] in
            self?.webView?.evaluateJavaScript("window.__musikeOffline && window.__musikeOffline(\(request), \(text))")
        }
    }
}
