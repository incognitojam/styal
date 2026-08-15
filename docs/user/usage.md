# Review usage

The Usage page combines Codex, Claude Code, and Grok Build activity from your connected
environments. It reads the providers' local session history and shows API-equivalent token cost,
processed tokens, cache savings, estimated operational carbon emissions, provider shares, and model
breakdowns. Subscription billing is separate from the raw token cost shown here.

Grok Build totals come from persisted session updates. Interactive turns that never wrote a
completed-turn record will not appear.

Use **Past 24h** for an hourly chart covering the exact rolling 24-hour period. The **7 days**,
**30 days**, and **90 days** ranges use daily resolution. Cost and token toggles update both the
headline and chart, and refreshing rescans every connected environment.

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
