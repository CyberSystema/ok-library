import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

class ScannerScreen extends StatelessWidget {
  const ScannerScreen({required this.onDetected, super.key});

  final ValueChanged<String> onDetected;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Scan QR / Barcode')),
      body: MobileScanner(
        onDetect: (capture) {
          final code = capture.barcodes.isNotEmpty ? capture.barcodes.first.rawValue : null;
          if (code != null && code.isNotEmpty) {
            onDetected(code);
            Navigator.of(context).pop();
          }
        },
      ),
    );
  }
}
