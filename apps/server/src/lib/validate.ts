import type { Request } from 'express';
import type { z } from 'zod';

/** Parse and type request parts with shared Zod schemas. Throws ZodError, mapped to 422. */
export const parseQuery = <S extends z.ZodType>(schema: S, req: Request): z.infer<S> => schema.parse(req.query);
export const parseBody = <S extends z.ZodType>(schema: S, req: Request): z.infer<S> => schema.parse(req.body);
export const param = (req: Request, name: string): string => {
  const v = req.params[name];
  if (typeof v !== 'string' || v.length === 0 || v.length > 64) throw Object.assign(new Error('bad param'), { status: 400 });
  return v;
};
