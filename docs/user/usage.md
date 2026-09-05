# Usage and limits

## Understand your usage

**Usage** combines Codex, Claude Code, and Grok Build session history from your connected
environments. It shows token use, cache savings, model breakdowns, estimated API-equivalent cost,
and estimated carbon emissions. These estimates are not your subscription bill.

Totals depend on the history available on each server. Grok turns without a saved completed-turn
record are missing from the totals.

On web and desktop, use the environment dropdown to filter costs, tokens, and limits. All
environments are selected by default. The dropdown shows which environments are still scanning;
results appear as each one responds.

If recent work is missing or a new model shows no cost, refresh to rescan session history and
update model pricing.

The carbon figure is a rough estimate of operational emissions, not a provider measurement. It
applies 0.43 g CO2 per 1,000 generated tokens, based on a
[published energy estimate](https://arxiv.org/abs/2509.20241) for a frontier-model query and the
[IEA's projected 2026 global electricity intensity](https://www.iea.org/reports/electricity-mid-year-update-2025/emissions-power-generation-co2-emissions-are-plateauing).
Actual emissions vary by model, hardware, data center, and energy source. The figure excludes
training, hardware manufacture, networking, and other lifecycle emissions. Its comparisons with
smartphone charges or miles driven use the
[EPA's greenhouse gas equivalencies](https://www.epa.gov/energy/greenhouse-gas-equivalencies-calculator-calculations-and-references)
and are also approximate.

## Set custom model prices

On web or desktop, open **Usage → Model prices** to add, edit, or remove a model's estimated
price. Choose the environment whose history you want to price, then enter the exact model ID and
USD rates per million input and output tokens. You can enter any model ID, including models
without public pricing.

Cache read and cache write rates are optional and use the input rate when blank. Enter `0` for
tokens that are free. Saved prices replace automatic pricing for all of that environment's
history and are shared with clients connected to it. Set prices on each environment that needs
them. Removing a price restores automatic pricing.

## Track subscription limits

**Usage → Limits** shows quota use and reset times for Codex and Claude subscriptions. It also
compares quota consumed with time elapsed in each window, so you can judge your pace before the
next reset.

If a window looks stale, refresh Limits to re-check every provider and hub.

API-key accounts may not report subscription limits. This also applies to Claude connections
using a proxy through `ANTHROPIC_AUTH_TOKEN`.

## Connect a CLIProxyAPI hub

To see pooled accounts, open **Settings → Providers → Usage providers → Add hub**. Choose the
environment that will connect to the hub and enter its URL and management key.

The accounts appear under **Usage → Limits**. This connection supplies usage information; configure
the provider separately to send agent requests through the hub. Remove the hub from the same
settings section when you no longer need it.
