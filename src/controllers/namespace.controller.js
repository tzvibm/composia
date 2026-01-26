import * as namespaceService from '../services/namespace.service.js';

export const registerNamespace = async (request, reply) => {
  try {
    const result = namespaceService.registerNamespace(request.body);
    return reply.code(201).send(result);
  } catch (error) {
    if (error.name === 'ZodError') {
      return reply.code(400).send({ error: 'Validation Failed', details: error.errors });
    }
    if (error.message?.includes('already exists')) {
      return reply.code(409).send({ error: error.message });
    }
    request.log.error(error);
    return reply.code(500).send({ error: 'Internal Server Error' });
  }
};

export const getNamespace = async (request, reply) => {
  try {
    const { id } = request.params;
    const result = namespaceService.getNamespace(id);
    if (!result) {
      return reply.code(404).send({ error: `Namespace '${id}' not found` });
    }
    return reply.send(result);
  } catch (error) {
    request.log.error(error);
    return reply.code(500).send({ error: 'Internal Server Error' });
  }
};

export const listNamespaces = async (request, reply) => {
  try {
    const result = namespaceService.listNamespaces();
    return reply.send(result);
  } catch (error) {
    request.log.error(error);
    return reply.code(500).send({ error: 'Internal Server Error' });
  }
};

export const deleteNamespace = async (request, reply) => {
  try {
    const { id } = request.params;
    const deleted = namespaceService.deleteNamespace(id);
    if (!deleted) {
      return reply.code(404).send({ error: `Namespace '${id}' not found` });
    }
    return reply.code(204).send();
  } catch (error) {
    request.log.error(error);
    return reply.code(500).send({ error: 'Internal Server Error' });
  }
};
