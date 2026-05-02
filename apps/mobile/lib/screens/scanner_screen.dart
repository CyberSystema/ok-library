import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

class ScannerScreen extends StatefulWidget {
  const ScannerScreen({required this.onDetected, super.key});

  final ValueChanged<String> onDetected;

  @override
  State<ScannerScreen> createState() => _ScannerScreenState();
}

class _ScannerScreenState extends State<ScannerScreen> {
  // Mobile_scanner can fire onDetect dozens of times per second on a stable
  // QR; without this guard we'd pop the route mid-pop and re-trigger the
  // resolve callback, leading to dropped frames and double API calls.
  bool _handled = false;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Scan QR / Barcode')),
      body: MobileScanner(
        onDetect: (capture) {
          if (_handled) return;
          if (capture.barcodes.isEmpty) return;
          final code = capture.barcodes.first.rawValue;
          if (code == null || code.isEmpty) return;
          _handled = true;
          widget.onDetected(code);
          if (mounted) {
            Navigator.of(context).pop();
          }
        },
      ),
    );
  }
}
