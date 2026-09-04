# Review usage

The Usage page combines Codex, Claude Code, and Grok Build activity from your connected
environments. It reads the providers' local session history and shows API-equivalent token cost,
processed tokens, cache savings, estimated operational carbon emissions, provider shares, and model
breakdowns. Subscription billing is separate from the raw token cost shown here.

Grok Build totals come from persisted session updates. Interactive turns that never wrote a
completed-turn record will not appear.

The **Limits** view shows how much of each subscription window you have used on Codex and Claude
Code, per connected environment: the session and weekly windows, plus a per-model weekly window
such as Fable when your plan has one. Each window is a bar from the moment it opened to its reset,
filled by the share of quota spent; a thin line marks how far into the window you are, which is
also where even spending would have put the fill, and the icon beside the label says whether you
are ahead of, on, or under that pace. Hover a bar for the exact reset time. Limits refresh on the
provider health-check interval and update live while a turn runs. API-key accounts have no
subscription windows and say so; that includes a Claude Code that reaches Anthropic through a proxy
via `ANTHROPIC_AUTH_TOKEN`, since the CLI then treats itself as an API-key client.

If you pool accounts behind a CLIProxyAPI hub, **Add hub** on the Limits view shows the accounts
the hub manages. Each row shows its provider and instance name, or a small _CLI Proxy_ label for
hub accounts. When a connected provider reports limits for the same provider and email, its row
replaces the hub copy, keeping details such as banked reset credits. The hub copy remains visible
if the connected provider cannot report limits. Enter the hub's URL and management key; the key
is stored on the server and never sent back to a client. Emails are blurred until clicked, as in
provider settings.

Use **Past 24h** for an hourly chart covering the exact rolling 24-hour period. The **7 days**,
**30 days**, and **90 days** ranges use daily resolution. Cost and token toggles update both the
headline and chart. Refreshing rescans every connected environment and refetches model pricing on
each of them, so a newly released model that showed $0.00 gets a price without waiting for the daily
pricing update.

The carbon figure is a rough estimate based on generated tokens, not a provider measurement. It
applies a fixed factor of 0.43 g CO2 per 1,000 generated tokens, derived from a
[published estimate](https://arxiv.org/abs/2509.20241) of 0.31 Wh for a representative
300-output-token frontier-model query and the
[IEA's projected 2026 global electricity intensity](https://www.iea.org/reports/electricity-mid-year-update-2025/emissions-power-generation-co2-emissions-are-plateauing)
of 415 g CO2/kWh. Actual emissions vary by model, hardware, data center, utilization, and energy
source. The figure excludes training, hardware manufacture, networking, local devices, and other
lifecycle emissions.

To make the estimate easier to picture, totals below 1 kg are compared with smartphone charges and
larger totals with miles driven by an average gasoline passenger vehicle. These comparisons use the
[EPA's greenhouse gas equivalencies](https://www.epa.gov/energy/greenhouse-gas-equivalencies-calculator-calculations-and-references)
and are approximate too. Select the information button beside **Estimated CO2** to see the
assumptions in the app.
