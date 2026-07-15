import 'dart:convert';

import 'package:http/http.dart' as http;

import '../models/book.dart';

/// Thrown when an AUTHENTICATED request returns 401 (expired/invalid session).
/// The app catches this to route back to the login screen while preserving the
/// offline mutation queue. Not thrown by login() — a 401 there is bad
/// credentials and keeps its existing 'Login failed' message.
class AuthException implements Exception {
  AuthException(this.message);
  final String message;
  @override
  String toString() => 'AuthException: $message';
}

class ApiClient {
  ApiClient({required this.baseUrl});

  final String baseUrl;

  Future<({String token, String role})> login({required String username, required String password}) async {
    final response = await http.post(
      Uri.parse('$baseUrl/api/auth/login'),
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({'username': username, 'password': password}),
    );

    if (response.statusCode >= 400) {
      throw Exception('Login failed: ${response.body}');
    }

    final body = jsonDecode(response.body) as Map<String, dynamic>;
    final user = (body['user'] as Map<String, dynamic>?) ?? const {};
    return (token: body['token'] as String, role: (user['role'] as String?) ?? 'viewer');
  }

  /// Whether the current token's role may lend/return books. Used on cold start
  /// (restored token, role unknown) to gate the Borrow action to parity with
  /// the web's canSeeCirculation.
  Future<bool> fetchCanCirculate({required String token}) async {
    final response = await http.get(
      Uri.parse('$baseUrl/api/me/permissions'),
      headers: {'Authorization': 'Bearer $token'},
    );
    if (response.statusCode == 401) throw AuthException('Session expired');
    if (response.statusCode >= 400) return false;
    final body = jsonDecode(response.body) as Map<String, dynamic>;
    final perms = (body['permissions'] as Map<String, dynamic>?) ?? const {};
    return perms['circulation'] == true;
  }

  Future<List<Book>> fetchBooks({required String token, String query = ''}) async {
    final response = await http.get(
      Uri.parse('$baseUrl/api/books?q=${Uri.encodeQueryComponent(query)}&page=1&pageSize=100'),
      headers: {'Authorization': 'Bearer $token'},
    );

    if (response.statusCode == 401) throw AuthException('Session expired');
    if (response.statusCode >= 400) {
      throw Exception('Fetch books failed: ${response.body}');
    }

    final body = jsonDecode(response.body) as Map<String, dynamic>;
    final items = (body['items'] as List<dynamic>? ?? []).cast<Map<String, dynamic>>();
    return items.map(Book.fromJson).toList();
  }

  Future<Book> resolveScan({required String token, required String code}) async {
    final response = await http.get(
      Uri.parse('$baseUrl/api/scan/${Uri.encodeComponent(code)}'),
      headers: {'Authorization': 'Bearer $token'},
    );

    if (response.statusCode == 401) throw AuthException('Session expired');
    if (response.statusCode >= 400) {
      throw Exception('Scan resolve failed: ${response.body}');
    }

    final body = jsonDecode(response.body) as Map<String, dynamic>;
    return Book.fromJson(body['book'] as Map<String, dynamic>);
  }

  /// Returns the server's per-mutation results so the caller can ACK only the
  /// mutations that actually SUCCEEDED. A whole-request failure (transport,
  /// 401, or >=400) still throws so the sync loop aborts and retries later.
  Future<List<Map<String, dynamic>>> pushMutations({required String token, required List<Map<String, dynamic>> mutations}) async {
    if (mutations.isEmpty) return const [];

    final response = await http.post(
      Uri.parse('$baseUrl/api/sync/push'),
      headers: {
        'Authorization': 'Bearer $token',
        'Content-Type': 'application/json',
      },
      body: jsonEncode({'mutations': mutations}),
    );

    if (response.statusCode == 401) throw AuthException('Session expired');
    if (response.statusCode >= 400) {
      throw Exception('Sync push failed: ${response.body}');
    }

    final body = jsonDecode(response.body) as Map<String, dynamic>;
    return (body['results'] as List<dynamic>? ?? []).cast<Map<String, dynamic>>();
  }

  Future<List<Book>> pullChanges({required String token, required String since}) async {
    final response = await http.get(
      Uri.parse('$baseUrl/api/sync/pull?since=${Uri.encodeQueryComponent(since)}'),
      headers: {'Authorization': 'Bearer $token'},
    );

    if (response.statusCode == 401) throw AuthException('Session expired');
    if (response.statusCode >= 400) {
      throw Exception('Sync pull failed: ${response.body}');
    }

    final body = jsonDecode(response.body) as Map<String, dynamic>;
    final items = (body['items'] as List<dynamic>? ?? []).cast<Map<String, dynamic>>();
    return items.map(Book.fromJson).toList();
  }
}
