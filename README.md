# Cribl Performance Testing

Measure how long your Cribl Search searches really take, on Lakehouse engine sizes and on federated search over remote data, with figures you can defend in front of a customer.

## Summary

Cribl Performance Testing is a Cribl Search app for repeatable search benchmarks. It runs your own saved searches over fixed time windows, several times each, and reports how long each one took start to finish, using the server's own clock. It helps you choose a Lakehouse engine size, see what a federated search over S3, Azure Blob, GCS or Cribl Lake costs in time and CPU, and compare the two on the same data.

## What This App Does

* Primary purpose: repeatable, server-timed performance tests of Cribl Search searches.
* Key capabilities:
  * **Two test types.** *Lakehouse engine sizes* times searches over Lakehouse datasets on one or more engine sizes, resizing between them only after you confirm. *Federated search* times searches over remote data on the federated executors. No engine is used or resized.
  * **Pick the dataset per search,** from a list grouped by where the data lives: Lakehouse, then Federated by storage type (Amazon S3, Azure Blob Storage, Google Cloud Storage, Cribl Lake, Cribl Edge, HTTP API …).
  * **Server-side timings.** Every run records the total time, split into queue wait and execution. Federated runs also record billable CPU-seconds, executor fan-out, and how long the run waited for compute to start.
  * **Statistics that don't overstate.** Medians, percentiles only once the sample supports them, confidence intervals, and a significance test between sizes, or between Lakehouse and federated.
  * **Named sessions and exports.** Every run session is named and kept. Results copy to the clipboard as CSV or Markdown, with the build and query provenance attached.
* Intended users:
  * Solutions engineers and platform owners sizing or validating Cribl Search.
  * Anyone who needs before-and-after numbers for a configuration change.
* Works with:
  * Cribl Search on Cribl.Cloud: Lakehouse engines and federated datasets.

## When To Use This App

* Choosing a Lakehouse engine size: measure the same searches on several sizes and see whether the difference is real.
* Pricing a federated search: how long a search over S3 or Azure Blob takes, and how many billable CPU-seconds it uses.
* Comparing Lakehouse with federated on the same data: for example a Lakehouse dataset against the S3 bucket it was archived from.
* Checking that a change helped: run the same session before and after, and compare.

## Before You Install

* Required Cribl product or deployment type: Cribl Search on Cribl.Cloud.
* Required permissions or roles: users need permission to run searches. Engine-size tests also need permission to read and resize Lakehouse engines. See [Permissions](#permissions).
* Required external systems or APIs: none.
* Required configuration values: none. You add your own test searches after install.
* Known limits or prerequisites:
  * Engine-size tests resize a live Lakehouse engine. That changes capacity and billing for everything using that engine, so the app always asks first and can restore the original size afterwards.
  * 4XLarge and larger engine sizes are not offered: Cribl grants them only by support request.

## Installation

### Install From Marketplace or URL
1. Go to Apps in your Cribl environment.
2. Choose the Marketplace or import from URL option.
3. If the app is available in the Cribl Marketplace, install it directly from there.
4. If the app is distributed as a Marketplace-hosted URL, use the URL to import it.
5. Review the app details and complete installation.

### If The App Is Not Yet In The Cribl Marketplace
1. Go to the app's GitHub repository.
2. Open the Releases section.
3. Download the `.tgz` app package for the version you want.
4. In Cribl, go to Apps and choose import from file.
5. Upload the downloaded `.tgz` file.
6. Review the app details and complete installation.

## Configuration

Nothing is required before first use. Everything below has a working default and is changed in the app.

| Setting | Required | Description | Example | Scope |
|---|---|---|---|---|
| Test searches | Yes, before running | The searches to measure: complete KQL with its `dataset=` term and no time bounds. The app ships with none on purpose. | `dataset="criblcoffee_pos" \| summarize c=count()` | Shared (per app) |
| Test type | No | *Lakehouse engine sizes* or *Federated search*. | Federated search | Shared |
| Time windows | No | The time ranges every search is measured over. Defaults to eight, from 1 hour to 14 days. | T1 · 1 hour | Shared |
| Repetitions | No | Timed runs per search per window, plus one warm-up. Defaults to 20, which is the smallest sample a p95 can be quoted from. | 20 | Shared |
| Engine sizes to test | No | Sizes a Lakehouse test sweeps. Leave empty to measure only the size the engine is on now, without resizing. | XSmall, Medium | Shared |
| Search worker group | No | Worker group the searches run in. | `default_search` | Shared |
| Acceptance budget | No | A time a percentile must stay under, graded pass or fail in Analysis. | p95 ≤ 5 s | Shared |

## How To Use

### Typical Workflow
1. Open **Test searches** and add the searches you want to measure.
2. On the workbench, choose a test type: **Lakehouse engine sizes** or **Federated search**.
3. On each search, pick the **Dataset** to test. For a federated test, choose one under a "Federated" group.
4. Pick a time window, or press **All windows**, and press **Time**.
5. Read the results on the workbench, then open **Analysis** to see whether differences are real and **Compare** for every window side by side.

### First-Run Checklist
* Add at least one test search, and tick it to include it in the next session.
* Choose the test type first. *Searches being timed* then lists only the selected searches of that type, and each search's Dataset list only that type's datasets. If none of that type is selected, the card offers your saved ones to pick from.
* Run one window with a few repetitions first to check the search, then the full set.

### Comparing Lakehouse with federated
1. Save two searches, one for each copy of the data, and set each one's **Counterpart** to the other in **Test searches**.
2. Run one session as a Lakehouse test and one as a federated test.
3. In **Analysis**, pick either search, keep **Include counterpart** on, and set **Compare against** to Federated.

## Permissions

The app runs in **Open** API access mode (strict mode off). It acts with the permissions of the user who opens it, plus the grants declared in `policies.yml` for users an admin has shared the app with. A user without permission to resize engines can still run federated tests, and Lakehouse tests on the engine's current size.

### Cribl API Endpoints Used

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/api/v1/m/{group}/search/jobs` | Starts each timed search. |
| GET | `/api/v1/m/{group}/search/jobs` | Reads each finished job's billable CPU and executor counts, which only the job list reports. |
| GET | `/api/v1/m/{group}/search/jobs/{id}` | Polls a running job for its status and compute-node wait. |
| GET | `/api/v1/m/{group}/search/jobs/{id}/results` | Reads the server's own timings and event count. |
| DELETE | `/api/v1/m/{group}/search/jobs/{id}` | Cancels a job when a session is stopped. |
| GET | `/api/v1/m/{group}/search/datasets` | Reads the dataset catalog for the dataset picker and to tell Lakehouse from federated searches. |
| GET | `/api/v1/m/{group}/search/local_search/engines` | Reads Lakehouse engine sizes and status. |
| PATCH | `/api/v1/m/{group}/search/local_search/engines/{id}` | Resizes an engine, only after you confirm in the app. |

## External API Access

### Default Configuration
* `default/proxies.yml`: empty. The app calls no external services.
* `default/policies.yml`: the Cribl Search endpoints listed above.

### External Endpoints
None. The app talks only to the Cribl Search API of the workspace it is installed in.

## Data And Storage

* The app keeps three records in its app-scoped KV store: `settings` (configuration), `searches` (the test-search library) and `runs` (run history and named sessions).
* Data is shared by everyone who uses the app in the workspace.
* Run history is capped at the most recent 2,000 runs.
* Nothing is stored outside the workspace. Exports go to your clipboard only.

## Support

### Internal Only
This app is built by Cribl Solutions Engineering for performance testing, demos and proofs of value. It is not a generally supported production app. For questions or problems, contact the maintainer, David Maislin, or open an issue on the app's GitHub repository.

## Known Limitations

* Compute-wait time is sampled about twice a second, so a shorter wait can be missed. Compute v1 federated datasets do not report it at all; their runs show it as "not reported".
* Engine-size API identifiers are confirmed only for Medium through XXLarge. The others are inferred from Cribl's documentation, and a rejected resize is reported rather than hidden.
* A search over a wildcard or several datasets can't be classified up front. It runs in either test, and each run is filed by where the server says it executed.

## Troubleshooting

### The App Opens But Some Features Do Not Work
Possible causes:
* Missing permissions: resizing needs engine write access, and searching needs search access.
* No test searches yet, or none selected.
* No search of the current test type is selected. The workbench offers your saved searches of that type, or you can add one in **Test searches**.

### The App Cannot Connect To An API Or Service
Check:
* That the search worker group in Settings exists in this workspace.
* That your user can run searches in Cribl Search directly.

### The App Works Locally But Not In Cribl
Check:
* The installed version, shown next to the app's title, matches the one you expect.
* The app's API access mode on its Permissions tab.
