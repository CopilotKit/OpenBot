import { startHermesBridgeFromEnv } from "./entrypoint";

if (import.meta.main) {
  try {
    const { server } = await startHermesBridgeFromEnv();
    console.info(`Hermes bridge listening on ${server.hostname}:${server.port}`);
  } catch {
    console.error("Hermes bridge did not start: configuration or roster readiness failed.");
    process.exitCode = 1;
  }
}
