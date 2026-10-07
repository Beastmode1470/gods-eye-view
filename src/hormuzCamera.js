/**
 * Hormuz-mode camera feel matching the retired energy viewer: wheel zoom moves
 * only along the view direction and middle-drag pivot is capped per frame.
 */

const MIN_HEIGHT_M = 3;
const MAX_HEIGHT_M = 22_000_000;
const STEP_FRACTION = 0.2;
// Cesium's stock tilt rate cap is 1.77; middle-drag uses ~40% of it.
const MIDDLE_DRAG_ROTATE_RATE = 0.7;

/** Signed wheel notches, normalized across pixel/line/page delta modes. */
export function wheelNotches(event) {
  const scale = event.deltaMode === 1 ? 33 : event.deltaMode === 2 ? 100 : 1;
  return Math.max(-3, Math.min(3, (event.deltaY * scale) / 100));
}

/** Install the camera feel; returns a disposer. */
export function applyHormuzCameraFeel(viewer, Cesium) {
  const controller = viewer.scene.screenSpaceCameraController;
  const camera = viewer.camera;
  const original = {
    inertiaSpin: controller.inertiaSpin,
    inertiaTranslate: controller.inertiaTranslate,
    inertiaZoom: controller.inertiaZoom,
    maximumMovementRatio: controller.maximumMovementRatio,
  };
  controller.inertiaSpin = 0.5;
  controller.inertiaTranslate = 0.5;
  controller.inertiaZoom = 0.25;
  controller.maximumMovementRatio = 0.04;
  const wheel = Cesium.CameraEventType.WHEEL;
  const withWheel = controller.zoomEventTypes;
  const withoutWheel = (
    Array.isArray(withWheel) ? withWheel : [withWheel]
  ).filter((type) => type !== wheel);
  controller.zoomEventTypes = withoutWheel;
  const scratch = new Cesium.Cartesian3();

  const onWheel = (event) => {
    // The upstream trackpad relay owns Ctrl+wheel pinch events.
    if (event.ctrlKey) return;
    // Tracked/cockpit cameras use a local reference frame; keep stock zoom there.
    if (!Cesium.Matrix4.equals(camera.transform, Cesium.Matrix4.IDENTITY)) {
      controller.zoomEventTypes = withWheel;
      return;
    }
    controller.zoomEventTypes = withoutWheel;
    if (!controller.enableInputs || !controller.enableZoom) return;
    const notches = wheelNotches(event);
    if (!notches) return;
    event.preventDefault();
    const height = Math.max(camera.positionCartographic.height, 10);
    let distance = -notches * height * STEP_FRACTION;
    const descent = Math.max(
      0,
      -Cesium.Cartesian3.dot(
        camera.direction,
        viewer.scene.globe.ellipsoid.geodeticSurfaceNormal(
          camera.position,
          scratch,
        ),
      ),
    );
    if (distance > 0 && descent > 0)
      distance = Math.min(distance, (height - MIN_HEIGHT_M) / descent);
    if (distance < 0 && descent > 0)
      distance = Math.max(distance, -(MAX_HEIGHT_M - height) / descent);
    if (!Number.isFinite(distance) || Math.abs(distance) < 1e-3) return;
    const { heading, pitch, roll } = camera;
    const destination = Cesium.Cartesian3.add(
      camera.position,
      Cesium.Cartesian3.multiplyByScalar(camera.direction, distance, scratch),
      new Cesium.Cartesian3(),
    );
    camera.setView({ destination, orientation: { heading, pitch, roll } });
    viewer.scene.requestRender();
  };
  // Cesium exposes no public tilt-speed option; scope the private rate cap to middle-drag only.
  const stockRotateRate = controller._maximumRotateRate;
  const onPointerDown = (event) => {
    if (event.button === 1 && Number.isFinite(stockRotateRate))
      controller._maximumRotateRate = MIDDLE_DRAG_ROTATE_RATE;
  };
  const onPointerUp = (event) => {
    if (event.button === 1) controller._maximumRotateRate = stockRotateRate;
  };
  const onCancel = () => {
    controller._maximumRotateRate = stockRotateRate;
  };
  viewer.canvas.addEventListener('wheel', onWheel, { passive: false });
  viewer.canvas.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onCancel);
  window.addEventListener('blur', onCancel);
  return () => {
    viewer.canvas.removeEventListener('wheel', onWheel);
    viewer.canvas.removeEventListener('pointerdown', onPointerDown);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onCancel);
    window.removeEventListener('blur', onCancel);
    controller._maximumRotateRate = stockRotateRate;
    controller.zoomEventTypes = withWheel;
    Object.assign(controller, original);
  };
}
