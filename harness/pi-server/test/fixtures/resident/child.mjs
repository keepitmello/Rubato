// The supervised child of child-service.mjs. It ends with the thread that started it: when the IPC
// channel closes, the parent is gone.
process.on('disconnect', () => process.exit(0));
setInterval(() => {}, 1000);
const fault = process.argv[2];
setTimeout(() => {
  if (fault === 'throw') throw new Error('child throw');
  if (fault === 'reject') Promise.reject(new Error('child rejection'));
  if (fault === 'exit') process.exit(9);
}, 100);
