import * as matrixService from '../services/matrix.service.js';

export const linkUnits = async (request, reply) => {
  const result = matrixService.linkUnits(request.body);
  return reply.code(201).send(result);
};

export const unlinkUnits = async (request, reply) => {
  const deleted = matrixService.unlinkUnits(request.body);
  if (!deleted) {
    throw new Error('Matrix entry not found');
  }
  return reply.code(204).send();
};

export const getTargets = async (request, reply) => {
  const { namespace, source, verb } = request.query;
  if (!namespace || !source || !verb) {
    throw new Error('Missing required query parameters: namespace, source, verb');
  }
  const result = matrixService.getTargets(namespace, source, verb);
  return reply.send(result);
};

export const getMatrixEntry = async (request, reply) => {
  const { namespace, source, verb, target } = request.query;
  if (!namespace || !source || !verb || !target) {
    throw new Error('Missing required query parameters: namespace, source, verb, target');
  }
  const result = matrixService.getMatrixEntry(namespace, source, verb, target);
  if (!result) {
    throw new Error('Matrix entry not found');
  }
  return reply.send(result);
};

export const hasMatrixEntry = async (request, reply) => {
  const { namespace, source, verb, target } = request.query;
  if (!namespace || !source || !verb || !target) {
    throw new Error('Missing required query parameters: namespace, source, verb, target');
  }
  const exists = matrixService.hasMatrixEntry(namespace, source, verb, target);
  return reply.send({ exists });
};

export const getMatrixSegment = async (request, reply) => {
  const { prefix } = request.query;
  if (!prefix) {
    throw new Error('Missing required query parameter: prefix');
  }
  const result = matrixService.getMatrixSegment(prefix);
  return reply.send(result);
};
