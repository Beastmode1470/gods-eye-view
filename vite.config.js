export { default } from './server/standalone/vite.config.js';
// Preserve existing test and tooling imports while provider modules are split.
export * from './server/providers/local.js';
export {
  resolveRecordingConfig,
  recordingPrivacyPlugin,
} from './tools/recording-config.mjs';
