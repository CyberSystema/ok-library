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
  /// The second half of the sync cursor. See `pullChanges`: `updated_at` is not
  /// unique in this catalogue, so the record id breaks the tie.
  String _lastSyncCursorId = '';

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

    // Page until the server has nothing left. This used to fetch ONE page and
    // stop, so a first sync received 1,000 of 12,555 records and every later sync
    // resumed from a cursor that had already skipped the rest. Two separate
    // reasons the local copy was silently incomplete; both are fixed here.
    //
    // The cursor comes back from the server rather than being derived from the
    // last book's `updatedAt`, because the server's cursor is the (timestamp, id)
    // pair that makes the next page exact. Deriving it here from `updatedAt` alone
    // is what dropped every record sharing the last one's millisecond.
    var pages = 0;
    while (pages < 200) {
      final page = await apiClient.pullChanges(
        token: token,
        since: _lastSyncCursor,
        sinceId: _lastSyncCursorId,
      );
      pages++;
      if (page.books.isEmpty) break;
      await localDb.upsertBooks(page.books);
      final done = page.cursor == _lastSyncCursor && page.cursorId == _lastSyncCursorId;
      _lastSyncCursor = page.cursor;
      _lastSyncCursorId = page.cursorId;
      if (done) break; // the server could not advance; stop rather than loop
    }

    // Surface rejected mutations (after pulls have run) so they aren't lost
    // silently. app_state.synchronize maps this to a user-visible message.
    if (rejected.isNotEmpty) {
      throw Exception('Some offline changes could not be applied and were dropped: ${rejected.join('; ')}');
    }
  }
}
