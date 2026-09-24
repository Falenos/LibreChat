'use strict';

const DEFAULTS = Object.freeze({
  batchSize: 25,
  pauseMs: 250,
  maxDocuments: 1000,
  maxTimeMS: 30000,
});

const MAXIMUMS = Object.freeze({
  batchSize: 100,
  pauseMs: 10000,
  maxDocuments: 10000,
  maxTimeMS: 120000,
});

const MISSING_PROJECT_FILTER = Object.freeze({
  chatProjectId: { $exists: false },
});

class BackfillError extends Error {
  constructor(message, summary) {
    super(message);
    this.name = 'BackfillError';
    this.summary = summary;
  }
}

function parseInteger(value, name, { min = 1, max } = {}) {
  if (value == null || value === '') {
    throw new Error(`${name} requires a value`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || (max != null && parsed > max)) {
    throw new Error(`${name} must be an integer from ${min}${max == null ? '' : ` to ${max}`}`);
  }
  return parsed;
}

function parseArgs(argv) {
  const options = { ...DEFAULTS, apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case '--apply':
        options.apply = true;
        break;
      case '--expected-count':
        options.expectedCount = parseInteger(argv[++index], argument, { min: 0 });
        break;
      case '--max-documents':
        options.maxDocuments = parseInteger(argv[++index], argument, {
          max: MAXIMUMS.maxDocuments,
        });
        break;
      case '--batch-size':
        options.batchSize = parseInteger(argv[++index], argument, {
          max: MAXIMUMS.batchSize,
        });
        break;
      case '--pause-ms':
        options.pauseMs = parseInteger(argv[++index], argument, {
          max: MAXIMUMS.pauseMs,
        });
        break;
      case '--max-time-ms':
        options.maxTimeMS = parseInteger(argv[++index], argument, {
          max: MAXIMUMS.maxTimeMS,
        });
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown option: ${argument}`);
    }
  }
  if (options.apply && options.expectedCount == null) {
    throw new Error('--apply requires --expected-count');
  }
  return options;
}

function invariantSnapshot(document) {
  return ['createdAt', 'updatedAt', '_meiliIndex'].map((field) => {
    if (!Object.prototype.hasOwnProperty.call(document, field)) {
      return [field, false, null];
    }
    const value = document[field];
    return [field, true, value instanceof Date ? value.toISOString() : value];
  });
}

function assertInvariants(before, after) {
  const afterById = new Map(after.map((document) => [String(document._id), document]));
  for (const document of before) {
    const updated = afterById.get(String(document._id));
    if (
      !updated ||
      JSON.stringify(invariantSnapshot(document)) !== JSON.stringify(invariantSnapshot(updated))
    ) {
      throw new Error('A protected timestamp or index marker changed during migration');
    }
  }
}

async function countOrphanedProjectReferences({
  conversationCollection,
  projectCollection,
  maxTimeMS,
}) {
  const projectCollectionName = projectCollection.collectionName || 'chatprojects';
  const cursor = conversationCollection.aggregate(
    [
      { $match: { chatProjectId: { $type: 'string' } } },
      {
        $set: {
          _projectObjectId: {
            $convert: {
              input: '$chatProjectId',
              to: 'objectId',
              onError: null,
              onNull: null,
            },
          },
        },
      },
      {
        $lookup: {
          from: projectCollectionName,
          let: { projectId: '$_projectObjectId', owner: '$user' },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [{ $eq: ['$_id', '$$projectId'] }, { $eq: ['$user', '$$owner'] }],
                },
              },
            },
            { $limit: 1 },
          ],
          as: '_matchingProjects',
        },
      },
      { $match: { '_matchingProjects.0': { $exists: false } } },
      { $count: 'count' },
    ],
    { maxTimeMS },
  );
  const result = await cursor.next();
  return result?.count ?? 0;
}

const delay = (milliseconds) =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

async function runBackfill({
  conversationCollection,
  projectCollection,
  options,
  sleep = delay,
  countOrphans = countOrphanedProjectReferences,
}) {
  const matched = await conversationCollection.countDocuments(MISSING_PROJECT_FILTER, {
    maxTimeMS: options.maxTimeMS,
  });
  const summary = {
    mode: options.apply ? 'apply' : 'dry-run',
    scanned: 0,
    matched,
    modified: 0,
    remaining: matched,
    failures: 0,
  };

  if (matched > options.maxDocuments) {
    throw new BackfillError('Live count exceeds --max-documents; no writes performed', summary);
  }
  if (options.apply && matched !== options.expectedCount) {
    throw new BackfillError(
      'Live count does not match --expected-count; no writes performed',
      summary,
    );
  }
  if (!options.apply) {
    summary.orphanedProjectReferences = await countOrphans({
      conversationCollection,
      projectCollection,
      maxTimeMS: options.maxTimeMS,
    });
    return summary;
  }

  try {
    const targetIds = [];
    let lastId;
    while (true) {
      const filter = {
        ...MISSING_PROJECT_FILTER,
        ...(lastId == null ? {} : { _id: { $gt: lastId } }),
      };
      const idBatch = await conversationCollection
        .find(filter, {
          projection: { _id: 1 },
          maxTimeMS: options.maxTimeMS,
        })
        .sort({ _id: 1 })
        .limit(options.batchSize)
        .toArray();
      if (idBatch.length === 0) {
        break;
      }
      targetIds.push(...idBatch.map((document) => document._id));
      lastId = idBatch[idBatch.length - 1]._id;
      if (targetIds.length > options.maxDocuments) {
        throw new Error('Target snapshot exceeds --max-documents');
      }
    }
    if (targetIds.length !== matched) {
      throw new Error('Missing-field count changed while taking the target snapshot');
    }

    for (let offset = 0; offset < targetIds.length; offset += options.batchSize) {
      const ids = targetIds.slice(offset, offset + options.batchSize);
      const batch = await conversationCollection
        .find(
          { _id: { $in: ids } },
          {
            projection: { _id: 1, createdAt: 1, updatedAt: 1, _meiliIndex: 1 },
            maxTimeMS: options.maxTimeMS,
          },
        )
        .toArray();
      summary.scanned += batch.length;
      const result = await conversationCollection.updateMany(
        { _id: { $in: ids }, chatProjectId: { $exists: false } },
        { $set: { chatProjectId: null } },
        { maxTimeMS: options.maxTimeMS },
      );
      summary.modified += result.modifiedCount;

      const after = await conversationCollection
        .find(
          { _id: { $in: ids } },
          {
            projection: { _id: 1, createdAt: 1, updatedAt: 1, _meiliIndex: 1 },
            maxTimeMS: options.maxTimeMS,
          },
        )
        .toArray();
      assertInvariants(batch, after);

      if (offset + options.batchSize < targetIds.length) {
        await sleep(options.pauseMs);
      }
    }
  } catch (error) {
    summary.failures += 1;
    summary.remaining = await conversationCollection.countDocuments(MISSING_PROJECT_FILTER, {
      maxTimeMS: options.maxTimeMS,
    });
    throw new BackfillError(error.message, summary);
  }

  summary.remaining = await conversationCollection.countDocuments(MISSING_PROJECT_FILTER, {
    maxTimeMS: options.maxTimeMS,
  });
  if (summary.remaining !== 0) {
    summary.failures += 1;
    throw new BackfillError('Missing chatProjectId rows remain after apply', summary);
  }
  return summary;
}

function usage() {
  return [
    'usage: node knauf/scripts/backfill-chat-project-id.js [options]',
    '',
    'Defaults to dry-run. Apply requires --apply --expected-count <count>.',
    `--batch-size <1-${MAXIMUMS.batchSize}> (default ${DEFAULTS.batchSize})`,
    `--pause-ms <1-${MAXIMUMS.pauseMs}> (default ${DEFAULTS.pauseMs})`,
    `--max-documents <1-${MAXIMUMS.maxDocuments}> (default ${DEFAULTS.maxDocuments})`,
    `--max-time-ms <1-${MAXIMUMS.maxTimeMS}> (default ${DEFAULTS.maxTimeMS})`,
  ].join('\n');
}

async function main({ argv = process.argv.slice(2), env = process.env, log = console.log } = {}) {
  const options = parseArgs(argv);
  if (options.help) {
    log(usage());
    return;
  }
  if (!env.MONGO_URI) {
    throw new Error('MONGO_URI is required');
  }

  const path = require('path');
  require('module-alias')({ base: path.resolve(__dirname, '..', '..', 'api') });
  const connect = require('../../config/connect');
  const mongoose = require('mongoose');

  try {
    await connect();
    const database = mongoose.connection.db;
    const summary = await runBackfill({
      conversationCollection: database.collection('conversations'),
      projectCollection: database.collection('chatprojects'),
      options,
    });
    log(JSON.stringify(summary));
  } finally {
    await mongoose.disconnect();
  }
}

module.exports = {
  DEFAULTS,
  MAXIMUMS,
  MISSING_PROJECT_FILTER,
  BackfillError,
  parseArgs,
  invariantSnapshot,
  assertInvariants,
  countOrphanedProjectReferences,
  runBackfill,
  usage,
  main,
};

if (require.main === module) {
  main().catch((error) => {
    if (error.summary) {
      console.error(JSON.stringify(error.summary));
    } else {
      console.error(error.message);
    }
    process.exitCode = 1;
  });
}
