// Senpi extension: wrap fetch after process start, before provider overlay.
import { installDirectWireCapture } from "./direct-wire-capture.mjs";

installDirectWireCapture();

export default function directWireExtension() {
  // fetch wrap is the only job; no pi hooks.
}
