import 'package:flutter/material.dart';

class LoginScreen extends StatefulWidget {
  const LoginScreen({
    required this.loading,
    required this.onLogin,
    super.key,
  });

  final bool loading;
  final void Function(String username, String password) onLogin;

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  // Owning the controllers in State (instead of building new ones every
  // `build`) prevents the leak the previous version had — every rebuild
  // allocated fresh controllers without disposing the old ones.
  final _usernameController = TextEditingController();
  final _passwordController = TextEditingController();
  final _formKey = GlobalKey<FormState>();

  @override
  void dispose() {
    _usernameController.dispose();
    _passwordController.dispose();
    super.dispose();
  }

  void _submit() {
    if (widget.loading) return;
    if (!(_formKey.currentState?.validate() ?? false)) return;
    widget.onLogin(_usernameController.text.trim(), _passwordController.text);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 440),
            child: Card(
              margin: const EdgeInsets.all(20),
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Form(
                  key: _formKey,
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      const Text(
                        'OK Library Organizer',
                        style: TextStyle(fontSize: 22, fontWeight: FontWeight.w700),
                      ),
                      const SizedBox(height: 6),
                      const Text('Staff sign-in'),
                      const SizedBox(height: 18),
                      TextFormField(
                        controller: _usernameController,
                        autofillHints: const [AutofillHints.username],
                        textInputAction: TextInputAction.next,
                        decoration: const InputDecoration(labelText: 'Username'),
                        validator: (v) =>
                            (v == null || v.trim().isEmpty) ? 'Enter your username.' : null,
                      ),
                      const SizedBox(height: 10),
                      TextFormField(
                        controller: _passwordController,
                        obscureText: true,
                        autofillHints: const [AutofillHints.password],
                        textInputAction: TextInputAction.done,
                        onFieldSubmitted: (_) => _submit(),
                        decoration: const InputDecoration(labelText: 'Password'),
                        validator: (v) =>
                            (v == null || v.isEmpty) ? 'Enter your password.' : null,
                      ),
                      const SizedBox(height: 14),
                      FilledButton(
                        onPressed: widget.loading ? null : _submit,
                        child: Text(widget.loading ? 'Signing in...' : 'Sign In'),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
