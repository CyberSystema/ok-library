# OK Library Mobile (Flutter)

## Purpose
Cross-platform native app for iOS and Android with offline queue sync, QR/barcode scanning, and staff workflows.

## Requirements
- Flutter SDK 3.4+
- Xcode for iOS build
- Android Studio for Android build

## Setup
1. cd apps/mobile
2. flutter pub get
3. flutter run --dart-define=API_BASE=http://127.0.0.1:8787

## Build
- iOS: flutter build ios --release --dart-define=API_BASE=https://your-api-domain
- Android: flutter build apk --release --dart-define=API_BASE=https://your-api-domain

## Notes
- Uses local SQLite cache and sync queue.
- If API is unreachable, reads cached data and retries sync later.
- Scanner supports QR and barcode via mobile_scanner plugin.
