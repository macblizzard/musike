# musike — deployment notes (casa)

Personal YouTube-music player: Fastify API + React PWA that proxies YouTube audio/video
through a server-side HTTP Range proxy (no ads). Upstream: <https://github.com/Ernani1234/musike>.

- **URL:** <https://musike.example.com> (tailnet-only: Cloudflare A record → `203.0.113.47`, `proxied=false`, AdGuard rewrite)
- **Local:** <http://192.0.2.129:4180> / <http://203.0.113.47:4180>
- **Stack:** `/opt/stacks/musike` — upstream git clone + locally added `Dockerfile`, `docker-compose.yml`, `.dockerignore`
- **Image:** `musike:latest` (built locally, `node:22-bookworm-slim` + FFmpeg 5.1 + Deno 2 + standalone yt-dlp)

## Why it is not behind the Cloudflare proxy

Upstream README warns not to host it publicly (YouTube ToS + it's a stream extractor), and
YouTube bot-checks datacenter IPs. Casa's residential IP resolves streams fine; keep it on the
tailnet.

## Layout

| Path | Contents |
|---|---|
| `data/library.json` | playlists, favourites, history (server-written, atomic) |
| `cache/*.mp4` | downloaded/merged HD video, LRU, capped at `MUSIKE_CACHE_MAX_MB=1024` |
| `cache/*.m4a` | progressive remux of played audio (see below), LRU, capped at `MUSIKE_AUDIO_CACHE_MAX_MB=768` |
| `Dockerfile` | two-stage: pnpm build of `web` → runtime with tools + whole `/app` tree |
| `docker-compose.yml` | port 4180, healthcheck on `/api/health`, `restart: unless-stopped` |

Only the `server` + `web` workspace packages are installed — `desktop` (Electron) is filtered out
of `pnpm install` so the image stays ~1.1 GB.

## Local patches (committed on `main`, not upstream)

The clone carries local fixes on top of upstream; they are committed so a stray `git checkout`/pull
cannot silently drop them. Re-check them after any upstream update:

| File | Change |
|---|---|
| `server/src/stream.ts` | always range upstream (throttle), suffix-range translation, multi-range trimmed, `200` for range-less clients |
| `server/src/ytdlp.ts` | `progressiveAudio()` + `pruneAudioCache()` — FFmpeg remux of YouTube's fragmented audio |
| `server/src/app.ts` | `/api/stream/:id/audio` serves the progressive remux, falls back to streaming |
| `server/src/config.ts` | `MUSIKE_AUDIO_CACHE_MAX_MB`, `MUSIKE_AUDIO_MAX_SECONDS` |
| `web/src/player/player.ts` | next-track prefetch (blob), pre-`ended` hand-off for backgrounded iOS, offline blob preferred in `load()` |
| `web/src/components/Artwork.tsx` | treat YouTube's 120x120 stand-in thumbnail as a failure so the fallback is used |
| `web/src/lib/offline.ts` | offline store — collected audio in Cache Storage, keyed by stream URL |
| `web/src/components/OfflineButton.tsx` | keep/release a whole collection for offline play |
| `web/src/views/Collection.tsx` | the offline button on Playlists, Favorites and History |

## Audio path: progressive remux (do not "simplify" this away)

`/api/stream/:id/audio` does **not** stream YouTube's file straight through. yt-dlp's audio
(format 140) is a *fragmented* MP4: `moov` + `mvex` with an empty sample table, a `sidx`, then
`moof`/`mdat` fragments. Browsers rebuild the timeline from the fragments; **iOS/AVFoundation does
not** — it mis-reads the duration, plays the song, then sits in silence until the wrong duration
expires. On the iPhone that was heard as minutes of blank audio after every track, and it looked
like the app had stalled.

So `progressiveAudio()` downloads the resolved stream (with a byte range — see below), remuxes it
with FFmpeg, and caches the result as `cache/<id>.m4a`:

```bash
ffmpeg -y -i in -c copy -movflags +faststart -f mp4 out   # stream copy: no re-encode, no quality loss
```

The route serves that file through `serveFile()` (byte ranges, seeking intact). Every request for a
track — including the client's `bytes=0-1` probe — is answered from the same remuxed file; mixing
the fragmented source with the remux would leave the client assembling two containers. Tracks
longer than `MUSIKE_AUDIO_MAX_SECONDS` (default 1800) skip the remux and stream as before.

Verify a served file is progressive: dump its boxes and check for a real sample table (`stsz` with
entries) and **no** `mvex`. Cost is one cold pass per track (download + remux, ~1s); the app
prefetches the next track, so boundaries are already warm.

**Always send a byte `Range` upstream when proxying googlevideo.** A plain full-file GET is
throttled to roughly 32 KiB/s (a four-minute song then takes four minutes to arrive, which is also
read as "blank audio for 3-4 minutes"). Any byte range is served at line speed. With no `Range`
from the client, forward `bytes=0-` and still answer `200` with the full length (no
`content-range`). Suffix ranges (`bytes=-N`) get a `416` from googlevideo — resolve the size from a
`bytes=0-1` probe and re-ask explicitly. Multi-range (`bytes=a-b,c-d`) comes back as
`multipart/byteranges`; serve only the first range instead of relabelling that body as `audio/mp4`.

## Offline play (kept tracks)

A collection can be stored on the device: a download button sits next to Shuffle on Playlists,
Favorites and History. A kept track is read back out of Cache Storage and handed to the media
element as a blob, so playback needs no network at all and seeking is local — the element receives
the whole file rather than issuing byte-range requests. The state lives on the device; the only
server-side part is the progressive remux that every play already uses.

| Piece | Role |
|---|---|
| `web/src/lib/offline.ts` | the store — Cache Storage bucket `musike-offline`, keyed by the stream URL |
| `web/src/components/OfflineButton.tsx` | button, per-track progress, and release |
| `web/src/player/player.ts` | `load()` prefers a warmed (next track) or kept blob over the stream URL |

Sizing is estimated at about 1 MB per minute (YouTube's 128 kbps audio) and shown on the button
before anything starts, so a big collection is not a surprise. Copies are never evicted
automatically — releasing the collection deletes them. iOS caps PWA storage and can clear it under
pressure, so treat this as a cache, not an archive.

## Commands

```bash
cd /opt/stacks/musike
docker compose up -d --build          # rebuild + recreate (resets the bundled yt-dlp)
docker logs musike --tail 50
docker exec musike curl -s localhost:4180/api/system     # tool versions + update status
docker exec musike yt-dlp -U                            # update yt-dlp in place
docker exec musike curl -s -X POST localhost:4180/api/prepare/<videoId>   # stream smoke test
curl -s -o /dev/null -w "%{http_code} %{speed_download}\n" \
  -H "Range: bytes=0-" localhost:4180/api/stream/<videoId>/audio          # must be MB/s, not 32KiB/s
ls -la cache/                                                            # <id>.m4a = remux cached
```

## Troubleshooting

- **"Parou de tocar" / stream errors:** YouTube changed something → `docker exec musike yt-dlp -U`,
  or rebuild the image to pull the newest release binary.
- **Track time shows ~double on iOS and silence follows the song:** the progressive remux did not
  happen for that track. Check `docker logs musike | grep "progressive audio unavailable"` — the
  usual causes are FFmpeg missing, a cold resolve hitting the 45s timeout, or the track exceeding
  `MUSIKE_AUDIO_MAX_SECONDS`. The route falls back to streaming the fragmented file, which is
  exactly the broken case, so treat the warning as a real bug.
- **"YouTube pediu verificação anti-bot":** add `YTDLP_EXTRA_ARGS=--cookies /data/cookies.txt`
  to the compose environment and drop a Netscape-format `cookies.txt` into `./data`.
  (MeTube on the same host uses the `bgutil` PO-token provider as an alternative.)
- **HD video slow on first play:** expected — no combined SD stream, so video+audio are downloaded
  and merged with FFmpeg, then cached.
- **Audio cache filling the disk:** `cache/*.m4a` is LRU-capped at `MUSIKE_AUDIO_CACHE_MAX_MB`
  (default 768 MB, ≈190 tracks) and pruned on startup and after each remux. Note the **SD video**
  path still streams YouTube's fragmented file, so Video mode keeps the iOS duration bug.

## Rollback / removal

```bash
cd /opt/stacks/musike && docker compose down
# remove the Caddyfile block (backup at /opt/stacks/caddy/backups/<ts>/Caddyfile)
# remove the AdGuard rewrite (backup at /opt/stacks/adguard/backups/<ts>/AdGuardHome.yaml)
# delete the Cloudflare A record musike.example.com, then docker restart caddy adguard
```
