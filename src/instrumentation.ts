export async function register(): Promise<void> {
  // The edge runtime has no file system or sockets; the dynamic import keeps the server code out of its bundle.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { start } = await import('./server/start');
    start();
  }
}
