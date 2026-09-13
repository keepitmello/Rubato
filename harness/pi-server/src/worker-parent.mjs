// Only server-owned RPC workers receive an IPC descriptor. A crashed server
// must not leave a second writer behind when its profile is opened again.
if (process.connected) process.once('disconnect', () => process.exit(0));
