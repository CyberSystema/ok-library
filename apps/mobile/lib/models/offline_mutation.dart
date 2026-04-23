class OfflineMutation {
  final String id;
  final String operation;
  final Map<String, dynamic> payload;
  final DateTime createdAt;

  const OfflineMutation({
    required this.id,
    required this.operation,
    required this.payload,
    required this.createdAt,
  });

  Map<String, dynamic> toMap() {
    return {
      'id': id,
      'operation': operation,
      'payload': payload,
      'createdAt': createdAt.toIso8601String(),
    };
  }
}
