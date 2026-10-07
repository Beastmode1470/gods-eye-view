import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import { resolveAllowedHosts } from '../../build/allowedHosts.js';
import { createBrowserViteConfig } from '../../build/vite.js';
import { localProviderPlugins } from '../providers/local.js';
import { localMcpPlugin } from '../mcp/plugin.js';
import { apiNotFoundPlugin } from './api-not-found.js';
import { standaloneVoiceTools } from './voiceTools.js';
import path from 'node:path';
import { recordedVesselsProxy } from '../providers/vessels/recording.js';
import { hormuzProxy } from '../../tools/hormuz-proxy.mjs';
import {
  resolveRecordingConfig,
  recordingPrivacyPlugin,
} from '../../tools/recording-config.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

/** Load this checkout's configuration and attach its local provider middleware. */
export default defineConfig(({ command, mode }) => {
  const loaded = loadEnv(mode, root, '');
  for (const [key, value] of Object.entries(loaded)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
  const recording = resolveRecordingConfig(process.env);
  const config = createBrowserViteConfig({
    plugins: [
      recordingPrivacyPlugin(recording.enabled),
      ...(recording.external
        ? [hormuzProxy(recording.external)]
        : recording.source
          ? [
              recordedVesselsProxy({
                source: recording.source,
                dbPath: path.resolve(root, recording.dbPath),
                env: process.env,
              }),
            ]
          : []),
      ...localProviderPlugins({
        realtime: { tools: standaloneVoiceTools() },
        // AISStream recording reuses the live provider's singleton watchdog.
        // Hormuz and explicit local adapters must never start that connection.
        vessels:
          !recording.enabled ||
          (!recording.external && recording.source === 'aisstream'),
      }),
      ...(!recording.enabled ? [localMcpPlugin()] : []),
      apiNotFoundPlugin(),
    ],
    googleApiKey: process.env.GOOGLE_MAPS_API_KEY,
    cesiumToken: process.env.CESIUM_ION_TOKEN,
    mapillaryToken: process.env.MAPILLARY_CLIENT_TOKEN,
    host: process.env.HOST,
    port: process.env.PORT,
    allowedHosts: resolveAllowedHosts(process.env.GEV_ALLOWED_HOSTS),
    command,
  });
  config.define['import.meta.env.HORMUZ_RECORDED_MODE'] = JSON.stringify(
    recording.enabled,
  );
  config.define['import.meta.env.AIS_RECORDING_SOURCE'] = JSON.stringify(
    recording.source,
  );
  if (recording.enabled) {
    config.server.host ||= 'localhost';
    config.preview.host = config.server.host;
  }
  return config;
});
