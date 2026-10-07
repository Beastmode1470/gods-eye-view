import { createStandaloneCatalog } from './catalog.js';
import { createStandalonePlaceSearch } from './placeSearch.js';
import { CITY_POIS } from '../locations.js';
import { createApplication } from '../app/application.js';
import { createStandaloneScene } from './scene.js';
import { createStandaloneControls } from './controls.js';
import { createStandaloneData } from './data.js';
import { createStandaloneTools } from './tools.js';
import { createGoogleTokenSource } from '../maps/googleTokens.js';
import * as Cesium from 'cesium';
import { loadHormuzMapConfig } from '../hormuzMapConfig.js';
import { applyHormuzCameraFeel } from '../hormuzCamera.js';
import { initHormuzHistory } from '../hormuzHistory.js';
import { createHormuzTrafficIllustration } from '../hormuzTrafficIllustration.js';
import { recordingTitle } from '../recordingMode.js';

// The existing controls and layer catalog contain page-scoped state.
let constructed = false;

/** Compose the standalone application once per page. Reload to start again. */
export function createStandaloneApplication({
  googleApiKey,
  cesiumToken,
  geospatial = {},
  voice = {},
  allowQaRegistration = false,
}) {
  if (constructed)
    throw new Error('The standalone application already owns this page');
  constructed = true;
  const loadingScreen = document.getElementById('loading-screen');
  const loaderStatus = loadingScreen.querySelector('.loader-status');
  let placeSearch;
  let catalog;
  let recordingConfig;
  return createApplication({
    createScene: async (context) => {
      if (import.meta.env?.HORMUZ_RECORDED_MODE) {
        recordingConfig = await loadHormuzMapConfig();
        context.signal.throwIfAborted();
        googleApiKey = recordingConfig.googleMapsKey || googleApiKey;
        cesiumToken = recordingConfig.cesiumToken || cesiumToken;
        const previousTitle = document.title;
        document.title = `${recordingTitle(recordingConfig.recordingSource)} | God's Eye View`;
        context.defer(() => {
          document.title = previousTitle;
        });
      }
      placeSearch = createStandalonePlaceSearch({
        // The bundled city and landmark data the offline name provider reads.
        // The search package takes it as plain data rather than importing it,
        // so it stays free of application state.
        presets: CITY_POIS,
        ...geospatial,
        resolveApiKey: () => googleApiKey,
        signal: context.signal,
      });
      const scene = await createStandaloneScene({
        ...context,
        googleApiKey,
        // Without a key, Google 3D can still load with tokens from the
        // app's server when it offers them.
        googleTokens: googleApiKey ? null : createGoogleTokenSource(),
        cesiumToken,
        loaderStatus,
      });
      if (recordingConfig)
        context.defer(applyHormuzCameraFeel(scene.viewer, Cesium));
      catalog = createStandaloneCatalog({
        nepalBoundaryResolver: (signal) =>
          scene.operations.annotationResolver.resolveRegionRingForQuery(
            'Nepal',
            signal,
            placeSearch,
            // The locator draws the border whenever it arrives.
            { budgetMs: Infinity },
          ),
        signal: context.signal,
        surface: scene.operations.surface,
      });
      if (recordingConfig) {
        const vessels = catalog.layers.find(
          (layer) => layer.id === 'ais-live-vessels',
        );
        vessels.configureRecordingSource(recordingConfig.recordingSource);
      }
      return scene;
    },
    createControls: (context) =>
      createStandaloneControls({
        ...context,
        loaderStatus,
        placeSearch,
        catalog,
        startupCamera: recordingConfig?.center
          ? (viewer) => {
              const { lon, lat, height } = recordingConfig.center;
              viewer.camera.flyTo({
                destination: Cesium.Cartesian3.fromDegrees(lon, lat, height),
                orientation: { heading: 0, pitch: -Math.PI / 3, roll: 0 },
                duration: 2,
              });
              return () => viewer.camera.cancelFlight();
            }
          : undefined,
      }),
    createData: (context) => {
      const data = createStandaloneData({
        ...context,
        allowQaRegistration,
        catalog,
      });
      if (recordingConfig)
        context.defer(
          initHormuzHistory(
            data.dataManager,
            data.dataManager.layers.get('ais-live-vessels').module,
            context.scene.viewer,
            recordingConfig.recordingSource,
            { createIllustration: createHormuzTrafficIllustration },
          ),
        );
      return data;
    },
    createTools: (context) =>
      createStandaloneTools({ ...context, loadingScreen, placeSearch, voice }),
  });
}
