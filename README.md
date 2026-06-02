# NordRelay Usage Insights

Official NordRelay plugin for token usage and estimated model cost analytics.

Usage Insights reads NordRelay's normalized `usage.read` plugin context, stores
cumulative session usage plus deduplicated deltas in SQLite, and renders a
peer-aware WebUI panel.

## Features

- Total token and estimated cost overview across all nodes.
- Grouping by node, provider, model, session, and date range.
- Separate accounting for input, cached input, cache write, output, and reasoning output tokens.
- Optional price refresh from LiteLLM's public model price catalog.
- SQLite-backed history with delta dedupe.
- Peer aggregation through NordRelay plugin panels.

Costs are estimates. Unknown models are still counted for tokens and shown as
unpriced until a matching price rule is available.

## Install

Install from the NordRelay marketplace, or manually:

```sh
nordrelay plugin install npm:@nordbyte/nordrelay-usage-insights --enable --approve
```

Required permissions:

- `runtime.read`
- `usage.read`
- `peers.read`
- `network`

## Commands

- `collect`: collect one local usage snapshot.
- `panel-data`: return panel summaries for the selected range.
- `refresh-prices`: fetch the remote model price catalog.
- `price-catalog`: list stored model price rules.
- `export`: export usage deltas as JSON or CSV.
- `cleanup`: remove old delta rows according to retention.
- `storage-health`: inspect SQLite storage.

## Price Catalog

The default price source is:

```text
https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json
```

The catalog contains rates for many models and includes separate fields for
normal input, cached input, cache creation, output, and reasoning output where
available.

## Data

Plugin state is stored in the plugin data directory managed by NordRelay. The
main database file is:

```text
usage-insights.sqlite
```

No prompt contents are stored by this plugin.
