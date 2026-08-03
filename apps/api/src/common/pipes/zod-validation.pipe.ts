import { ArgumentMetadata, PipeTransform } from '@nestjs/common';
import { ZodError, ZodSchema } from 'zod';
import { ValidationError } from '../../errors';

/**
 * Validates and *replaces* the incoming value with the schema's output.
 *
 * The replacement is the important half. `emailSchema` lower-cases and trims,
 * so the handler receives the normalised value and cannot accidentally use the
 * raw one. It is also the defence against mass assignment: Zod objects strip
 * unknown keys by default, so a request that smuggles `{ role: 'owner' }` into
 * a profile update loses it here, before any service sees it.
 */
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodSchema<T>) {}

  transform(value: unknown, _metadata: ArgumentMetadata): T {
    try {
      return this.schema.parse(value);
    } catch (error: unknown) {
      if (error instanceof ZodError) {
        throw new ValidationError(
          'The request failed validation',
          error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        );
      }
      throw error;
    }
  }
}

/** Reads better at the call site: `@Body(zodBody(loginSchema))`. */
export function zodBody<T>(schema: ZodSchema<T>): ZodValidationPipe<T> {
  return new ZodValidationPipe(schema);
}

/**
 * Same pipe, named for the other call site: `@Query(zodQuery(listQuerySchema))`.
 * Query strings arrive as strings, which is why the pagination schema coerces
 * numbers — `?page=2` must become `2`, not fail validation.
 */
export function zodQuery<T>(schema: ZodSchema<T>): ZodValidationPipe<T> {
  return new ZodValidationPipe(schema);
}
