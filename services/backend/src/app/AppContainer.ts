import type http from 'http';
import createHttpApp from '@/interfaces/http/httpServer';
import {
  attachRunnerAgentWebSocketServer,
  type RunnerWebSocketServerHandle,
} from '@/interfaces/http/controllers/runner-agent.websocket';
import { createAppContext, type AppContext } from './createAppContext';
import { localSettings } from '@/config/configSchema';
import { codeSourcesRoot, configuredCodeRoot } from '@/domains/security-ops/code-sources/codeSourceLocation';
import { labTargetHosts } from '@/domains/security-ops/scopes/verificationChecks';
import { allowedHosts } from '@/interfaces/http/middleware/localHostOnly';
import { logger } from '@/shared/logger';
import { appUrl, ownerKeyFile, ownerLink } from '@/shared/auth/ownerKey';

export class AppContainer {
  private server?: http.Server;
  private context?: AppContext;
  private runnerWebSocketServer?: RunnerWebSocketServerHandle;

  async start(port: number = 3000): Promise<{ server: http.Server; context: AppContext }> {
    if (this.server) {
      return { server: this.server, context: this.context as AppContext };
    }

    const appContext = await createAppContext();
    const app = createHttpApp(appContext);
    await appContext.sessionStore.whenReady?.();

    // This computer only, unless NULL_AI_BIND_HOST says otherwise (in a container, 0.0.0.0 behind Docker's own loopback publish).
    const host = localSettings().NULL_AI_BIND_HOST;
    const server = app.listen(port, host, () => {
      logger.info(
        {
          event: 'server.start',
          host,
          port,
          nodeEnv: appContext.isDev ? 'development' : 'production',
          healthUrl: `http://localhost:${port}/health`,
        },
        'Server started',
      );
      // The effective local settings, once. Paths and host names only: never the owner key.
      logger.info(
        {
          event: 'config.local',
          bindHost: host,
          allowedHosts: [...allowedHosts()],
          appUrl: appUrl(),
          ownerKeyFile: ownerKeyFile(),
          labTargets: [...labTargetHosts()],
          codeRoot: configuredCodeRoot(),
          codeSourcesRoot: codeSourcesRoot(),
        },
        'Local settings',
      );
      // Printed, never logged: the link holds the owner key (shared/auth/ownerKey.ts).
      process.stdout.write(`
Null AI is ready. Open this link once in your browser:
  ${ownerLink(app.locals.ownerKey as string)}

`);
    });

    this.server = server;
    this.context = appContext;
    this.runnerWebSocketServer = attachRunnerAgentWebSocketServer(server, appContext);

    return { server, context: appContext };
  }

  async stop(): Promise<void> {
    const tasks: Promise<unknown>[] = [];

    if (this.server) {
      const closing = new Promise<void>((resolve, reject) => {
        this.server?.close((err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });
      tasks.push(closing);
      // SSE, keep-alive, or websocket-adjacent HTTP connections must not keep
      // shutdown—and therefore active provider calls—alive indefinitely.
      this.server.closeIdleConnections?.();
      this.server.closeAllConnections?.();
    }

    if (this.context?.dispose) {
      tasks.push(Promise.resolve(this.context.dispose()));
    }
    if (this.runnerWebSocketServer) {
      tasks.push(this.runnerWebSocketServer.close());
    }

    await Promise.allSettled(tasks);
    this.server = undefined;
    this.context = undefined;
    this.runnerWebSocketServer = undefined;
  }
}
