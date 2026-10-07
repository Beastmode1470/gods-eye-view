# Record your own vessel feed and replay it

This fork can collect **public Hormuz snapshots** or **your own AISStream feed**.
It stores history in a local SQLite database and replays the frames you actually
recorded. There is no shared account, preloaded vessel archive, or dependency on
another repository. No API keys or operator databases are distributed here.

**Restricted work computer?** This setup requires an approved Node runtime for
the backend. If Node execution is prohibited or approval is uncertain, do not
run these commands or substitute a runtime bundled with another application.
Use an approved computer/host instead. A page that was already open does not
prove its backend is Node-free. GitHub Actions can check the code, but this
repository does not provision an approved remote viewer host.

## 1. Install this fork

Install Node.js **24.14 or later in the 24.x series**, or **26.x**, and Git.
These commands work in PowerShell, macOS Terminal and Linux shells:

```text
git clone https://github.com/Beastmode1470/gods-eye-view.git
cd gods-eye-view
npm ci
npm run doctor
```

Copy `.env.example` to `.env` with your editor. Both `.env` and `.env.local` are
ignored by Git. Start keyless, or add your own browser-restricted Cesium ion or
Google Maps credential for optional 3D imagery. **Do not paste keys into issues
or pull requests.** Map credentials have their own provider terms and quotas.

### Personal Mac: first run without changing an existing collector

Use a separate checkout of this fork on the Mac. Install a supported Node
version only where permitted, then follow the installation commands above.
Open the viewer **on the Mac itself**; keep the API bound to loopback. No SSH,
LAN sharing or laptop runtime is needed for this first test.

If the Mac already records Hormuz snapshots into the earlier SQLite format,
import a copy of those observations into this fork's **separate** database:

```text
npm run import:hormuz -- --from "/absolute/path/to/existing/hormuz.db" --db ".gev-cache/ais-history.sqlite"
```

The importer reads the source database without modifying it. Do not use the
source path as the output path, replace the existing collector installation,
or change its scheduled job. Keep a consistent backup. Repeating an import
deduplicates already imported batches; it does not recover unrecorded days.

Then configure the fork for Hormuz recording as below and run `npm run dev`.
This fork and the older collector use separate databases; they do not share a
writer. To avoid redundant public-source polling, stop the fork viewer when the
test is finished and leave the original collector collecting. An existing
local API is still the preferred read-only connection when one is available.

Before treating the Mac setup as ready, check the import summary and the history
panel's **actual first/last recorded times**. Seek a frame on an older recorded
day, play through midnight, seek backward, toggle the vessel layer off/on, and
return to **Latest ships**. Then check place search, aircraft, satellites and
public cameras. Provider outages or missing optional keys must show their own
limitations, not be presented as replay failures. Older daily totals do not
extend the individual-position coverage.

## 2. Choose one recording source

### Hormuz: regional public snapshots, no AISStream key

Set these values in your local `.env`:

```dotenv
HOST=127.0.0.1
AIS_RECORDING_SOURCE=hormuz
AIS_RECORDING_INTERVAL_SECONDS=900
```

Run `npm run dev`, then open `http://127.0.0.1:4173`. Collection runs while the
server is running; you do not need to keep a browser tab open. The upstream
publishes batches rather than a continuous stream. Polling faster does not make
the observations more live; intervals below ten minutes are rejected.

Snapshots come from [hormuz.data-tracking.net](https://hormuz.data-tracking.net).
Its summary and ship endpoints can update at different times. Recorded batches
are identified by the **ship payload's timestamp**, not a summary timestamp
alone. The collector does not request the upstream animation endpoint.

### AISStream: your own key and coverage

Register at [AISStream.io](https://aisstream.io), obtain your own API key, and set:

```dotenv
HOST=127.0.0.1
AIS_RECORDING_SOURCE=aisstream
AISSTREAM_API_KEY=YOUR_OWN_KEY
AIS_RECORDING_INTERVAL_SECONDS=60
```

Run `npm run dev`. The key remains server-side. The recorder consumes the app's
existing AISStream connection and normalizer; it does not open a second socket.
Do not run a second app or collector using that same key.

To reduce traffic and disk growth, optionally set a regional bounding box:

```dotenv
AISSTREAM_BOUNDING_BOXES=[[[50,-6],[59,3]]]
```

Coordinates are **latitude, longitude**: southwest corner, then northeast
corner. Pick a region actually covered by the provider's receivers.
An AISStream key does not guarantee Persian Gulf, satellite AIS or worldwide
coverage. A quiet region is not proof there are no ships there.

## 3. Replay

Enable the recorded vessel layer and open **History / Replay**. Select a recorded
date, seek within its frames, or press **Play**. Playback proceeds chronologically
across recorded days. **Latest ships** returns to the latest available snapshot.
Refresh history to discover frames collected since the panel was opened.

Use `npm run dev` while configuring recording. To check a production build, run
`npm run build` with the same recording settings, then `npm run preview`.
Rebuild after changing the recording source or external collector mode so the
browser's feature configuration matches the server. Preview is a local check,
not an authenticated production deployment.

An empty installation has no vessel history yet. Leave collection running until
positions arrive. Replay cannot recover observations from before you started,
from a sleeping computer, or from a provider/network outage.

Recorded timestamps and coordinates are observations. Short-gap animation may
interpolate the display between fixes; it does not create recorded evidence.
Daily crossing counts, when available, are aggregates rather than simultaneous
ships. Any daily-count corridor illustration is labelled **SIMULATED**, not an
actual route, a verified crossing or proof that an attack caused a movement.

## 4. Collect without keeping the viewer running

For an always-on computer, run the headless collector from the fork:

```text
npm run collect:ais -- --help
npm run collect:ais -- --source hormuz --port 8908
```

For AISStream, use `--source aisstream` and keep your own `AISSTREAM_API_KEY` in
the collector's environment file. The collector runs in the foreground until
stopped. For unattended operation, configure your operating system's service
manager or scheduler to start this command in the repository directory, restart
on failure, retain logs, and keep the computer awake. No machine-specific
account, SSH key or scheduler installation is assumed.

In the **viewer's** environment, disable its own recorder and point it at the
already-running collector:

```dotenv
HOST=127.0.0.1
AIS_RECORDING_SOURCE=
HORMUZ_API_URL=http://127.0.0.1:8908
```

Use only one writer per database and only one AISStream connection per key.
`HORMUZ_API_URL` is a legacy setting name; the bundled collector reports whether
its actual source is Hormuz or AISStream. It must be a loopback HTTP origin.
This is not an authenticated public hosting API.

For different computers, transfer a consistent backup and run the collector/API
locally on the viewer computer. Do not expose an unauthenticated collector by
port forwarding, disable the loopback check, or copy a live SQLite/WAL file pair.
Remote/cloud sync and authenticated multi-user hosting are not implemented.

## 5. Storage and existing installations

The default database is `.gev-cache`'s `ais-history.sqlite`; override
`AIS_RECORDING_DB` to use another local path. Databases and their WAL/SHM files
are ignored by Git and must never be placed in `public`. History grows while
collection runs; monitor disk usage and take backups. No automatic deletion of
old observations is implied.

For a simple safe backup, stop the collector cleanly, copy its database, then
restart it. Preserve the original file before changing configuration or updating
the application. Keep Hormuz and AISStream in separate databases; they have
different coverage and snapshot semantics.

**Already running the earlier Hormuz collector?** Keep its database and
collection job unchanged. Point `HORMUZ_API_URL` at its local API. This preserves
access to that collector's recorded frames and optional daily history without
requiring a database conversion. The new recorder has its own schema; do not
point `AIS_RECORDING_DB` at an older collector's database. Use `import:hormuz`
to copy a supported older archive into a separate database when no compatible
local API is installed. Existing local collector sync remains your responsibility.

The new standalone recorder does not contain an energy-price forecasting model,
news collector, PortWatch backfill or cloud sync. Older external backends may
provide additional daily aggregate context; it is not individual-vessel replay.

## Troubleshooting and data rights

| Symptom | Check |
| --- | --- |
| No recorded dates | Confirm the collector is running, positions are arriving, and the selected database is the intended one. |
| AISStream quiet | Check your key, subscription area, provider status and reported feed health. Do not continually restart against a connection limit. |
| Hormuz frame unchanged | The provider has not published a new ship batch yet; a newer summary alone is insufficient. |
| Replay day has no frames | It is a collection gap, not zero traffic. Select an observed date. |
| Source mismatch / database already in use | Stop the other collector or choose a separate database; do not mix sources. |
| Loopback configuration rejected | Use `HOST=127.0.0.1` and a local HTTP collector origin, not a LAN or public host. |
| Energy forecast unavailable | Expected with the standalone recorder; the energy model is not included. |

AIS reception is incomplete, source availability can change, and AIS can be
spoofed. These displays are not for navigation, attribution, or an exact census.
Public accessibility and `robots.txt` are **not redistribution permission**.
Review each provider's current collection, retention, sharing and commercial-use
terms before operating or redistributing an archive; obtain permission where
required. See [data attribution](../DATA_SOURCES.md) and
[credential safety](../SECURITY.md).
