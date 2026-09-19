/**
 * A result that carries either a value or a typed error, so a caller has to
 * look at `ok` before reaching for either one. Nothing here throws.
 */
export type Result<T, E> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}
