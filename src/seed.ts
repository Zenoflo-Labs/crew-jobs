import { hashPassword } from './auth.ts';
import type { Db } from './db.ts';

// Made-up businesses, people and amounts. Never put real customer data here.
const TENANTS = [
  {
    name: 'Bright Plumbing',
    users: [['owner@brightplumbing.example', 'owner'], ['staff@brightplumbing.example', 'staff']],
    jobs: [
      ['TEST Ada Lane', '12 Example Street, Testville', 'Leaking kitchen tap', 'done', '2026-10-05', 18500],
      ['TEST Ben Ortiz', '4 Sample Road, Testville', 'Replace water heater', 'done', '2026-10-09', 142000],
      ['TEST Cara Ng', '77 Placeholder Ave, Testville', 'Blocked shower drain', 'in_progress', '2026-10-21', 9500],
      ['TEST Dev Patel', '3 Demo Close, Testville', 'Install outdoor tap', 'scheduled', '2026-10-24', null],
      ['TEST Ema Brooks', '19 Mock Lane, Testville', 'Toilet keeps running', 'scheduled', '2026-10-28', null],
      ['TEST Finn Hale', '8 Fixture Court, Testville', 'Annual boiler check', 'scheduled', '2026-11-03', null],
    ],
  },
  {
    name: 'Green Lawn Care',
    users: [['owner@greenlawn.example', 'owner'], ['staff@greenlawn.example', 'staff']],
    jobs: [
      ['TEST Gus Rivera', '5 Sample Road, Testville', 'Weekly mow', 'done', '2026-10-07', 6000],
      ['TEST Hana Sato', '21 Example Street, Testville', 'Hedge trim', 'done', '2026-10-12', 11000],
      ['TEST Ivo Kral', '60 Placeholder Ave, Testville', 'Leaf clean-up', 'scheduled', '2026-10-26', null],
      ['TEST Jo Adams', '2 Demo Close, Testville', 'Lawn feed', 'scheduled', '2026-11-01', null],
    ],
  },
] as const;

export async function seedIfEmpty(db: Db, password: string): Promise<boolean> {
  const [{ count }] = await db.query('SELECT count(*) AS count FROM tenants');
  if (count > 0) return false;
  const passwordHash = await hashPassword(password);
  await db.transaction(async tx => {
    for (const tenant of TENANTS) {
      const [{ id: tenantId }] = await tx.query('INSERT INTO tenants (name) VALUES ($1) RETURNING id', [tenant.name]);
      const userIds: number[] = [];
      for (const [email, role] of tenant.users) {
        const [user] = await tx.query(
          'INSERT INTO users (tenant_id, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id',
          [tenantId, email, passwordHash, role],
        );
        userIds.push(user.id);
      }
      for (const [customer, address, description, status, day, amountCents] of tenant.jobs) {
        const [job] = await tx.query(
          `INSERT INTO jobs (tenant_id, customer_name, address, description, status, scheduled_for, assigned_user_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [tenantId, customer, address, description, status, day, userIds[1]],
        );
        if (amountCents !== null) {
          await tx.query(
            `INSERT INTO invoices (tenant_id, job_id, amount_cents, status, issued_on, due_on)
             VALUES ($1, $2, $3, $4, $5::date, $5::date + 14)`,
            [tenantId, job.id, amountCents, status === 'done' ? 'sent' : 'draft', day],
          );
        }
      }
    }
  });
  return true;
}
