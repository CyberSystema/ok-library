import 'dart:convert';

import 'package:http/http.dart' as http;

import '../models/book.dart';

class ApiClient {
  ApiClient({required this.baseUrl});

  final String baseUrl;

  Future<String> login({required String username, required String password}) async {
    final response = await http.post(
      Uri.parse('$baseUrl/api/auth/login'),
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({'username': username, 'password': password}),
    );

    if (response.statusCode >= 400) {
      throw Exception('Login failed: ${response.body}');
    }

    final body = jsonDecode(response.body) as Map<String, dynamic>;
    return body['token'] as String;
  }

  Future<List<Book>> fetchBooks({required String token, String query = ''}) async {
    final response = await http.get(
      Uri.parse('$baseUrl/api/books?q=${Uri.encodeQueryComponent(query)}&page=1&pageSize=100'),
      headers: {'Authorization': 'Bearer $token'},
    );

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

    if (response.statusCode >= 400) {
      throw Exception('Scan resolve failed: ${response.body}');
    }

    final body = jsonDecode(response.body) as Map<String, dynamic>;
    return Book.fromJson(body['book'] as Map<String, dynamic>);
  }

  Future<void> pushMutations({required String token, required List<Map<String, dynamic>> mutations}) async {
    if (mutations.isEmpty) return;

    final response = await http.post(
      Uri.parse('$baseUrl/api/sync/push'),
      headers: {
        'Authorization': 'Bearer $token',
        'Content-Type': 'application/json',
      },
      body: jsonEncode({'mutations': mutations}),
    );

    if (response.statusCode >= 400) {
      throw Exception('Sync push failed: ${response.body}');
    }
  }

  Future<List<Book>> pullChanges({required String token, required String since}) async {
    final response = await http.get(
      Uri.parse('$baseUrl/api/sync/pull?since=${Uri.encodeQueryComponent(since)}'),
      headers: {'Authorization': 'Bearer $token'},
    );

    if (response.statusCode >= 400) {
      throw Exception('Sync pull failed: ${response.body}');
    }

    final body = jsonDecode(response.body) as Map<String, dynamic>;
    final items = (body['items'] as List<dynamic>? ?? []).cast<Map<String, dynamic>>();
    return items.map(Book.fromJson).toList();
  }
}
