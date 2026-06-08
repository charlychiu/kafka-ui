# Kafka 4.0 / KRaft support

This repository is a **fork of [provectus/kafka-ui](https://github.com/provectus/kafka-ui)**
(the upstream project is archived) that adds support for **Apache Kafka 4.0** clusters
running in **KRaft** mode (ZooKeeper-less). Kafka 4.0 removed ZooKeeper entirely and made
KRaft mandatory, which broke several assumptions in the original code. This document
explains what was changed, how to run it, and the current limitations.

> If you only want to run it: jump to [Running it](#running-it).

---

## Why a fork was needed

Upstream kafka-ui was last released against the ZooKeeper era. On a Kafka 4.0 KRaft cluster
several things break or mislead:

| Symptom on Kafka 4.0 KRaft | Root cause |
| --- | --- |
| Cluster version shown as `1.0-UNKNOWN`, topic config edits fail | KRaft brokers don't expose `inter.broker.protocol.version` |
| `INCREMENTAL_ALTER_CONFIGS` disabled → deprecated `alterConfigs` path used | follows from the `1.0-UNKNOWN` mis-detection |
| Wrong / fluctuating "active controller" | `describeCluster().controller()` returns an arbitrary broker in KRaft (KIP-590) |
| Protocol errors with newer brokers | `kafka-clients` too old for the 4.0 protocol |
| Consumer groups stuck on `UNKNOWN` state during rebalance | new KIP-848 states `ASSIGNING`/`RECONCILING` not handled |
| `CreateTopics` rejected | `message.format.version` (removed in 4.0) still offered in the topic form |

---

## What changed and why

### 1. Version detection via the `metadata.version` feature

KRaft brokers (Kafka 3.3+, mandatory since 4.0) no longer expose
`inter.broker.protocol.version`, so the old logic fell back to `1.0-UNKNOWN`. That parsed to
`1.0f`, which disabled `INCREMENTAL_ALTER_CONFIGS` and forced the deprecated `alterConfigs`
path that breaks on Kafka 4.0.

Version detection now falls back to the finalized `metadata.version` feature obtained via
`AdminClient.describeFeatures()`, mapping the feature level to a release through the new
[`MetadataVersion`](../kafka-ui-api/src/main/java/com/provectus/kafka/ui/util/MetadataVersion.java)
enum (feature level `25` → `4.0-IV3`, currently mapped up to `4.2-IV1`). Ported from the
maintained [kafbat/kafka-ui](https://github.com/kafbat/kafka-ui) fork.

*Files:* `ReactiveAdminClient.java` (`ConfigRelatedInfo`/`SupportedFeature.forVersion`),
`util/MetadataVersion.java`.

### 2. Real active controller via the metadata quorum

In KRaft, `AdminClient.describeCluster().controller()` returns an arbitrary broker (brokers
advertise a random broker as the metadata `controllerId` for request forwarding — KIP-590),
so the UI marked the wrong broker as active controller and the count could change between
refreshes.

The active controller is now resolved from `describeMetadataQuorum().quorumInfo().leaderId()`
when available, mapping it to the matching broker node (or a bare node id for dedicated
controllers). ZooKeeper clusters don't support the API, so we fall back to
`describeCluster()`'s controller.

*Files:* `ReactiveAdminClient.resolveActiveController`.

### 3. Controller Type indicator (KRaft vs ZooKeeper)

The same `describeMetadataQuorum` probe now also tells us *which* metadata mode the cluster
runs in: a successful response ⇒ **KRaft**, an `UnsupportedVersionException` ⇒ **ZooKeeper**.
This is carried through `ClusterDescription` → `Statistics` → `InternalClusterState` →
the `ClusterStats` contract (`controllerType`) and rendered as a **Controller Type**
indicator on the Brokers page. The legacy `zooKeeperStatus` contract field stays deprecated
and unused.

*Files:* `ReactiveAdminClient.java`, `InternalClusterState.java`,
`kafka-ui-api.yaml` (`ControllerType` enum + `ClusterStats.controllerType`),
`BrokersList.tsx`.

### 4. KIP-848 consumer-group states (`ASSIGNING` / `RECONCILING`)

KIP-848 (the new consumer rebalance protocol) is GA and the default in Kafka 4.0. Groups on
the `consumer` protocol transiently report `ASSIGNING`/`RECONCILING`. These states are now
represented end-to-end: added to the `ConsumerGroupState` contract enum, mapped in
`ConsumerGroupMapper`, and given tooltip text in the frontend. Previously they collapsed to
`UNKNOWN` in the UI.

*Files:* `kafka-ui-api.yaml` (`ConsumerGroupState` enum), `ConsumerGroupMapper.java`,
`ConsumerGroupService.java` (sort priority), `lib/constants.ts`.

### 5. Removed `message.format.version` from the topic form

Topic-level `message.format.version` was removed in Kafka 4.0 (KIP-724); submitting it makes
`CreateTopics`/`AlterConfigs` fail with `InvalidConfigurationException`. It was removed from
the creatable/editable topic-config list.

*Files:* `lib/constants.ts` (`TOPIC_CUSTOM_PARAMS`).

### 6. New `ConfigSource` value

`DYNAMIC_CLIENT_METRICS_CONFIG` (KIP-714) was added to the `ConfigSource` mapping so the
3.9.x client's new config source doesn't fall through.

*Files:* `ReactiveAdminClient.java`.

### 7. Controller quorum panel

A new `GET /api/clusters/{clusterName}/metadata/quorum` endpoint exposes the full metadata
quorum from `describeMetadataQuorum()` — leader, epoch, high watermark, and every voter/observer
with its log-end-offset, lag (vs. the leader), and last-fetch / last-caught-up timestamps. The
Brokers page renders this as a **"Controller quorum (KRaft)"** panel, so **dedicated controllers
(`process.roles=controller`) are now visible** even though `describeCluster()` never returns them.
The endpoint returns 404 on ZooKeeper clusters and the panel hides itself.

*Files:* `ReactiveAdminClient.getMetadataQuorumInfo`, `BrokerService.getMetadataQuorum`,
`BrokersController`, `kafka-ui-api.yaml` (`MetadataQuorum`/`MetadataQuorumReplica` + path),
`BrokersList/KraftQuorum.tsx`, `lib/hooks/api/brokers.ts`.

### Dependency upgrades

| Dependency | From | To | Why |
| --- | --- | --- | --- |
| `kafka-clients` | `3.5.0` | `3.9.1` | full Kafka 4.0 protocol compatibility (the 3.9 client talks to 4.0 brokers; it is **not** the 4.0.x client — see [Limitations](#known-limitations)) |
| Lombok | `1.18.24` | `1.18.34` | builds on JDK 21 |

---

## Running it

Everything is built **inside Docker** — the host only needs Docker (no JDK / Node / Maven).

### Option A — build from source

```bash
docker build -t kafka-ui:kafka4 .
```

The multi-stage [`Dockerfile`](../Dockerfile) builds the React frontend and the Spring Boot
backend inside a JDK 17 + Maven container, then ships a slim JRE image.

### Option B — docker compose against a KRaft cluster

[`docker-compose.kafka4.yml`](../docker-compose.kafka4.yml) builds the image and points it at
a 3-broker PLAINTEXT KRaft cluster:

```bash
docker compose -f docker-compose.kafka4.yml up -d --build
# UI: http://localhost:8080
```

Edit `KAFKA_CLUSTERS_0_BOOTSTRAPSERVERS` to match your cluster. Key environment variables:

| Env var | Meaning |
| --- | --- |
| `KAFKA_CLUSTERS_0_NAME` | display name for the cluster |
| `KAFKA_CLUSTERS_0_BOOTSTRAPSERVERS` | comma-separated `host:port` bootstrap brokers |
| `DYNAMIC_CONFIG_ENABLED` | `true` to allow editing topic/broker configs from the UI |
| `AUTH_TYPE` | `DISABLED` for no UI auth (or configure OAuth/LDAP as upstream) |

### Option C — pull the pre-built image (GHCR)

A CI workflow publishes the runtime image to GitHub Container Registry. In the compose file,
remove the `build:` block and use:

```yaml
image: ghcr.io/charlychiu/kafka-ui:latest
```

If the package is private, run `docker login ghcr.io` first (or make the package public).

---

## KRaft topology notes

| Topology | `process.roles` | How the UI shows it |
| --- | --- | --- |
| **Combined** (the `docker-compose.kafka4.yml` default) | `broker,controller` on every node | Active Controller marks the broker that is the quorum leader; Controller Type = KRaft. Fully supported. |
| **Dedicated controllers** (recommended for production) | separate `controller`-only and `broker`-only nodes | Controller Type = KRaft and the Active Controller id are shown, but the controller-only nodes are **not** listed in the Brokers table (see Limitations). |

---

## Known limitations

These are documented honestly rather than silently shipped half-done:

- **Dedicated KRaft controllers** (`process.roles=controller`) don't appear in the *broker* table —
  `AdminClient.describeCluster()` returns broker-role nodes only — and the per-row "Active Controller"
  checkmark in that table won't mark them. They are, however, listed with their replication state in
  the new **Controller quorum (KRaft)** panel on the Brokers page (the leader is flagged there).
  Combined `broker,controller` mode is unaffected.
- **Consumer group type is not displayed.** Whether a group uses the classic or the new
  (KIP-848) `consumer` protocol (`ConsumerGroupDescription.type()`) is not yet surfaced.
- **`metadata.version` levels beyond `4.2-IV1`** are not yet in the `MetadataVersion` enum;
  extend the enum as new Kafka releases ship.
- **`kafka-clients` is pinned to `3.9.x`, not `4.0.x`.** The 3.9 client is protocol-compatible
  with 4.0 brokers and is sufficient for everything above. The new `Admin.listGroups(...)` entry
  point (KIP-1043) and **share groups** (KIP-932) / **streams groups** (KIP-1071) — Early Access
  and off by default in 4.0 — require the 4.0.x client and are not surfaced.

---

## Compatibility

| | Supported |
| --- | --- |
| Kafka brokers | 3.x and **4.0 (KRaft)**; ZooKeeper-mode clusters still work |
| Recognized `metadata.version` | feature levels `1` (`3.0-IV1`) … `29` (`4.2-IV1`) |
| Build JDK | 17 (inside the Docker build) |
| Runtime JRE | 17 |

## Roadmap

- Consumer group `type` (classic / consumer / share / streams) column.
- Bump to `kafka-clients` 4.x + `Admin.listGroups(...)` for share/streams group visibility.
- Extend `MetadataVersion` mapping as new releases ship.

## Attribution

Forked from [provectus/kafka-ui](https://github.com/provectus/kafka-ui) (Apache-2.0). KRaft
version-detection logic is ported from the maintained
[kafbat/kafka-ui](https://github.com/kafbat/kafka-ui) fork. See [`LICENSE`](../LICENSE).
