// Preload for engine-stop.test.mjs: a handle nothing ever closes, as an extension or a stuck
// close can leave behind. It keeps the event loop alive after the engine has closed.
setInterval(() => {}, 60_000);
