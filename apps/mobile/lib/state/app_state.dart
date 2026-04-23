import 'package:flutter/foundation.dart';

import '../models/book.dart';
import '../services/api_client.dart';
import '../services/local_db.dart';
import '../services/sync_service.dart';

class AppState extends ChangeNotifier {
  AppState()
      : _apiClient = ApiClient(baseUrl: const String.fromEnvironment('API_BASE', defaultValue: 'http://127.0.0.1:8787')),
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

  Future<void> login(String username, String password) async {
    loading = true;
    error = null;
    notifyListeners();

    try {
      token = await _apiClient.login(username: username, password: password);
      await refreshBooks();
      await synchronize();
    } catch (e) {
      error = e.toString();
    } finally {
      loading = false;
      notifyListeners();
    }
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
      error = e.toString();
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
      error = e.toString();
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
}
