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

    // Push mutations one-at-a-time. A TRANSPORT failure (network / 401 / whole-
    // request >=400) makes pushMutations THROW, which propagates out and leaves
    // the current mutation queued for a later retry — correct for transient
    // problems. A per-mutation SERVER REJECTION, by contrast, arrives as HTTP
    // 200 with results[0].status == 'error' and is DETERMINISTIC (e.g. the book
    // is no longer available, or validation failed): re-running it every sync
    // would jam the queue forever and block the pull below. So we remove the
    // mutation from the queue either way, but a rejection is collected and
    // surfaced to the user afterwards — the original bug was dropping rejections
    // *silently*; blocking on them (a previous fix) merely traded silent loss
    // for a permanent jam whose only escape wiped the whole queue.
    final rejected = <String>[];
    for (final row in pending) {
      final id = row['id'] as String;
      final mutation = {
        'operation': row['operation'] as String,
        'payload': jsonDecode(row['payload'] as String),
        'clientMutationId': id,
        'clientTimestamp': row['created_at'] as String,
      };
      final results = await apiClient.pushMutations(token: token, mutations: [mutation]);
      final applied = results.isNotEmpty && results.first['status'] == 'success';
      await localDb.deleteMutation(id);
      if (!applied) {
        final reason = results.isNotEmpty
            ? ((results.first['result'] as Map<String, dynamic>?)?['error'] ?? 'rejected')
            : 'no result';
        rejected.add('${row['operation']}: $reason');
      }
    }

    final changes = await apiClient.pullChanges(token: token, since: _lastSyncCursor);
    if (changes.isNotEmpty) {
      await localDb.upsertBooks(changes);
      _lastSyncCursor = changes.last.updatedAt.toUtc().toIso8601String();
    }

    // Surface rejected mutations (after pulls have run) so they aren't lost
    // silently. app_state.synchronize maps this to a user-visible message.
    if (rejected.isNotEmpty) {
      throw Exception('Some offline changes could not be applied and were dropped: ${rejected.join('; ')}');
    }
  }
}
