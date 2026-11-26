import './config/loadDotenv';
import { loadAppConfig } from './config/configSchema';
import { AppContainer } from './app/AppContainer';
import { logger } from './shared/logger';
import {
  describeUnhandledRejection,
  isExpectedCancellationRejection,
} from './shared/process/unhandledRejection';
import { startTracing } from './shared/telemetry';

const container = new AppContainer();
const env = loadAppConfig(process.env);
const port = env.PORT ?? 3000;

const startServer = async () => {
  try {
    // Initialize OpenTelemetry tracing before starting the server
    await startTracing();

    await container.start(port);
  } catch (error) {
    logger.error({ err: error }, 'Failed to start server');
    process.exit(1);
  }
};

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  const rejection = describeUnhandledRejection(reason);
  if (isExpectedCancellationRejection(reason)) {
    logger.warn({ err: reason, rejection, promise }, 'Detached cancellation rejection contained');
    return;
  }
  logger.error({ err: reason, rejection, promise }, 'Unhandled rejection');
  void container.stop().then(
    () => process.exit(1),
    () => process.exit(1),
  );
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.error({ err: error }, 'Uncaught exception');
  void container.stop().then(
    () => process.exit(1),
    () => process.exit(1),
  );
});

const shutdown = () => {
  void container.stop().finally(() => process.exit(0));
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

startServer();
