import IoRedis from 'ioredis';
import { logger } from '@librechat/data-schemas';
import { createClient, createCluster } from '@keyv/redis';
import type { ScanCommandOptions } from '@redis/client/dist/lib/commands/SCAN';
import type { RedisClientType, RedisClusterType } from '@redis/client';
import type { Redis, Cluster } from 'ioredis';
import { cacheConfig } from './cacheConfig';

const urls = cacheConfig.REDIS_URI?.split(',').map((uri) => new URL(uri)) || [];
const username = urls?.[0]?.username || cacheConfig.REDIS_USERNAME;
const password = urls?.[0]?.password || cacheConfig.REDIS_PASSWORD;
const ca = cacheConfig.REDIS_CA;

// [knauf] Keep every ioredis connection active against Azure Redis idle timeouts.
const ioredisPingIntervals = new WeakMap<Redis | Cluster, NodeJS.Timeout>();

const clearIoredisPingInterval = (client: Redis | Cluster): void => {
  const interval = ioredisPingIntervals.get(client);
  if (!interval) {
    return;
  }

  clearInterval(interval);
  ioredisPingIntervals.delete(client);
};

const attachIoredisPingInterval = (client: Redis | Cluster, clientName = 'ioredis'): void => {
  if (cacheConfig.REDIS_PING_INTERVAL <= 0 || ioredisPingIntervals.has(client)) {
    return;
  }

  const interval = setInterval(() => {
    if (client.status === 'ready') {
      client.ping().catch((err) => {
        logger.error(`${clientName} ping failed:`, err);
      });
    }
  }, cacheConfig.REDIS_PING_INTERVAL * 1000);
  interval.unref?.();

  ioredisPingIntervals.set(client, interval);
  // Keep the timer across transient close/retry cycles; only end is terminal.
  client.once('end', () => clearIoredisPingInterval(client));
};
// End [knauf]

let ioredisClient: Redis | Cluster | null = null;
if (cacheConfig.USE_REDIS) {
  const redisOptions: Record<string, unknown> = {
    username: username,
    password: password,
    tls: ca ? { ca } : undefined,
    keyPrefix: `${cacheConfig.REDIS_KEY_PREFIX}${cacheConfig.GLOBAL_PREFIX_SEPARATOR}`,
    maxListeners: cacheConfig.REDIS_MAX_LISTENERS,
    retryStrategy: (times: number) => {
      if (
        cacheConfig.REDIS_RETRY_MAX_ATTEMPTS > 0 &&
        times > cacheConfig.REDIS_RETRY_MAX_ATTEMPTS
      ) {
        logger.error(
          `ioredis giving up after ${cacheConfig.REDIS_RETRY_MAX_ATTEMPTS} reconnection attempts`,
        );
        return null;
      }
      const base = Math.min(Math.pow(2, times) * 50, cacheConfig.REDIS_RETRY_MAX_DELAY);
      const jitter = Math.floor(Math.random() * Math.min(base, 1000));
      const delay = Math.min(base + jitter, cacheConfig.REDIS_RETRY_MAX_DELAY);
      logger.info(`ioredis reconnecting... attempt ${times}, delay ${delay}ms`);
      return delay;
    },
    reconnectOnError: (err: Error) => {
      const targetError = 'READONLY';
      if (err.message.includes(targetError)) {
        logger.warn('ioredis reconnecting due to READONLY error');
        return 2; // Return retry delay instead of boolean
      }
      return false;
    },
    enableOfflineQueue: cacheConfig.REDIS_ENABLE_OFFLINE_QUEUE,
    connectTimeout: cacheConfig.REDIS_CONNECT_TIMEOUT,
    maxRetriesPerRequest: 3,
  };

  ioredisClient =
    urls.length === 1 && !cacheConfig.USE_REDIS_CLUSTER
      ? new IoRedis(cacheConfig.REDIS_URI!, redisOptions)
      : new IoRedis.Cluster(
          urls.map((url) => ({ host: url.hostname, port: parseInt(url.port, 10) || 6379 })),
          {
            ...(cacheConfig.REDIS_USE_ALTERNATIVE_DNS_LOOKUP
              ? {
                  dnsLookup: (
                    address: string,
                    callback: (err: Error | null, address: string) => void,
                  ) => callback(null, address),
                }
              : {}),
            redisOptions,
            clusterRetryStrategy: (times: number) => {
              if (
                cacheConfig.REDIS_RETRY_MAX_ATTEMPTS > 0 &&
                times > cacheConfig.REDIS_RETRY_MAX_ATTEMPTS
              ) {
                logger.error(
                  `ioredis cluster giving up after ${cacheConfig.REDIS_RETRY_MAX_ATTEMPTS} reconnection attempts`,
                );
                return null;
              }
              const base = Math.min(Math.pow(2, times) * 100, cacheConfig.REDIS_RETRY_MAX_DELAY);
              const jitter = Math.floor(Math.random() * Math.min(base, 1000));
              const delay = Math.min(base + jitter, cacheConfig.REDIS_RETRY_MAX_DELAY);
              logger.info(`ioredis cluster reconnecting... attempt ${times}, delay ${delay}ms`);
              return delay;
            },
            enableOfflineQueue: cacheConfig.REDIS_ENABLE_OFFLINE_QUEUE,
          },
        );

  ioredisClient.on('error', (err) => {
    logger.error('ioredis client error:', err);
  });

  ioredisClient.on('connect', () => {
    logger.info('ioredis client connected');
  });

  ioredisClient.on('ready', () => {
    logger.info('ioredis client ready');
  });

  ioredisClient.on('reconnecting', (delay: number) => {
    logger.info(`ioredis client reconnecting in ${delay}ms`);
  });

  ioredisClient.on('close', () => {
    logger.warn('ioredis client connection closed');
  });

  // [knauf] Attach reusable keepalive so reconnects and duplicated clients keep pinging.
  attachIoredisPingInterval(ioredisClient);
  // End [knauf]
}

let keyvRedisClient: RedisClientType | RedisClusterType | null = null;
let keyvRedisClientReady:
  | Promise<void>
  | Promise<RedisClientType<Record<string, never>, Record<string, never>, Record<string, never>>>
  | null = null;

if (cacheConfig.USE_REDIS) {
  /**
   * ** WARNING ** Keyv Redis client does not support Prefix like ioredis above.
   * The prefix feature will be handled by the Keyv-Redis store in cacheFactory.js
   */
  const redisOptions: Record<string, unknown> = {
    username,
    password,
    socket: {
      tls: ca != null,
      ca,
      connectTimeout: cacheConfig.REDIS_CONNECT_TIMEOUT,
      reconnectStrategy: (retries: number) => {
        if (
          cacheConfig.REDIS_RETRY_MAX_ATTEMPTS > 0 &&
          retries > cacheConfig.REDIS_RETRY_MAX_ATTEMPTS
        ) {
          logger.error(
            `@keyv/redis client giving up after ${cacheConfig.REDIS_RETRY_MAX_ATTEMPTS} reconnection attempts`,
          );
          return new Error('Max reconnection attempts reached');
        }
        const base = Math.min(Math.pow(2, retries) * 100, cacheConfig.REDIS_RETRY_MAX_DELAY);
        const jitter = Math.floor(Math.random() * Math.min(base, 1000));
        const delay = Math.min(base + jitter, cacheConfig.REDIS_RETRY_MAX_DELAY);
        logger.info(`@keyv/redis reconnecting... attempt ${retries}, delay ${delay}ms`);
        return delay;
      },
    },
    disableOfflineQueue: !cacheConfig.REDIS_ENABLE_OFFLINE_QUEUE,
    ...(cacheConfig.REDIS_PING_INTERVAL > 0
      ? { pingInterval: cacheConfig.REDIS_PING_INTERVAL * 1000 }
      : {}),
  };

  keyvRedisClient =
    urls.length === 1 && !cacheConfig.USE_REDIS_CLUSTER
      ? createClient({ url: cacheConfig.REDIS_URI, ...redisOptions })
      : createCluster({
          rootNodes: urls.map((url) => ({ url: url.href })),
          defaults: redisOptions,
        });

  // Add scanIterator method to cluster client for API consistency with standalone client
  if (!('scanIterator' in keyvRedisClient)) {
    const clusterClient = keyvRedisClient as RedisClusterType;
    (keyvRedisClient as unknown as RedisClientType).scanIterator = async function* (
      options?: ScanCommandOptions,
    ) {
      const masters = clusterClient.masters;
      for (const master of masters) {
        const nodeClient = await clusterClient.nodeClient(master);
        for await (const key of nodeClient.scanIterator(options)) {
          yield key;
        }
      }
    };
  }

  keyvRedisClient.setMaxListeners(cacheConfig.REDIS_MAX_LISTENERS);

  keyvRedisClient.on('error', (err) => {
    logger.error('@keyv/redis client error:', err);
  });

  keyvRedisClient.on('connect', () => {
    logger.info('@keyv/redis client connected');
  });

  keyvRedisClient.on('ready', () => {
    logger.info('@keyv/redis client ready');
  });

  keyvRedisClient.on('reconnecting', () => {
    logger.info('@keyv/redis client reconnecting...');
  });

  keyvRedisClient.on('disconnect', () => {
    logger.warn('@keyv/redis client disconnected');
  });

  // Start connection immediately
  keyvRedisClientReady = keyvRedisClient.connect();

  keyvRedisClientReady.catch((err): void => {
    logger.error('@keyv/redis initial connection failed:', err);
  });
}

export { attachIoredisPingInterval, ioredisClient, keyvRedisClient, keyvRedisClientReady };
