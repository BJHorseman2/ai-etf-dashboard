# AI-themed ETF watchlist

Static, mobile-friendly research dashboard for SMH, PAVE, GRID, IBB and KRE. Market data is refreshed separately from the AOL cleaner. No API keys are sent to browsers. The badge explicitly describes end-of-day data, never a live trading quote.

## Provider decision (reviewed October 8, 2026)

| Provider | Suitability and restrictions |
| --- | --- |
| Alpha Vantage (implemented) | Official daily adjusted endpoint supplies raw close plus dividend/split-adjusted close in one response. `TIME_SERIES_DAILY_ADJUSTED` is premium. Full history is needed because compact returns only 100 observations. Default historical entitlement is used; no intraday feed is claimed. Standard terms cover personal, non-commercial use; financial-advisor affiliation and public commercial access require a written agreement. A paid API key alone does not establish publication rights. |
| Twelve Data | Official API and business plans support external display, but subscription/add-on or written agreement must explicitly authorize redistribution, exchange entitlements, attribution and caching. Personal/free tier is not a substitute for professional/public rights. A viable alternative if its license is preferable; its adjustment semantics must be matched before replacing the adapter. |
| Yahoo Finance | Existing HTML named Yahoo but contained no refresh integration. Unofficial scraping/chart endpoints have no contracted availability or established publication entitlement for this app. Not used as a silent fallback. |

Primary documentation:
- https://www.alphavantage.co/documentation/#dailyadj
- https://www.alphavantage.co/support/ (free service: 25 requests/day; endpoint selected here needs premium)
- https://www.alphavantage.co/terms_of_service/ (commercial use, including advisor affiliation, requires written agreement; contact premium@alphavantage.co)
- https://www.alphavantage.co/realtime_data_policy/
- https://twelvedata.com/pricing-business
- https://twelvedata.com/terms (sections 2–3: redistribution, caching, exchange requirements)
- https://support.twelvedata.com/en/articles/12647398-attribution-guidelines-for-using-twelve-data

## Configuration

1. Obtain Alpha Vantage daily-adjusted/full-history API access covering all five US ETFs. Obtain written rights for professional use, public web display, **public JSON download, storage in public Git history**, and applicable retention/attribution. If permanent public history is not permitted, do not enable this architecture: move snapshots to an authorized backend with retention controls first.
2. Add repository Actions secret `ALPHA_VANTAGE_API_KEY`.
3. Only after confirming those rights, set repository Actions variable `MARKET_DATA_PUBLICATION_APPROVED` to `true`. This is an operator attestation, not automated license verification. Neither setting is included in this PR; no fabricated or obsolete seed prices are published.
4. After merging, run **Refresh ETF market data** manually on `main`, inspect the workflow and timestamps. Scheduled runs follow at 22:17 UTC weekdays and 02:17 UTC Tuesday–Saturday (a second attempt for later publication). At most five sequential requests per successful run; bounded retries increase that to fifteen. Configure a plan whose per-minute and daily quotas cover this load. GitHub schedules may be delayed or disabled after inactivity; monitor failed/missing runs in Actions.
5. The workflow commits only `data/market-data.json`, rebases on concurrent main changes, and explicitly updates the existing Pages site because bot-token pushes do not trigger the Pages push workflow. No workflow runs or deployment is needed to review the PR. The refresh workflow is gated to `main` and the opt-in variable. Its Pages environment uses the existing repository settings.

A missing key fails the workflow without logging URLs, credentials, or provider bodies. API HTTP errors, timeouts, 429/5xx, and HTTP-200 provider error payloads are handled. Transient errors are retried at most twice, with 15/30 second delays and 20-second request timeouts. Partial failures preserve the last successful fund history and publish an explicit error status; the run is marked failed after publishing the warning. JSON writes are atomic. A concurrent commit conflict stops publication rather than overwriting unrelated changes.

## Calculations and freshness

- `YTD = (latest adjusted close / adjusted close on the final session of the prior calendar year - 1) × 100`. This is a dividend/split-adjusted return proxy, not an unadjusted price return or personalized account return. Cards, daily chart and ranking use the same formula, without pre-rounding.
- Displayed USD prices and monthly table prices use **raw closes**. Baseline is explicitly labeled adjusted. Each monthly cell shows its actual observation date; the ongoing month is a partial month. Daily chart includes the baseline and every observed session; no invented monthly points or interpolation across missing data.
- The shared US equity-session calendar covers weekends, observed federal market holidays, Good Friday and the January 9, 2025 special closure. Both NYSE/Nasdaq funds follow that session schedule. Unexpected future exchange closures require a calendar update; early closes use the same conservative publication grace. This is a daily-close app, not a live exchange calendar service.
- Today's close is expected only after **22:00 UTC** (18:00 EDT / 17:00 EST); before that the prior completed session is expected. This tolerates provider publication delay and early closes. Observation dates, not fetch timestamps, determine staleness. Delayed/missing publication stays flagged until valid observations arrive.
- Missing baseline, invalid/nonpositive prices, wrong symbol, malformed dates or gaps reject that fund. Provider rows after the expected completed session are excluded, preventing intraday data from being mixed with daily closes. Prior-year history cannot masquerade as current-year YTD after rollover.
- Rankings and the ranking bar chart require all five valid, error-free funds on the expected date. Historical cards/lines remain visible with stale/error labels. Missing prices/returns use em dashes. A failed browser fetch keeps only the already-loaded snapshot and shows a network warning. No browser persistent cache or fake initial data.
- The browser reloads the published snapshot on demand, every five minutes while visible, and when returning to the tab. **Refresh data does not call the provider**; it reloads the latest server-published snapshot. API refresh is controlled by Actions. Fetch uses no-store and a cache-busting URL; duplicate refreshes are blocked. Refresh-attempt timestamp and each fund's closing date are distinct.

## Local review and tests

Node 24, no npm dependencies or install required:

```sh
npm test
python3 -m http.server 8000
```

Open http://localhost:8000. The checked-in empty snapshot intentionally displays unavailable until configured. Chart.js remains the original pinned CDN dependency; if unavailable, the table and cards still work.

To refresh locally after licensing configuration, supply `ALPHA_VANTAGE_API_KEY` and `MARKET_DATA_PUBLICATION_APPROVED=true` in your environment and run `npm run refresh`. Never commit keys. Fixtures are synthetic and used only by tests, never as published market observations.

Automated tests cover adjusted vs raw values, ranking, losses, ties, baseline, holiday/DST/weekend/rollover, incomplete data, provider errors/retries, partial retention and recovery. Pull-request CI runs these without credentials and does not deploy. A separate Playwright smoke job checks 390px and 1280px widths, empty-to-fresh refresh, negative returns, network-failure retention, overflow and JavaScript errors. Run it locally with Playwright/Chromium installed using `node scripts/check-browser.mjs` while the server runs. Live provider connectivity and entitlement must be checked after configuration; this PR cannot attest to current observed prices without an authorized key.
