import 'package:flutter/foundation.dart';

import '../models/book.dart';
import '../services/api_client.dart';
import '../services/local_db.dart';
import '../services/secure_store.dart';
import '../services/sync_service.dart';

class AppState extends ChangeNotifier {
  AppState()
      : _apiClient = ApiClient(
          baseUrl: const String.fromEnvironment(
            'API_BASE',
            // Default to the production API rather than localhost. Local
            // development can override via `--dart-define=API_BASE=...`. Using
            // a localhost default in release builds left the app pointing at
            // an unreachable host on real devices.
            defaultValue: 'https://ok-library-api.leontg.workers.dev',
          ),
        ),
        _localDb = LocalDb() {
    _syncService = SyncService(localDb: _localDb, apiClient: _apiClient);
  }

  final ApiClient _apiClient;
  final LocalDb _localDb;
  late final SyncService _syncService;

  String? token;
  bool loading = false;
  String? error;
  List<Book> books = const [];

  /// Restores a previously-saved JWT from secure storage so a returning user
  /// stays signed in across cold starts. Caller should `await` this before
  /// the first widget build to avoid a flicker through the login screen.
  Future<void> restoreSession() async {
    final saved = await SecureStore.readToken();
    if (saved == null || saved.isEmpty) return;
    token = saved;
    notifyListeners();
    await refreshBooks();
  }

  Future<void> login(String username, String password) async {
    loading = true;
    error = null;
    notifyListeners();

    try {
      final issued = await _apiClient.login(username: username, password: password);
      token = issued;
      await SecureStore.writeToken(issued);
      await refreshBooks();
      await synchronize();
    } catch (e) {
      error = _friendly(e);
    } finally {
      loading = false;
      notifyListeners();
    }
  }

  Future<void> logout() async {
    token = null;
    error = null;
    books = const [];
    await SecureStore.deleteToken();
    await _localDb.clear();
    notifyListeners();
  }

  Future<void> refreshBooks({String query = ''}) async {
    if (token == null) return;

    loading = true;
    error = null;
    notifyListeners();

    try {
      final remote = await _apiClient.fetchBooks(token: token!, query: query);
      await _localDb.upsertBooks(remote);
      books = await _localDb.listBooks(query: query);
    } catch (_) {
      // Offline / API failure: fall back to whatever is cached locally so the
      // user can still browse and queue mutations. We deliberately don't
      // surface this as a user-visible error during refresh.
      books = await _localDb.listBooks(query: query);
    } finally {
      loading = false;
      notifyListeners();
    }
  }

  Future<void> synchronize() async {
    if (token == null) return;

    try {
      await _syncService.sync(token!);
      books = await _localDb.listBooks();
      notifyListeners();
    } catch (e) {
      error = _friendly(e);
      notifyListeners();
    }
  }

  Future<void> resolveScan(String code) async {
    if (token == null) return;

    try {
      final book = await _apiClient.resolveScan(token: token!, code: code);
      await _localDb.upsertBooks([book]);
      books = await _localDb.listBooks();
      notifyListeners();
    } catch (e) {
      error = _friendly(e);
      notifyListeners();
    }
  }

  Future<void> queueCreateBook(Map<String, dynamic> payload) async {
    await _syncService.enqueueCreateBook(payload);
    await synchronize();
  }

  Future<void> queueBorrowBook(String id, Map<String, dynamic> payload) async {
    await _syncService.enqueueBorrowBook(id: id, payload: payload);
    await synchronize();
  }

  /// Maps low-level errors (HTTP, JSON, socket) to short user-facing strings
  /// so the UI never surfaces stack traces or internal exception types.
  static String _friendly(Object e) {
    final msg = e.toString();
    if (msg.contains('SocketException') || msg.contains('Failed host lookup')) {
      return 'No connection. Working from local data.';
    }
    if (msg.contains('Login failed')) {
      return 'Sign-in failed. Check your username and password.';
    }
    if (msg.contains('Sync push')) {
      return 'Could not sync changes. They are saved locally and will retry.';
    }
    if (msg.contains('Fetch books')) {
      return 'Could not refresh the catalogue.';
    }
    return 'Something went wrong. Please try again.';
  }
}
