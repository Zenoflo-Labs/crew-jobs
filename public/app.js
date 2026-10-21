// Crew Jobs front end: plain JavaScript, no framework.
// Every check here is for convenience only. The server checks everything again.

const main = document.getElementById('main');
let me = null;

// Builds an element. Text is always set with textContent, never as HTML.
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key in node) node[key] = value;
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child !== null && child !== undefined) node.append(child);
  }
  return node;
}

function show(...nodes) {
  main.replaceChildren(...nodes.flat().filter(node => node !== null && node !== undefined));
}

async function api(method, path, body) {
  const response = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = response.status === 204 ? null : await response.json();
  if (response.status === 401 && path !== '/api/login') {
    me = null;
    location.hash = '#/login';
  }
  return { status: response.status, data };
}

function errorText(data) {
  if (!data || !data.error) return 'Something went wrong.';
  const field = data.field ? ` (${data.field}: ${data.reason})` : '';
  return `Error: ${data.error}${field}. Request ID ${data.request_id}.`;
}

function money(cents) {
  return (cents / 100).toFixed(2);
}

function updateHeader() {
  document.getElementById('who').textContent = me ? `${me.email} (${me.role}, ${me.tenant})` : '';
  document.getElementById('signout').hidden = !me;
}

async function loginPage() {
  const message = el('p', { className: 'error' });
  const form = el('form', {
    onsubmit: async event => {
      event.preventDefault();
      const { status, data } = await api('POST', '/api/login', {
        email: form.email.value,
        password: form.password.value,
      });
      if (status !== 200) return (message.textContent = errorText(data));
      me = data;
      updateHeader();
      location.hash = '#/jobs';
    },
  },
  el('label', {}, 'Email', el('input', { name: 'email', type: 'email', autocomplete: 'username', required: true })),
  el('label', {}, 'Password', el('input', { name: 'password', type: 'password', autocomplete: 'current-password', required: true })),
  el('button', { type: 'submit' }, 'Sign in'),
  message);
  show(el('h1', {}, 'Sign in'), form, el('p', { className: 'meta' }, 'Test accounts are listed in the README. All data is made up.'));
}

async function jobsPage() {
  const { status, data } = await api('GET', '/api/jobs');
  if (status !== 200) return show(el('p', { className: 'error' }, errorText(data)));
  const owner = me.role === 'owner';
  const actions = el('div', { className: 'actions' },
    el('a', { className: 'button', href: '#/jobs/new' }, 'New job'),
    owner ? el('a', { className: 'button secondary', href: '/api/export/jobs.csv' }, 'Export CSV') : null,
    owner ? el('a', { className: 'button secondary', href: '#/staff' }, 'Staff') : null);
  const cards = data.jobs.map(job => el('div', { className: 'card' },
    el('a', { href: `#/jobs/${job.id}` },
      el('strong', {}, job.customer_name), ' ',
      el('span', { className: 'status' }, job.status),
      el('div', { className: 'meta' }, `${job.scheduled_for} · ${job.description || 'No description'}`)),
    job.invoice_id ? el('a', { className: 'meta', href: `#/invoices/${job.invoice_id}` }, 'View invoice') : null));
  show(el('h1', {}, 'Jobs'), actions, cards.length ? cards : el('p', {}, 'No jobs yet.'));
}

function jobForm(job, onSave) {
  const message = el('p', { className: 'error' });
  const status = el('select', { name: 'status' },
    ['scheduled', 'in_progress', 'done'].map(value => el('option', { value, selected: job.status === value }, value)));
  const form = el('form', {
    onsubmit: async event => {
      event.preventDefault();
      const { status: code, data } = await onSave({
        customer_name: form.customer_name.value,
        address: form.address.value,
        description: form.description.value,
        status: form.status.value,
        scheduled_for: form.scheduled_for.value,
      });
      if (code === 200 || code === 201) location.hash = `#/jobs/${data.job.id}`;
      else message.textContent = errorText(data);
    },
  },
  el('label', {}, 'Customer', el('input', { name: 'customer_name', value: job.customer_name || '', required: true, maxLength: 100 })),
  el('label', {}, 'Address', el('input', { name: 'address', value: job.address || '', required: true, maxLength: 200 })),
  el('label', {}, 'Description', el('textarea', { name: 'description', value: job.description || '', maxLength: 1000 })),
  el('label', {}, 'Status', status),
  el('label', {}, 'Date', el('input', { name: 'scheduled_for', type: 'date', value: job.scheduled_for || '', required: true })),
  el('button', { type: 'submit' }, 'Save'),
  message);
  return form;
}

async function newJobPage() {
  show(el('h1', {}, 'New job'), jobForm({ status: 'scheduled' }, body => api('POST', '/api/jobs', body)));
}

async function jobPage(id) {
  const { status, data } = await api('GET', `/api/jobs/${id}`);
  if (status !== 200) return show(el('h1', {}, 'Job'), el('p', { className: 'error' }, errorText(data)));
  const { job } = data;
  show(el('h1', {}, `Job ${job.id}`),
    job.invoice_id ? el('p', {}, el('a', { href: `#/invoices/${job.invoice_id}` }, 'View invoice')) : null,
    jobForm(job, body => api('PATCH', `/api/jobs/${job.id}`, body)));
}

async function invoicePage(id) {
  const { status, data } = await api('GET', `/api/invoices/${id}`);
  if (status !== 200) return show(el('h1', {}, 'Invoice'), el('p', { className: 'error' }, errorText(data)));
  const { invoice } = data;
  show(el('h1', {}, `Invoice ${invoice.id}`),
    el('dl', { className: 'card' },
      el('dt', {}, 'Amount'), el('dd', {}, money(invoice.amount_cents)),
      el('dt', {}, 'Status'), el('dd', {}, invoice.status),
      el('dt', {}, 'Issued'), el('dd', {}, invoice.issued_on),
      el('dt', {}, 'Due'), el('dd', {}, invoice.due_on),
      el('dt', {}, 'Job'), el('dd', {}, el('a', { href: `#/jobs/${invoice.job_id}` }, `Job ${invoice.job_id}`))));
}

async function staffPage() {
  const { status, data } = await api('GET', '/api/staff');
  if (status !== 200) return show(el('h1', {}, 'Staff'), el('p', { className: 'error' }, errorText(data)));
  const message = el('div');
  const form = el('form', {
    onsubmit: async event => {
      event.preventDefault();
      const result = await api('POST', '/api/staff', { email: form.email.value });
      if (result.status !== 201) return message.replaceChildren(el('p', { className: 'error' }, errorText(result.data)));
      await staffPage();
      main.prepend(el('p', { className: 'notice' },
        `Added ${result.data.staff.email}. One-time password: ${result.data.one_time_password}. `,
        'Copy it now: it will not be shown again.'));
    },
  },
  el('label', {}, 'New staff email', el('input', { name: 'email', type: 'email', required: true })),
  el('button', { type: 'submit' }, 'Add staff'),
  message);
  const rows = data.staff.map(user => el('div', { className: 'card' },
    el('strong', {}, user.email), ' ',
    el('span', { className: 'status' }, user.disabled_at ? 'removed' : user.role),
    user.role === 'staff' && !user.disabled_at
      ? el('div', {}, el('button', {
        className: 'link',
        onclick: async () => {
          if (!confirm(`Remove ${user.email}? They will be signed out everywhere.`)) return;
          const result = await api('DELETE', `/api/staff/${user.id}`);
          if (result.status === 204) staffPage();
          else message.replaceChildren(el('p', { className: 'error' }, errorText(result.data)));
        },
      }, 'Remove'))
      : null));
  show(el('h1', {}, 'Staff'), rows, form);
}

async function route() {
  const hash = location.hash || '#/jobs';
  if (!me && hash !== '#/login') {
    const { status, data } = await api('GET', '/api/me');
    if (status !== 200) return;
    me = data;
  }
  updateHeader();
  const [, page, id] = hash.split('/');
  if (page === 'login') return loginPage();
  if (page === 'jobs' && id === 'new') return newJobPage();
  if (page === 'jobs' && id) return jobPage(id);
  if (page === 'invoices' && id) return invoicePage(id);
  if (page === 'staff') return staffPage();
  return jobsPage();
}

document.getElementById('signout').addEventListener('click', async () => {
  await api('POST', '/api/logout');
  me = null;
  updateHeader();
  location.hash = '#/login';
});

window.addEventListener('hashchange', route);
route();
