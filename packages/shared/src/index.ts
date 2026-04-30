import { z } from 'zod';

const ReservedBookAttributeKeys = new Set([
  'title',
  'subtitle',
  'author',
  'isbn',
  'publicationYear',
  'publisher',
  'language',
  'description',
  'roomCode',
  'shelfCode',
  'acquisitionDate',
  'status',
  'tags',
  'customFields',
  'version',
  'id',
  'createdAt',
  'updatedAt',
  'deletedAt'
]);

export const BookStatusSchema = z.enum(['available', 'borrowed', 'lost', 'maintenance']);

export const ISODateTimeSchema = z
  .string()
  .min(1)
  .refine((v) => !Number.isNaN(Date.parse(v)), 'Invalid ISO datetime');

export const BookCoreSchema = z.object({
  title: z.string().min(1).max(300),
  author: z.string().min(1).max(200),
  isbn: z.string().max(32).optional().nullable(),
  publicationYear: z.number().int().min(1000).max(3000).optional().nullable(),
  publisher: z.string().max(200).optional().nullable(),
  // Catalogues frequently use multi-language tags like "EL,EN,FR" so we keep
  // the field free-form text rather than enumerated.
  language: z.string().max(120).optional().nullable(),
  description: z.string().max(4000).optional().nullable(),
  roomCode: z.string().max(64).optional().nullable(),
  shelfCode: z.string().max(64).optional().nullable(),
  legacyId: z.string().min(1).max(64).optional().nullable(),
  customFields: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).default({})
});

export const CreateBookSchema = BookCoreSchema.extend({
  acquisitionDate: ISODateTimeSchema.optional().nullable(),
  tags: z.array(z.string().max(50)).max(30).default([]),
  status: BookStatusSchema.default('available')
});

export const UpdateBookSchema = CreateBookSchema.partial().extend({
  version: z.number().int().min(0)
});

export const BookSchema = CreateBookSchema.extend({
  id: z.string().min(1),
  status: BookStatusSchema,
  createdAt: ISODateTimeSchema,
  updatedAt: ISODateTimeSchema,
  deletedAt: ISODateTimeSchema.nullable(),
  version: z.number().int().min(0)
});

export const BorrowBookSchema = z.object({
  // Either pick an existing borrower (preferred — gives them a profile + history)…
  borrowerId: z.string().min(1).optional().nullable(),
  // …or create one inline by passing a name (kept for friction-free workflows).
  borrowerName: z.string().min(1).max(200).optional(),
  borrowerContact: z.string().max(200).optional().nullable(),
  dueAt: ISODateTimeSchema,
  notes: z.string().max(2000).optional().nullable()
}).refine((v) => Boolean(v.borrowerId) || Boolean(v.borrowerName), {
  message: 'Either borrowerId or borrowerName must be provided.',
  path: ['borrowerName']
});

export const BorrowerSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(200),
  contact: z.string().max(200).optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
  createdAt: ISODateTimeSchema,
  updatedAt: ISODateTimeSchema
});

export const UpsertBorrowerSchema = BorrowerSchema.pick({
  name: true,
  contact: true,
  notes: true
});

export const ReturnBookSchema = z.object({
  notes: z.string().max(2000).optional().nullable()
});

export const RoomSchema = z.object({
  id: z.string().min(1),
  code: z.string().min(1).max(64),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional().nullable(),
  mapMetadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),
  createdAt: ISODateTimeSchema,
  updatedAt: ISODateTimeSchema
});

export const UpsertRoomSchema = RoomSchema.pick({
  code: true,
  name: true,
  description: true,
  mapMetadata: true
});

export const CustomFieldTypeSchema = z.enum(['text', 'number', 'boolean', 'date', 'enum']);

export const CustomFieldSchema = z.object({
  id: z.string().min(1),
  key: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_]+$/),
  label: z.string().min(1).max(200),
  type: CustomFieldTypeSchema,
  required: z.boolean(),
  enumOptions: z.array(z.string().max(100)).default([]),
  createdAt: ISODateTimeSchema,
  updatedAt: ISODateTimeSchema
});

export const UpsertCustomFieldSchema = CustomFieldSchema.pick({
  key: true,
  label: true,
  type: true,
  required: true,
  enumOptions: true
}).superRefine((value, ctx) => {
  if (ReservedBookAttributeKeys.has(value.key)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['key'],
      message: 'This key is reserved by a standard book attribute. Choose another key.'
    });
  }

  if (value.type === 'enum' && value.enumOptions.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['enumOptions'],
      message: 'Enum type requires at least one option.'
    });
  }

  if (value.type !== 'enum' && value.enumOptions.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['enumOptions'],
      message: 'Enum options are only allowed when type is enum.'
    });
  }
});

export const CodeTypeSchema = z.enum(['qr', 'barcode']);

export const GenerateCodeSchema = z.object({
  type: CodeTypeSchema,
  label: z.string().max(120).optional().nullable()
});

export const CodeAssignmentSchema = z.object({
  id: z.string().min(1),
  bookId: z.string().min(1),
  type: CodeTypeSchema,
  value: z.string().min(1),
  label: z.string().max(120).nullable(),
  active: z.boolean(),
  createdAt: ISODateTimeSchema,
  updatedAt: ISODateTimeSchema
});

export const BookFilterQuerySchema = z.object({
  q: z.string().max(200).optional(),
  qMode: z.enum(['all', 'any', 'exact']).default('all'),
  qExclude: z.string().max(200).optional(),
  partialWords: z.coerce.boolean().default(true),
  // Fuzzy is on by default: typos and accents shouldn't block librarians from
  // finding the book they're looking for. The server caps the candidate set so
  // it stays fast even at 20K rows.
  fuzzyTypos: z.coerce.boolean().default(true),
  searchFields: z.string().max(200).optional(),
  status: BookStatusSchema.optional(),
  language: z.string().max(50).optional(),
  year: z.coerce.number().int().min(1000).max(3000).optional(),
  yearMin: z.coerce.number().int().min(1000).max(3000).optional(),
  yearMax: z.coerce.number().int().min(1000).max(3000).optional(),
  roomCode: z.string().max(64).optional(),
  shelfCode: z.string().max(64).optional(),
  // Smart-list filters: each maps to a WHERE clause server-side. Composable.
  missingIsbn: z.coerce.boolean().optional(),
  missingShelf: z.coerce.boolean().optional(),
  untitled: z.coerce.boolean().optional(),
  unknownAuthor: z.coerce.boolean().optional(),
  sortBy: z.enum(['title', 'author', 'updatedAt', 'publicationYear', 'status']).default('updatedAt'),
  sortDir: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25)
});

export const SyncPushMutationSchema = z.object({
  operation: z.enum(['create_book', 'update_book', 'delete_book', 'borrow_book', 'return_book']),
  payload: z.record(z.string(), z.unknown()),
  clientMutationId: z.string().min(1),
  clientTimestamp: ISODateTimeSchema
});

export const SyncPushSchema = z.object({
  mutations: z.array(SyncPushMutationSchema).max(200)
});

export const ImportBooksSchema = z.object({
  dryRun: z.boolean().default(true),
  rows: z.array(CreateBookSchema).max(2000)
});

// Catalogue-import path is permissive: rows from a real-world XLSX often have
// blank titles, blank authors, multi-language tags, or category codes that
// look numeric. The server normalizes these — we just need to accept them.
export const CatalogImportRowSchema = z.object({
  legacyId: z.string().min(1).max(64).optional().nullable(),
  title: z.string().max(500).optional().nullable(),
  author: z.string().max(500).optional().nullable(),
  isbn: z.string().max(64).optional().nullable(),
  publicationYear: z.number().int().min(1000).max(3000).optional().nullable(),
  publisher: z.string().max(300).optional().nullable(),
  language: z.string().max(120).optional().nullable(),
  description: z.string().max(8000).optional().nullable(),
  shelfCode: z.string().max(64).optional().nullable(),
  needsReview: z.boolean().optional(),
  customFields: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).default({})
});

export const ImportCatalogSchema = z.object({
  dryRun: z.boolean().default(true),
  // Each call carries up to 1000 catalog rows; the frontend chunks the file.
  rows: z.array(CatalogImportRowSchema).max(1000)
});

export type BookStatus = z.infer<typeof BookStatusSchema>;
export type Book = z.infer<typeof BookSchema>;
export type CreateBookInput = z.infer<typeof CreateBookSchema>;
export type UpdateBookInput = z.infer<typeof UpdateBookSchema>;
export type BorrowBookInput = z.infer<typeof BorrowBookSchema>;
export type ReturnBookInput = z.infer<typeof ReturnBookSchema>;
export type Room = z.infer<typeof RoomSchema>;
export type CustomField = z.infer<typeof CustomFieldSchema>;
export type CodeAssignment = z.infer<typeof CodeAssignmentSchema>;
export type CatalogImportRow = z.infer<typeof CatalogImportRowSchema>;
export type Borrower = z.infer<typeof BorrowerSchema>;
export type UpsertBorrowerInput = z.infer<typeof UpsertBorrowerSchema>;
