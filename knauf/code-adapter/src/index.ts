import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { connectMongo } from './store/mongo.js';
import { FilesRepo } from './store/filesRepo.js';
import { createBlobStore } from './azure/blobStore.js';
import { createTokenProvider } from './azure/credential.js';
import { createAcaClient } from './azure/acaClient.js';
import { createMetrics } from './middleware/metrics.js';
import { createApp } from './app.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  const mongo = await connectMongo(config);
  const repo = new FilesRepo(mongo.files, config.fileTtlHours);
  const blob = await createBlobStore(config);
  const tokens = createTokenProvider(config, logger);
  const aca = createAcaClient(config, logger, tokens);
  const metrics = createMetrics();

  const app = createApp({ config, logger, aca, blob, repo, mongo, metrics });
  const server = app.listen(config.port, () => {
    logger.info(
      {
        port: config.port,
        localMode: config.localMode,
        apiVersion: config.aca.apiVersion,
      },
      'code-adapter listening',
    );
  });

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'shutting down');
    server.close(() => {
      void mongo.close().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err: Error) => {
  // config fail-fast lands here before any logger exists
  console.error(`code-adapter failed to start: ${err.message}`);
  process.exit(1);
});
