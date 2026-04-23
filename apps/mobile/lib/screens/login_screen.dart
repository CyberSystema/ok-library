import 'package:flutter/material.dart';

class LoginScreen extends StatelessWidget {
  const LoginScreen({
    required this.loading,
    required this.onLogin,
    super.key,
  });

  final bool loading;
  final void Function(String username, String password) onLogin;

  @override
  Widget build(BuildContext context) {
    final usernameController = TextEditingController(text: 'admin');
    final passwordController = TextEditingController();

    return Scaffold(
      body: SafeArea(
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 440),
            child: Card(
              margin: const EdgeInsets.all(20),
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const Text('OK Library Organizer', style: TextStyle(fontSize: 22, fontWeight: FontWeight.w700)),
                    const SizedBox(height: 6),
                    const Text('Staff sign-in'),
                    const SizedBox(height: 18),
                    TextField(
                      controller: usernameController,
                      decoration: const InputDecoration(labelText: 'Username'),
                    ),
                    const SizedBox(height: 10),
                    TextField(
                      controller: passwordController,
                      obscureText: true,
                      decoration: const InputDecoration(labelText: 'Password'),
                    ),
                    const SizedBox(height: 14),
                    FilledButton(
                      onPressed: loading
                          ? null
                          : () {
                              onLogin(usernameController.text, passwordController.text);
                            },
                      child: Text(loading ? 'Signing in...' : 'Sign In'),
                    )
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
