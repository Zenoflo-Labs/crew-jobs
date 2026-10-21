import { Invalid } from './http.ts';
import type { Queryable } from './db.ts';

export const JOB_STATUSES = ['scheduled', 'in_progress', 'done'];
const JOB_FIELDS = ['customer_name', 'address', 'description', 'status', 'scheduled_for', 'assigned_user_id'];

export interface JobInput {
  customer_name?: string;
  address?: string;
  description?: string;
  status?: string;
  scheduled_for?: string;
  assigned_user_id?: number | null;
}

function text(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== 'string') throw new Invalid(field, 'must_be_text');
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) throw new Invalid(field, `length_${min}_to_${max}`);
  return trimmed;
}

function date(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Invalid(field, 'must_be_yyyy_mm_dd');
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Invalid(field, 'not_a_real_date');
  }
  return value;
}

// Checks every field on the server. The browser's checks are only for convenience.
// tenant_id and other server-owned values are refused, never trusted.
export async function jobInput(db: Queryable, tenantId: number, body: unknown, creating: boolean): Promise<JobInput> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Invalid('body', 'must_be_object');
  const data = body as Record<string, unknown>;
  const unknown = Object.keys(data).find(key => !JOB_FIELDS.includes(key));
  if (unknown) throw new Invalid(unknown, 'not_allowed');
  if (!creating && Object.keys(data).length === 0) throw new Invalid('body', 'nothing_to_change');
  const input: JobInput = {};
  if (creating || 'customer_name' in data) input.customer_name = text(data.customer_name, 'customer_name', 1, 100);
  if (creating || 'address' in data) input.address = text(data.address, 'address', 1, 200);
  if ('description' in data) input.description = text(data.description, 'description', 0, 1000);
  if (creating || 'scheduled_for' in data) input.scheduled_for = date(data.scheduled_for, 'scheduled_for');
  if ('status' in data) {
    if (typeof data.status !== 'string' || !JOB_STATUSES.includes(data.status)) throw new Invalid('status', 'unknown_status');
    input.status = data.status;
  }
  if ('assigned_user_id' in data) {
    const id = data.assigned_user_id;
    if (id !== null && !Number.isInteger(id)) throw new Invalid('assigned_user_id', 'must_be_whole_number_or_null');
    if (id !== null) {
      const rows = await db.query('SELECT 1 FROM users WHERE id = $1 AND tenant_id = $2 AND disabled_at IS NULL', [id, tenantId]);
      if (rows.length === 0) throw new Invalid('assigned_user_id', 'no_such_user');
    }
    input.assigned_user_id = id as number | null;
  }
  return input;
}

export function staffEmail(body: unknown): string {
  const email = text((body as Record<string, unknown> | null)?.email, 'email', 3, 200).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Invalid('email', 'not_an_email');
  return email;
}

// Positive whole numbers only; anything else is treated as "no such record".
export function idParam(value: string): number | undefined {
  return /^[1-9]\d{0,9}$/.test(value) && Number(value) <= 2147483647 ? Number(value) : undefined;
}
