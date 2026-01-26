import * as namespaceService from '../services/namespace.service.js';

export const registerNamespace = async (request, reply) => {
  const result = namespaceService.registerNamespace(request.body);
  return reply.code(201).send(result);
};

export const getNamespace = async (request, reply) => {
  const { id } = request.params;
  const result = namespaceService.getNamespace(id);
  if (!result) {
    throw new Error(`Namespace '${id}' not found`);
  }
  return reply.send(result);
};

export const listNamespaces = async (request, reply) => {
  const result = namespaceService.listNamespaces();
  return reply.send(result);
};

export const deleteNamespace = async (request, reply) => {
  const { id } = request.params;
  const deleted = namespaceService.deleteNamespace(id);
  if (!deleted) {
    throw new Error(`Namespace '${id}' not found`);
  }
  return reply.code(204).send();
};
