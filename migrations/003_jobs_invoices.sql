CREATE TABLE jobs (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id),
  customer_name TEXT NOT NULL CHECK (length(customer_name) BETWEEN 1 AND 100),
  address TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'in_progress', 'done')),
  scheduled_for DATE NOT NULL,
  assigned_user_id INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX jobs_tenant_id ON jobs(tenant_id);
CREATE TABLE invoices (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id),
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  status TEXT NOT NULL CHECK (status IN ('draft', 'sent', 'paid')),
  issued_on DATE NOT NULL,
  due_on DATE NOT NULL
);
CREATE INDEX invoices_tenant_id ON invoices(tenant_id);
