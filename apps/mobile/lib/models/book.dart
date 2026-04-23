class Book {
  final String id;
  final String title;
  final String author;
  final String status;
  final String? isbn;
  final String? roomCode;
  final String? shelfCode;
  final int version;
  final DateTime updatedAt;

  const Book({
    required this.id,
    required this.title,
    required this.author,
    required this.status,
    this.isbn,
    this.roomCode,
    this.shelfCode,
    required this.version,
    required this.updatedAt,
  });

  factory Book.fromJson(Map<String, dynamic> json) {
    return Book(
      id: json['id'] as String,
      title: json['title'] as String,
      author: json['author'] as String,
      status: json['status'] as String,
      isbn: json['isbn'] as String?,
      roomCode: json['roomCode'] as String?,
      shelfCode: json['shelfCode'] as String?,
      version: (json['version'] as num?)?.toInt() ?? 0,
      updatedAt: DateTime.tryParse(json['updatedAt'] as String? ?? '') ?? DateTime.now(),
    );
  }
}
