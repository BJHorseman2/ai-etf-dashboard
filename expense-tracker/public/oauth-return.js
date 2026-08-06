// Landing page for OAuth bank logins (Chase, BofA, ...). The bank redirects
// back here; we resume the same Plaid Link session and finish the exchange.
'use strict';

const token = localStorage.getItem('plaid_link_token');
if (!token) {
  location.replace('/');
} else {
  const handler = Plaid.create({
    token,
    receivedRedirectUri: window.location.href,
    onSuccess: async (public_token, metadata) => {
      try {
        await fetch('/api/link/exchange', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Requested-With': 'expense-tracker',
          },
          body: JSON.stringify({
            public_token,
            institution_name: metadata.institution?.name,
          }),
        });
      } finally {
        localStorage.removeItem('plaid_link_token');
        location.replace('/');
      }
    },
    onExit: () => {
      localStorage.removeItem('plaid_link_token');
      location.replace('/');
    },
  });
  handler.open();
}
