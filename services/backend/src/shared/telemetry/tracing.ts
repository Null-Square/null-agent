/**
 * OpenTelemetry SDK Initialization
 * 
 * This module initializes the OpenTelemetry SDK for distributed tracing.
 * Must be imported and started before any other application code.
 * 
 * @module tracing
 */

import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { resourceFromAttributes, type Resource } from '@opentelemetry/resources';
import {
    SEMRESATTRS_SERVICE_NAME,
    SEMRESATTRS_SERVICE_VERSION,
    SEMRESATTRS_DEPLOYMENT_ENVIRONMENT,
} from '@opentelemetry/semantic-conventions';
import { logger } from '@/shared/logger';

let sdk: NodeSDK | null = null;

/**
 * Check if OpenTelemetry tracing is enabled via environment variable
 */
export function isTracingEnabled(): boolean {
    return process.env.OTEL_TRACES_ENABLED === 'true';
}

/**
 * Get the OpenTelemetry trace exporter endpoint
 */
function getOTLPEndpoint(): string {
    return process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4317';
}

/**
 * Get service resource attributes
 */
function getResource(): Resource {
    return resourceFromAttributes({
        [SEMRESATTRS_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || 'nullai-backend',
        [SEMRESATTRS_SERVICE_VERSION]: process.env.npm_package_version || '0.0.0',
        [SEMRESATTRS_DEPLOYMENT_ENVIRONMENT]: process.env.NODE_ENV || 'development',
    });
}

/**
 * Start the OpenTelemetry SDK
 * 
 * Initializes auto-instrumentation for:
 * - HTTP/HTTPS requests
 * - Express middleware
 * - pg/postgres database calls
 * - Redis operations
 * - DNS lookups
 * - Net sockets
 */
export async function startTracing(): Promise<void> {
    if (!isTracingEnabled()) {
        logger.info('OpenTelemetry tracing is disabled (OTEL_TRACES_ENABLED != true)');
        return;
    }

    if (sdk) {
        logger.warn('OpenTelemetry SDK already started');
        return;
    }

    try {
        const endpoint = getOTLPEndpoint();
        logger.info({ endpoint }, 'Initializing OpenTelemetry SDK');

        const traceExporter = new OTLPTraceExporter({
            url: endpoint,
        });

        sdk = new NodeSDK({
            resource: getResource(),
            traceExporter,
            instrumentations: [
                getNodeAutoInstrumentations({
                    // Disable noisy instrumentations
                    '@opentelemetry/instrumentation-fs': { enabled: false },
                    '@opentelemetry/instrumentation-dns': { enabled: false },
                    // Enable key instrumentations
                    '@opentelemetry/instrumentation-http': { enabled: true },
                    '@opentelemetry/instrumentation-express': { enabled: true },
                    '@opentelemetry/instrumentation-pg': { enabled: true },
                    '@opentelemetry/instrumentation-redis': { enabled: true },
                    '@opentelemetry/instrumentation-ioredis': { enabled: true },
                }),
            ],
        });

        await sdk.start();
        logger.info('OpenTelemetry SDK started successfully');

        // Graceful shutdown on process exit
        const shutdown = async () => {
            try {
                await sdk?.shutdown();
                logger.info('OpenTelemetry SDK shut down successfully');
            } catch (error) {
                logger.error({ error }, 'Error shutting down OpenTelemetry SDK');
            }
        };

        process.on('SIGTERM', shutdown);
        process.on('SIGINT', shutdown);
    } catch (error) {
        logger.error({ error }, 'Failed to initialize OpenTelemetry SDK');
        // Don't throw - tracing is non-critical
    }
}

/**
 * Stop the OpenTelemetry SDK
 */
export async function stopTracing(): Promise<void> {
    if (sdk) {
        await sdk.shutdown();
        sdk = null;
        logger.info('OpenTelemetry SDK stopped');
    }
}
