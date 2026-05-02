import 'dart:math';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Wraps [FlutterSecureStorage] with the iOS / Android options we want by
/// default. Backs the JWT (so a returning user is still signed in after a cold
/// start) and the per-install SQLCipher passphrase (so the encrypted DB key
/// never sits on disk in plaintext).
class SecureStore {
  SecureStore._();

  static const _storage = FlutterSecureStorage(
    aOptions: AndroidOptions(encryptedSharedPreferences: true),
    iOptions: IOSOptions(
      accessibility: KeychainAccessibility.first_unlock_this_device,
      // Tie the keychain entry to this device install only. Restoring a
      // backup onto a fresh device should NOT recover the staff JWT.
      synchronizable: false,
    ),
  );

  static const _kToken = 'auth.token';
  static const _kDbKey = 'db.sqlcipher.key';

  static Future<String?> readToken() => _storage.read(key: _kToken);

  static Future<void> writeToken(String token) =>
      _storage.write(key: _kToken, value: token);

  static Future<void> deleteToken() => _storage.delete(key: _kToken);

  /// Lazily generates and persists a 256-bit SQLCipher passphrase. The first
  /// call on a fresh install creates a random key; subsequent calls return
  /// the same value so the existing DB stays decryptable across restarts.
  static Future<String> getOrCreateDbKey() async {
    final existing = await _storage.read(key: _kDbKey);
    if (existing != null && existing.isNotEmpty) return existing;
    final key = _generateRandomHex(32);
    await _storage.write(key: _kDbKey, value: key);
    return key;
  }

  static String _generateRandomHex(int bytes) {
    // Random.secure() draws from the platform CSPRNG; we hex-encode the bytes
    // so the value round-trips cleanly through `flutter_secure_storage` (which
    // is a string store) and SQLCipher's PRAGMA key.
    final rand = Random.secure();
    final buffer = StringBuffer();
    for (var i = 0; i < bytes; i += 1) {
      buffer.write(rand.nextInt(256).toRadixString(16).padLeft(2, '0'));
    }
    return buffer.toString();
  }
}
