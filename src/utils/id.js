import crypto from 'crypto';

export const generateHash32 = (seed) => {
  const input = seed || crypto.randomBytes(16).toString('hex');
  return crypto.createHash('md5').update(input).digest('hex');
};