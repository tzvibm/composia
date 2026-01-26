import { z } from 'zod';

/**
 * Namespace ID - alphanumeric with underscores, 1-64 chars
 */
export const NamespaceId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9_]+$/, 'Namespace ID must be lowercase alphanumeric with underscores');

/**
 * Namespace metadata - arbitrary JSON object
 */
export const NamespaceMetadata = z.record(z.any()).default({});

/**
 * Register namespace request
 */
export const RegisterNamespaceSchema = z.object({
  id: NamespaceId,
  metadata: NamespaceMetadata.optional()
});

/**
 * Namespace response
 */
export const NamespaceSchema = z.object({
  id: NamespaceId,
  metadata: z.record(z.any())
});

/**
 * List namespaces response
 */
export const ListNamespacesResponseSchema = z.array(NamespaceSchema);
