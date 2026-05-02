import 'dart:convert';

import 'package:path/path.dart';
import 'package:sqflite_sqlcipher/sqflite.dart';

import '../models/book.dart';
import '../models/offline_mutation.dart';
import 'secure_store.dart';

class LocalDb {
  static const _dbName = 'ok_library_mobile.db';
  Database? _db;

  Future<Database> get database async {
    if (_db != null) {
      return _db!;
    }

    final dbPath = await getDatabasesPath();
    final path = join(dbPath, _dbName);

    // SQLCipher passphrase. The same key is reused for the lifetime of the
    // install — losing it (e.g. uninstall + reinstall) re-creates the DB,
    // which is fine because the data is server-authoritative anyway.
    final dbPassword = await SecureStore.getOrCreateDbKey();

    _db = await openDatabase(
      path,
      password: dbPassword,
      version: 1,
      onCreate: (db, _) async {
        await db.execute('''
          CREATE TABLE books (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            author TEXT NOT NULL,
            status TEXT NOT NULL,
            isbn TEXT,
            room_code TEXT,
            shelf_code TEXT,
            version INTEGER NOT NULL,
            updated_at TEXT NOT NULL
          )
        ''');

        await db.execute('''
          CREATE TABLE offline_mutations (
            id TEXT PRIMARY KEY,
            operation TEXT NOT NULL,
            payload TEXT NOT NULL,
            created_at TEXT NOT NULL
          )
        ''');

        await db.execute('CREATE INDEX idx_books_title_author ON books(title, author)');
      },
    );

    return _db!;
  }

  Future<void> upsertBooks(List<Book> books) async {
    final db = await database;
    final batch = db.batch();

    for (final book in books) {
      batch.insert(
        'books',
        {
          'id': book.id,
          'title': book.title,
          'author': book.author,
          'status': book.status,
          'isbn': book.isbn,
          'room_code': book.roomCode,
          'shelf_code': book.shelfCode,
          'version': book.version,
          'updated_at': book.updatedAt.toIso8601String(),
        },
        conflictAlgorithm: ConflictAlgorithm.replace,
      );
    }

    await batch.commit(noResult: true);
  }

  Future<List<Book>> listBooks({String query = ''}) async {
    final db = await database;
    final rows = query.isEmpty
        ? await db.query('books', orderBy: 'updated_at DESC', limit: 200)
        : await db.query(
            'books',
            where: 'title LIKE ? OR author LIKE ? OR isbn LIKE ?',
            whereArgs: ['%$query%', '%$query%', '%$query%'],
            orderBy: 'updated_at DESC',
            limit: 200,
          );

    return rows
        .map(
          (row) => Book(
            // Defensive null-safe casts — the schema declares NOT NULL on the
            // four required columns, but a partially-corrupted on-device DB
            // (e.g. from a forced kill mid-write) shouldn't crash the list.
            id: (row['id'] as String?) ?? '',
            title: (row['title'] as String?) ?? '',
            author: (row['author'] as String?) ?? '',
            status: (row['status'] as String?) ?? 'available',
            isbn: row['isbn'] as String?,
            roomCode: row['room_code'] as String?,
            shelfCode: row['shelf_code'] as String?,
            version: (row['version'] as int?) ?? 0,
            updatedAt:
                DateTime.tryParse((row['updated_at'] as String?) ?? '') ?? DateTime.now(),
          ),
        )
        .toList();
  }

  Future<void> enqueueMutation(OfflineMutation mutation) async {
    final db = await database;
    await db.insert(
      'offline_mutations',
      {
        'id': mutation.id,
        'operation': mutation.operation,
        'payload': jsonEncode(mutation.payload),
        'created_at': mutation.createdAt.toIso8601String(),
      },
      conflictAlgorithm: ConflictAlgorithm.replace,
    );
  }

  Future<List<Map<String, dynamic>>> listPendingMutations() async {
    final db = await database;
    return db.query('offline_mutations', orderBy: 'created_at ASC', limit: 200);
  }

  Future<void> deleteMutation(String id) async {
    final db = await database;
    await db.delete('offline_mutations', where: 'id = ?', whereArgs: [id]);
  }

  /// Wipes all on-device caches without dropping the encryption key. Used on
  /// logout so the next user's session starts clean.
  Future<void> clear() async {
    final db = await database;
    await db.delete('offline_mutations');
    await db.delete('books');
  }
}
