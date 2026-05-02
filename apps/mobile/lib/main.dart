import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import 'models/book.dart';
import 'screens/library_screen.dart';
import 'screens/login_screen.dart';
import 'screens/scanner_screen.dart';
import 'state/app_state.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const OkLibraryApp());
}

class OkLibraryApp extends StatefulWidget {
  const OkLibraryApp({super.key});

  @override
  State<OkLibraryApp> createState() => _OkLibraryAppState();
}

class _OkLibraryAppState extends State<OkLibraryApp> {
  final appState = AppState();

  @override
  void initState() {
    super.initState();
    // Best-effort: pull the saved JWT from the keychain. If there isn't one,
    // we render the login screen as before. We don't await before runApp()
    // because the boot path should never block on a network call.
    appState.restoreSession();
  }

  @override
  void dispose() {
    appState.dispose();
    super.dispose();
  }

  late final GoRouter _router = GoRouter(
    routes: [
      GoRoute(
        path: '/',
        builder: (_, __) => AnimatedBuilder(
          animation: appState,
          builder: (_, __) {
            if (appState.token == null) {
              return LoginScreen(
                loading: appState.loading,
                onLogin: (username, password) => appState.login(username, password),
              );
            }

            return LibraryScreen(
              books: appState.books,
              loading: appState.loading,
              error: appState.error,
              onRefresh: () => appState.refreshBooks(),
              onSearch: (query) => appState.refreshBooks(query: query),
              onSync: () => appState.synchronize(),
              onScan: () {
                _router.push('/scan');
              },
              onBorrow: (Book book) {
                appState.queueBorrowBook(book.id, {
                  'borrowerName': 'Mobile Staff',
                  'borrowerContact': null,
                  'dueAt': DateTime.now().add(const Duration(days: 14)).toUtc().toIso8601String(),
                  'notes': 'Borrowed from mobile app',
                });
              },
            );
          },
        ),
      ),
      GoRoute(
        path: '/scan',
        builder: (_, __) => ScannerScreen(
          onDetected: (code) {
            appState.resolveScan(code);
          },
        ),
      ),
    ],
  );

  @override
  Widget build(BuildContext context) {
    return MaterialApp.router(
      title: 'OK Library Organizer',
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF1D6A57)),
        useMaterial3: true,
      ),
      routerConfig: _router,
    );
  }
}
