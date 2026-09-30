/**
 * Shared helpers for turning Postgres errors from PostgREST into messages a
 * player can read. Every `src/lib/*` data module imports from here instead of
 * repeating the error codes.
 */
import type { PostgrestError } from '@supabase/supabase-js';

export function isPostgrestError(error: unknown): error is PostgrestError {
  return typeof error === 'object' && error !== null && 'code' in error;
}

/** A UNIQUE constraint was violated - a duplicate house name, or a player added twice. */
export const UNIQUE_VIOLATION = '23505';
/** A CHECK constraint was violated - a blank name, or the settle-guard trigger. */
export const CHECK_VIOLATION = '23514';
/** An INSERT or UPDATE was rejected by a Row Level Security policy's WITH CHECK. */
export const RLS_VIOLATION = '42501';
