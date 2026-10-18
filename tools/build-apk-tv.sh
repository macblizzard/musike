#!/usr/bin/env bash
# Android TV build: web bundle in TV mode -> Capacitor sync -> debug APK -> install.
set -euo pipefail
cd "$(dirname "$0")/.."
export JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@17}"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH"
TV_HOST="${TV_HOST:-192.0.2.157:5555}"

echo "== web bundle (TV mode) =="
VITE_TV=1 pnpm --filter @musike/web build:native

echo "== capacitor sync =="
(cd mobile && npx cap sync android)

echo "== gradle =="
(cd mobile/android && ./gradlew assembleDebug --console=plain | tail -5)

APK=mobile/android/app/build/outputs/apk/debug/app-debug.apk
echo "== install to $TV_HOST =="
adb connect "$TV_HOST" >/dev/null 2>&1 || true
adb -s "$TV_HOST" install -r "$APK"
adb -s "$TV_HOST" shell 'am force-stop app.musike.android; monkey -p app.musike.android -c android.intent.category.LEANBACK_LAUNCHER 1' >/dev/null 2>&1 || true
echo "done: $APK"
