import { engine } from '../dal/db.js';
import {
  RegisterNamespaceSchema,
  NamespaceSchema,
  ListNamespacesResponseSchema
} from '../models/namespace.model.js';

/**
 * Register a new namespace
 * @throws Error if namespace already exists
 */
export const registerNamespace = (input) => {
  const { id, metadata = {} } = RegisterNamespaceSchema.parse(input);
  engine.register_namespace(id, metadata);
  return { id, metadata };
};

/**
 * Check if a namespace exists
 */
export const namespaceExists = (namespaceId) => {
  return engine.namespace_exists(namespaceId);
};

/**
 * Get namespace by ID
 * @returns Namespace object or null if not found
 */
export const getNamespace = (namespaceId) => {
  const metadata = engine.get_namespace(namespaceId);
  if (metadata === null) {
    return null;
  }
  return NamespaceSchema.parse({ id: namespaceId, metadata });
};

/**
 * List all namespaces
 */
export const listNamespaces = () => {
  const raw = engine.list_namespaces();
  return ListNamespacesResponseSchema.parse(raw);
};

/**
 * Delete a namespace
 * @returns true if deleted, false if not found
 */
export const deleteNamespace = (namespaceId) => {
  return engine.delete_namespace(namespaceId);
};
