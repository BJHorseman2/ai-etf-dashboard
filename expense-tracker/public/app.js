/* Expense Tracker frontend */
'use strict';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const state = {
  accounts: [],
  transactions: [],
  subscriptions: [],
  linkMode: 'demo',
};

// ── API helper (adds CSRF header; JSON in/out) ──────────────────────────────
async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'X-Requested-With': 'expense-tracker',
      ...(opts.headers || {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith('/auth')) { showAuth(); throw new Error('unauthenticated'); }
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

const fmtMoney = (n) =>
  (n < 0 ? '+' : '') + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const CATEGORY_ICONS = {
  Streaming: '📺', Subscriptions: '🔁', Fitness: '💪', Software: '💻', News: '📰',
  Groceries: '🛒', Shopping: '🛍️', Gas: '⛽', Coffee: '☕', 'Fast food': '🍔',
  Insurance: '🛡️', Utilities: '💡', Financial: '🏦', Income: '💰', Other: '💳',
};

// ── Auth ────────────────────────────────────────────────────────────────────
let setupMode = false;

async function initAuth() {
  const { setupComplete } = await api('/auth/status');
  setupMode = !setupComplete;
  $('#auth-title').textContent = setupMode ? 'Create your account' : 'Sign in';
  $('#auth-sub').textContent = setupMode
    ? 'First run — choose an email and a strong password (10+ characters). This device only.'
    : '';
  $('#auth-submit').textContent = setupMode ? 'Create account' : 'Sign in';
  $('#auth-password').autocomplete = setupMode ? 'new-password' : 'current-password';
}

function showAuth() {
  $('#app').classList.add('hidden');
  $('#auth-screen').classList.remove('hidden');
}

async function showApp() {
  $('#auth-screen').classList.add('hidden');
  $('#app').classList.remove('hidden');
  const me = await api('/me');
  $('#demo-badge').classList.toggle('hidden', !me.demoMode);
  const { mode } = await api('/link/mode');
  state.linkMode = mode;
  await refreshAll();
}

$('#auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = $('#auth-error');
  errEl.classList.add('hidden');
  try {
    await api(setupMode ? '/auth/setup' : '/auth/login', {
      method: 'POST',
      body: { email: $('#auth-email').value.trim(), password: $('#auth-password').value },
    });
    $('#auth-password').value = '';
    await showApp();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
});

$('#logout-btn').addEventListener('click', async () => {
  await api('/auth/logout', { method: 'POST' }).catch(() => {});
  location.reload();
});

// ── Tabs ────────────────────────────────────────────────────────────────────
function switchTab(name) {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $$('.tab-panel').forEach((p) => p.classList.toggle('hidden', p.id !== 'tab-' + name));
}
$$('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));
document.addEventListener('click', (e) => {
  const goto = e.target.closest('[data-goto]');
  if (goto) switchTab(goto.dataset.goto);
});

// ── Data refresh ────────────────────────────────────────────────────────────
async function refreshAll() {
  const [accounts, txns, subs, summary] = await Promise.all([
    api('/accounts'), api('/transactions'), api('/subscriptions'), api('/summary'),
  ]);
  state.accounts = accounts;
  state.transactions = txns;
  state.subscriptions = subs;

  const hasData = accounts.length > 0;
  $('#empty-state').classList.toggle('hidden', hasData);
  $('#overview-content').classList.toggle('hidden', !hasData);

  renderStats(summary);
  renderCharts(summary);
  renderRecent();
  renderTransactions();
  renderSubscriptions();
  renderAccounts();
  renderAudit();
  renderAccountFilter();
}

// ── Overview ────────────────────────────────────────────────────────────────
function renderStats(summary) {
  const thisMonth = summary.monthly.at(-1) || { spent: 0, received: 0 };
  const activeSubs = state.subscriptions.filter((s) => s.status !== 'cancelled');
  const subMonthly = activeSubs.reduce((a, s) => a + s.monthly_cost, 0);
  const linked = state.accounts.length;
  $('#stat-row').innerHTML = `
    <div class="stat"><div class="label">Spent this month</div><div class="value red">${fmtMoney(thisMonth.spent)}</div></div>
    <div class="stat"><div class="label">Income this month</div><div class="value green">${fmtMoney(-thisMonth.received)}</div></div>
    <div class="stat"><div class="label">Active subscriptions</div><div class="value amber">${activeSubs.length} · ${fmtMoney(subMonthly)}/mo</div></div>
    <div class="stat"><div class="label">Linked accounts</div><div class="value">${linked}</div></div>`;
}

function renderCharts(summary) {
  // Note: sizes are applied via element.style (CSSOM) rather than inline
  // style attributes, which our strict CSP intentionally blocks.
  const months = summary.monthly;
  const max = Math.max(...months.map((m) => m.spent), 1);
  $('#monthly-chart').innerHTML = months.map((m, i) => `
    <div class="bar-col">
      <div class="bar-val">$${Math.round(m.spent)}</div>
      <div class="bar" data-i="${i}"></div>
      <div class="bar-label">${esc(m.month.slice(5))}/${esc(m.month.slice(2, 4))}</div>
    </div>`).join('');
  $$('#monthly-chart .bar').forEach((el) => {
    const m = months[Number(el.dataset.i)];
    el.style.height = Math.max(3, (m.spent / max) * 100) + '%';
  });

  const cats = summary.byCategory;
  const cmax = Math.max(...cats.map((c) => c.total), 1);
  $('#category-chart').innerHTML = cats.map((c, i) => `
    <div class="hbar-row">
      <span class="name">${CATEGORY_ICONS[c.category] || '💳'} ${esc(c.category)}</span>
      <div class="hbar-track"><div class="hbar-fill" data-i="${i}"></div></div>
      <span class="amt">${fmtMoney(c.total)}</span>
    </div>`).join('') || '<p class="muted">No spending in the last 30 days.</p>';
  $$('#category-chart .hbar-fill').forEach((el) => {
    el.style.width = ((cats[Number(el.dataset.i)].total / cmax) * 100) + '%';
  });
}

function renderRecent() {
  $('#recent-txns').innerHTML = state.transactions.slice(0, 6).map(txnRow).join('')
    || '<p class="muted">No transactions yet.</p>';
}

// ── Transactions ────────────────────────────────────────────────────────────
function txnRow(t) {
  const icon = CATEGORY_ICONS[t.category] || (t.amount < 0 ? '💰' : '💳');
  return `
  <div class="txn" data-txn-id="${t.id}">
    <div class="icon">${icon}</div>
    <div class="mid">
      <div class="merchant">${esc(t.merchant_name || t.raw_descriptor)}
        ${t.processor && t.processor !== t.merchant_name ? `<span class="chip proc">${esc(t.processor)}</span>` : ''}
        ${t.pending ? '<span class="chip pending">pending</span>' : ''}
      </div>
      <div class="raw">${esc(t.raw_descriptor)}</div>
      <div class="meta">${esc(t.institution_name)} · ${esc(t.account_name)} ••${esc(t.account_mask || '')}${t.location ? ' · ' + esc(t.location) : ''}</div>
    </div>
    <div>
      <div class="amount ${t.amount < 0 ? 'credit' : ''}">${fmtMoney(t.amount)}</div>
      <div class="date">${esc(t.date)}</div>
    </div>
  </div>`;
}

function renderTransactions() {
  const q = $('#txn-search').value.trim().toLowerCase();
  const acc = $('#txn-account-filter').value;
  let list = state.transactions;
  if (acc) list = list.filter((t) => String(t.account_id) === acc);
  if (q) list = list.filter((t) =>
    (t.raw_descriptor + ' ' + (t.merchant_name || '') + ' ' + (t.processor || '')).toLowerCase().includes(q));
  $('#txn-list').innerHTML = list.map(txnRow).join('')
    || '<p class="muted pad1">No matching transactions.</p>';
}

function renderAccountFilter() {
  const sel = $('#txn-account-filter');
  const current = sel.value;
  sel.innerHTML = '<option value="">All accounts</option>' + state.accounts.map((a) =>
    `<option value="${a.id}">${esc(a.name)} ••${esc(a.mask || '')}</option>`).join('');
  sel.value = current;
}

$('#txn-search').addEventListener('input', renderTransactions);
$('#txn-account-filter').addEventListener('change', renderTransactions);

// Charge-origin detail modal
document.addEventListener('click', (e) => {
  const row = e.target.closest('.txn');
  if (!row) return;
  const t = state.transactions.find((x) => x.id === Number(row.dataset.txnId));
  if (!t) return;
  $('#txn-modal-body').innerHTML = `
    <div class="origin-box">💡 ${esc(t.origin_note || 'No additional origin information for this charge.')}</div>
    <dl class="kv">
      <dt>Statement shows</dt><dd class="mono">${esc(t.raw_descriptor)}</dd>
      <dt>Decoded merchant</dt><dd><strong>${esc(t.merchant_name || '—')}</strong></dd>
      <dt>Payment processor</dt><dd>${esc(t.processor || 'Direct (no intermediary detected)')}</dd>
      <dt>Amount</dt><dd>${fmtMoney(t.amount)} ${esc(t.currency)}</dd>
      <dt>Date</dt><dd>${esc(t.date)}${t.pending ? ' (pending)' : ''}</dd>
      <dt>Charged to</dt><dd>${esc(t.institution_name)} — ${esc(t.account_name)} ••${esc(t.account_mask || '')}</dd>
      <dt>Channel</dt><dd>${esc(t.payment_channel || '—')}</dd>
      <dt>Location</dt><dd>${esc(t.location || '—')}</dd>
      <dt>Category</dt><dd>${esc(t.category || '—')}</dd>
    </dl>`;
  $('#txn-modal').showModal();
});

// ── Subscriptions ───────────────────────────────────────────────────────────
function renderSubscriptions() {
  const subs = state.subscriptions;
  const active = subs.filter((s) => s.status !== 'cancelled');
  const monthly = active.reduce((a, s) => a + s.monthly_cost, 0);
  const cancelled = subs.filter((s) => s.status === 'cancelled');
  const saved = cancelled.reduce((a, s) => a + s.monthly_cost, 0);

  $('#sub-stats').innerHTML = `
    <div class="stat"><div class="label">Detected</div><div class="value">${subs.length}</div></div>
    <div class="stat"><div class="label">Monthly cost</div><div class="value amber">${fmtMoney(monthly)}</div></div>
    <div class="stat"><div class="label">Yearly cost</div><div class="value red">${fmtMoney(monthly * 12)}</div></div>
    <div class="stat"><div class="label">Saved by cancelling</div><div class="value green">${fmtMoney(saved)}/mo</div></div>`;

  $('#sub-list').innerHTML = subs.map((s) => `
    <div class="sub-card ${s.status === 'cancelled' ? 'cancelled' : ''}">
      <div>
        <div class="sub-name">${esc(s.display_name)}
          <span class="status-pill ${s.status}">${{ active: 'ACTIVE', cancel_requested: 'CANCELLING', cancelled: 'CANCELLED' }[s.status]}</span>
        </div>
        <div class="sub-meta">
          ${esc(s.cadence)} · last charged ${esc(s.last_charge_date || '—')} · next expected ${esc(s.next_expected_date || '—')}<br>
          billed to ${esc(s.account_name || 'unknown account')} ••${esc(s.account_mask || '')}
        </div>
        <div class="sub-actions">
          ${s.status === 'active' ? `<button class="btn danger small" data-cancel-sub="${s.id}">Cancel subscription</button>` : ''}
          ${s.status === 'cancel_requested' ? `
            <button class="btn small" data-cancel-sub="${s.id}">View cancellation steps</button>
            <button class="btn primary small" data-confirm-sub="${s.id}">Mark as cancelled</button>` : ''}
          ${s.status !== 'cancelled' ? `<button class="btn ghost small" data-dismiss-sub="${s.id}" title="Not a subscription — remove from radar">Not a subscription</button>` : ''}
        </div>
      </div>
      <div class="sub-cost">${fmtMoney(s.avg_amount)}<small>per ${esc(s.cadence.replace(/ly$/, ''))} · ≈${fmtMoney(s.monthly_cost)}/mo</small></div>
    </div>`).join('')
    || '<p class="muted pad1">No recurring charges detected yet. Link an account and sync transactions first.</p>';
}

document.addEventListener('click', async (e) => {
  const cancelBtn = e.target.closest('[data-cancel-sub]');
  if (cancelBtn) return openCancelModal(Number(cancelBtn.dataset.cancelSub));

  const confirmBtn = e.target.closest('[data-confirm-sub]');
  if (confirmBtn) {
    await api(`/subscriptions/${confirmBtn.dataset.confirmSub}/confirm-cancelled`, { method: 'POST' });
    await refreshAll();
    switchTab('subscriptions');
  }

  const dismissBtn = e.target.closest('[data-dismiss-sub]');
  if (dismissBtn) {
    await api(`/subscriptions/${dismissBtn.dataset.dismissSub}`, { method: 'DELETE' });
    await refreshAll();
    switchTab('subscriptions');
  }
});

async function openCancelModal(subId) {
  const sub = state.subscriptions.find((s) => s.id === subId);
  if (!sub) return;
  const { playbook, letter } = await api(`/subscriptions/${subId}/cancel`, {
    method: 'POST', body: { method: playbookFor(sub) },
  });

  $('#cancel-title').textContent = `Cancel ${sub.display_name}`;
  $('#cancel-modal-body').innerHTML = `
    <p class="muted">${fmtMoney(sub.avg_amount)} ${esc(sub.cadence)} — cancelling saves ≈ <strong>${fmtMoney(sub.monthly_cost * 12)}/year</strong>.</p>

    <div class="cancel-step">
      <h4>1 · Cancel with the merchant ${playbook.known ? '' : '(no direct link on file)'}</h4>
      <p>${esc(playbook.how)}</p>
      ${playbook.url ? `<p><a href="${esc(playbook.url)}" target="_blank" rel="noopener noreferrer">Open ${esc(sub.display_name)} cancellation page ↗</a></p>` : ''}
      ${playbook.phone ? `<p>Or call: <strong>${esc(playbook.phone)}</strong></p>` : ''}
    </div>

    <div class="cancel-step">
      <h4>2 · If the merchant makes it hard: order your bank to stop paying</h4>
      <p>You have the legal right to revoke authorization for recurring charges. Send this letter to
         <strong>${esc(sub.account_name || 'your bank')}</strong> (secure message, or their disputes address) —
         they must stop the charges even if the merchant refuses.</p>
      <div class="letter" id="letter-text">${esc(letter)}</div>
      <button class="btn small" id="copy-letter">📋 Copy letter</button>
    </div>

    <div class="cancel-step">
      <h4>3 · Watch for the next expected charge</h4>
      <p>Next charge expected around <strong>${esc(sub.next_expected_date || 'unknown')}</strong>.
         This subscription is now marked <em>cancelling</em>; if no further charge arrives, mark it cancelled.
         If a charge does arrive after cancellation, dispute it with your bank as unauthorized.</p>
    </div>

    <div class="modal-actions">
      <button class="btn primary" data-confirm-sub="${sub.id}" data-close-first>I've cancelled it — mark as cancelled</button>
      <button class="btn ghost" data-close>Close (keep tracking)</button>
    </div>`;
  $('#cancel-modal').showModal();

  $('#copy-letter').addEventListener('click', async () => {
    await navigator.clipboard.writeText(letter);
    $('#copy-letter').textContent = '✓ Copied';
  });
  await refreshAll(); // reflect cancel_requested status behind the modal
  switchTab('subscriptions');
}

function playbookFor(sub) {
  return sub.playbook?.known ? 'merchant_portal' : 'bank_revocation';
}

document.addEventListener('click', async (e) => {
  if (e.target.closest('[data-close]')) $$('dialog').forEach((d) => d.close());
  if (e.target.closest('[data-close-first]')) $$('dialog').forEach((d) => d.close());
});

// ── Accounts & linking ──────────────────────────────────────────────────────
function renderAccounts() {
  const byInstitution = {};
  for (const a of state.accounts) (byInstitution[a.institution_name] ??= []).push(a);

  $('#account-list').innerHTML = Object.entries(byInstitution).map(([inst, accts]) => `
    <div class="card">
      <div class="card-head">
        <h3>🏦 ${esc(inst)}${accts[0].is_demo ? ' <span class="chip">demo</span>' : ''}</h3>
        <button class="btn ghost small danger" data-unlink="${accts[0].item_id}">Unlink</button>
      </div>
      ${accts.map((a) => `
        <div class="account-card">
          <div>
            <div class="acc-name">${a.type === 'credit' ? '💳' : '🏛️'} ${esc(a.name)} ••${esc(a.mask || '')}</div>
            <div class="acc-meta">${esc(a.subtype || a.type)}</div>
          </div>
          <div class="balance">${a.current_balance != null ? '$' + Math.abs(a.current_balance).toLocaleString('en-US', { minimumFractionDigits: 2 }) : '—'}</div>
        </div>`).join('')}
    </div>`).join('')
    || '<p class="muted pad1">No accounts linked yet.</p>';
}

document.addEventListener('click', async (e) => {
  const unlink = e.target.closest('[data-unlink]');
  if (!unlink) return;
  if (!confirm('Unlink this institution? Its transaction history will be removed from the app.')) return;
  await api(`/items/${unlink.dataset.unlink}`, { method: 'DELETE' });
  await refreshAll();
});

async function linkAccount() {
  if (state.linkMode === 'demo') {
    try {
      await api('/link/demo', { method: 'POST' });
      await refreshAll();
    } catch (err) { alert(err.message); }
    return;
  }
  // Real linking via Plaid Link — credentials are entered in Plaid's widget.
  const { link_token } = await api('/link/token', { method: 'POST' });
  // Saved so oauth-return.html can resume the session after an OAuth bank
  // (Chase, BofA, ...) redirects back to us.
  localStorage.setItem('plaid_link_token', link_token);
  const handler = Plaid.create({
    token: link_token,
    onSuccess: async (public_token, metadata) => {
      localStorage.removeItem('plaid_link_token');
      await api('/link/exchange', {
        method: 'POST',
        body: { public_token, institution_name: metadata.institution?.name },
      });
      await refreshAll();
    },
    onExit: () => localStorage.removeItem('plaid_link_token'),
  });
  handler.open();
}
$('#link-btn').addEventListener('click', linkAccount);
$('#link-btn-empty').addEventListener('click', linkAccount);

$('#sync-btn').addEventListener('click', async () => {
  $('#sync-btn').disabled = true;
  try { await api('/sync', { method: 'POST' }); await refreshAll(); }
  finally { $('#sync-btn').disabled = false; }
});

// ── Audit log ───────────────────────────────────────────────────────────────
async function renderAudit() {
  const rows = await api('/audit-log').catch(() => []);
  $('#audit-list').innerHTML = rows.map((r) => `
    <div class="audit-row">
      <span class="when">${esc(r.at)}</span>
      <span class="event">${esc(r.event.replace(/_/g, ' '))}${r.detail ? ' — ' + esc(r.detail) : ''}</span>
      <span class="when">${esc(r.ip || '')}</span>
    </div>`).join('') || '<p class="muted">No activity yet.</p>';
}

// ── Boot ────────────────────────────────────────────────────────────────────
(async function boot() {
  await initAuth();
  try {
    await api('/me');       // succeeds only with a valid session
    await showApp();
  } catch {
    showAuth();
  }
})();
