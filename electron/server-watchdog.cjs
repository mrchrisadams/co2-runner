// electron/server-watchdog.cjs — preloaded into the server child via
// NODE_OPTIONS --require. When the Electron shell dies without a graceful
// quit (SIGKILL, terminal kill), macOS delivers nothing to the child and it
// would keep the port + SQLite history DB open as an orphan. Exit instead.
// No-op while the shell lives; the timer is unref'd so it never keeps the
// event loop alive on its own.
const initialParentPid = process.ppid;
setInterval(() => {
  if (process.ppid !== initialParentPid) {
    process.exit(1);
  }
}, 1000).unref();
