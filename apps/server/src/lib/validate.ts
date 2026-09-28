import type { Request } from 'express';
import type { z } from 'zod';
import { AppError } from '@payops/core';

/** Parse and type request parts with shared Zod schemas. Throws ZodError, mapped to 422. */
export const parseQuery = <S extends z.ZodType>(schema: S, req: Request): z.infer<S> => schema.parse(req.query);
export const parseBody = <S extends z.ZodType>(schema: S, req: Request): z.infer<S> => schema.parse(req.body);

const PARAM = /^[A-Za-z0-9_-]{1,64}$/;

/** A path id like `case_abc123`. Anything else is a 400, never reaches the database. */
export const param = (req: Request, name: string): string => {
  const v = req.params[name];
  if (typeof v !== 'string' || !PARAM.test(v)) throw new AppError('BAD_REQUEST', `Invalid ${name}`);
  return v;
};
