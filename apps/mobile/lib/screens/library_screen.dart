import 'package:flutter/material.dart';

import '../models/book.dart';

class LibraryScreen extends StatelessWidget {
  const LibraryScreen({
    required this.books,
    required this.loading,
    required this.error,
    required this.onRefresh,
    required this.onSearch,
    required this.onScan,
    required this.onBorrow,
    required this.onSync,
    super.key,
  });

  final List<Book> books;
  final bool loading;
  final String? error;
  // Returns a Future so RefreshIndicator can wait for it.
  final Future<void> Function() onRefresh;
  final ValueChanged<String> onSearch;
  final VoidCallback onScan;
  final void Function(Book book) onBorrow;
  final VoidCallback onSync;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Library Inventory'),
        actions: [
          IconButton(onPressed: onSync, icon: const Icon(Icons.sync)),
          IconButton(onPressed: onScan, icon: const Icon(Icons.qr_code_scanner)),
        ],
      ),
      body: RefreshIndicator(
        // RefreshIndicator's contract is to keep the spinner visible until
        // the returned Future completes; the previous version returned
        // immediately so the spinner vanished before refreshBooks() finished.
        onRefresh: onRefresh,
        child: ListView(
          padding: const EdgeInsets.all(14),
          children: [
            TextField(
              onChanged: onSearch,
              decoration: const InputDecoration(
                labelText: 'Search title, author, isbn',
                prefixIcon: Icon(Icons.search),
              ),
            ),
            const SizedBox(height: 12),
            if (error != null)
              Text(
                error!,
                style: const TextStyle(color: Colors.red),
              ),
            if (loading) const LinearProgressIndicator(),
            const SizedBox(height: 8),
            ...books.map(
              (book) => Card(
                child: ListTile(
                  title: Text(book.title.trim().isEmpty || book.title == '(Untitled)' ? '(Untitled)' : book.title),
                  subtitle: Text('${book.author.trim().isEmpty || book.author == '(Unknown)' ? '(Unknown author)' : book.author}\n${book.roomCode ?? '-'} / ${book.shelfCode ?? '-'}'),
                  trailing: FilledButton.tonal(
                    onPressed: () => onBorrow(book),
                    child: const Text('Borrow'),
                  ),
                  isThreeLine: true,
                ),
              ),
            )
          ],
        ),
      ),
    );
  }
}
