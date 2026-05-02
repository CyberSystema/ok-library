import 'dart:convert';

import 'package:uuid/uuid.dart';

import '../models/offline_mutation.dart';
import 'api_client.dart';
import 'local_db.dart';

class SyncService {
  SyncService({required this.localDb, required this.apiClient});

  final LocalDb localDb;
  final ApiClient apiClient;
  final Uuid _uuid = const Uuid();

  String _lastSyncCursor = '1970-01-01T00:00:00.000Z';

  Future<void> enqueueCreateBook(Map<String, dynamic> payload) {
    final mutation = OfflineMutation(
      id: _uuid.v4(),
      operation: 'create_book',
      payload: payload,
      createdAt: DateTime.now().toUtc(),
    );

    return localDb.enqueueMutation(mutation);
  }

  Future<void> enqueueBorrowBook({required String id, required Map<String, dynamic> payload}) {
    final mutation = OfflineMutation(
      id: _uuid.v4(),
      operation: 'borrow_book',
      payload: {'id': id, 'data': payload},
      createdAt: DateTime.now().toUtc(),
    );

    return localDb.enqueueMutation(mutation);
  }

  Future<void> sync(String token) async {
    final pending = await localDb.listPendingMutations();

    // Push mutations one-at-a-time so a server-side rejection of mutation N
    // doesn't cause us to drop the still-unsent N+1..end. Each successful
    // push is acked locally before moving on; failures abort the loop and
    // leave the offending mutation on the queue for the next attempt (or
    // for manual triage in a future "stuck mutations" UI).
    for (final row in pending) {
      final id = row['id'] as String;
      final mutation = {
        'operation': row['operation'] as String,
        'payload': jsonDecode(row['payload'] as String),
        'clientMutationId': id,
        'clientTimestamp': row['created_at'] as String,
      };
      await apiClient.pushMutations(token: token, mutations: [mutation]);
      await localDb.deleteMutation(id);
    }

    final changes = await apiClient.pullChanges(token: token, since: _lastSyncCursor);
    if (changes.isNotEmpty) {
      await localDb.upsertBooks(changes);
      _lastSyncCursor = changes.last.updatedAt.toUtc().toIso8601String();
    }
  }
}
