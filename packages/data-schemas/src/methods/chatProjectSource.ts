// [knauf] KK20-248 — project-scoped knowledge source DB methods.
import type { Model } from 'mongoose';
import logger from '~/config/winston';
import { isValidObjectIdString } from '~/utils/objectId';
import type {
  ChatProjectSourceStatus,
  IChatProject,
  IChatProjectSource,
  IChatProjectSourceDocument,
} from '~/types';

export type CreateChatProjectSourceInput = {
  projectId: string;
  file_id: string;
  status?: ChatProjectSourceStatus;
  error?: string | null;
  tenantId?: string;
};

export type UpdateChatProjectSourceInput = {
  status?: ChatProjectSourceStatus;
  error?: string | null;
};

export interface ChatProjectSourceMethods {
  createChatProjectSource(
    user: string,
    input: CreateChatProjectSourceInput,
  ): Promise<IChatProjectSource | null>;
  listChatProjectSources(user: string, projectId: string): Promise<IChatProjectSource[]>;
  listReadyChatProjectSourceFileIds(user: string, projectId: string): Promise<string[]>;
  updateChatProjectSource(
    user: string,
    projectId: string,
    file_id: string,
    input: UpdateChatProjectSourceInput,
  ): Promise<IChatProjectSource | null>;
  deleteChatProjectSource(user: string, projectId: string, file_id: string): Promise<boolean>;
  deleteChatProjectSourcesForProject(user: string, projectId: string): Promise<number>;
  deleteChatProjectSourcesByFileId(user: string, file_id: string): Promise<number>;
}

const VALID_STATUSES = new Set<ChatProjectSourceStatus>([
  'uploading',
  'processing',
  'ready',
  'failed',
]);

function normalizeStatus(status?: ChatProjectSourceStatus): ChatProjectSourceStatus {
  return status && VALID_STATUSES.has(status) ? status : 'uploading';
}

function normalizeError(error?: string | null): string | null {
  if (typeof error !== 'string') {
    return null;
  }
  return error.trim().slice(0, 2000) || null;
}

async function assertProjectAccess(
  mongoose: typeof import('mongoose'),
  user: string,
  projectId: string,
): Promise<IChatProject | null> {
  if (!user || !isValidObjectIdString(projectId)) {
    return null;
  }
  const ChatProject = mongoose.models.ChatProject as Model<IChatProject>;
  return await ChatProject.findOne({ _id: new mongoose.Types.ObjectId(projectId), user })
    .select('_id tenantId')
    .lean<IChatProject>();
}

export function createChatProjectSourceMethods(
  mongoose: typeof import('mongoose'),
): ChatProjectSourceMethods {
  async function createChatProjectSource(
    user: string,
    input: CreateChatProjectSourceInput,
  ): Promise<IChatProjectSource | null> {
    const project = await assertProjectAccess(mongoose, user, input.projectId);
    if (!project || !input.file_id) {
      return null;
    }

    try {
      const ChatProjectSource = mongoose.models.ChatProjectSource as Model<IChatProjectSourceDocument>;
      const status = normalizeStatus(input.status);
      return await ChatProjectSource.findOneAndUpdate(
        { user, projectId: input.projectId, file_id: input.file_id },
        {
          $setOnInsert: {
            user,
            projectId: input.projectId,
            file_id: input.file_id,
            sourceType: 'file',
            tenantId: input.tenantId ?? project.tenantId,
          },
          $set: {
            status,
            error: status === 'failed' ? normalizeError(input.error) : null,
          },
        },
        { new: true, upsert: true, setDefaultsOnInsert: true },
      ).lean<IChatProjectSource>();
    } catch (error) {
      logger.error('[createChatProjectSource] Error creating project source', error);
      throw new Error('Error creating project source');
    }
  }

  async function listChatProjectSources(
    user: string,
    projectId: string,
  ): Promise<IChatProjectSource[]> {
    const project = await assertProjectAccess(mongoose, user, projectId);
    if (!project) {
      return [];
    }

    try {
      const ChatProjectSource = mongoose.models.ChatProjectSource as Model<IChatProjectSourceDocument>;
      return await ChatProjectSource.find({ user, projectId, sourceType: 'file' })
        .sort({ createdAt: -1, _id: -1 })
        .lean<IChatProjectSource[]>();
    } catch (error) {
      logger.error('[listChatProjectSources] Error listing project sources', error);
      throw new Error('Error listing project sources');
    }
  }

  async function listReadyChatProjectSourceFileIds(
    user: string,
    projectId: string,
  ): Promise<string[]> {
    const project = await assertProjectAccess(mongoose, user, projectId);
    if (!project) {
      return [];
    }

    try {
      const ChatProjectSource = mongoose.models.ChatProjectSource as Model<IChatProjectSourceDocument>;
      const sources = await ChatProjectSource.find({ user, projectId, sourceType: 'file' })
        .select('file_id')
        .lean<Array<Pick<IChatProjectSource, 'file_id'>>>();
      const associatedFileIds = sources.map((source) => source.file_id).filter(Boolean);
      if (associatedFileIds.length === 0) {
        return [];
      }

      const File = mongoose.models.File;
      const readyFiles = await File.find({
        user,
        file_id: { $in: associatedFileIds },
        embedded: true,
        ...(project.tenantId
          ? {
              // [knauf] KK20-248 — include legacy user-owned file rows that predate
              // tenantId persistence so project knowledge remains usable until backfilled.
              $or: [{ tenantId: project.tenantId }, { tenantId: { $exists: false } }, { tenantId: null }],
              // End [knauf]
            }
          : {}),
      })
        .select('file_id')
        .lean<Array<{ file_id: string }>>();
      return readyFiles.map((file) => file.file_id).filter(Boolean);
    } catch (error) {
      logger.error('[listReadyChatProjectSourceFileIds] Error listing ready project files', error);
      throw new Error('Error listing ready project files');
    }
  }

  async function updateChatProjectSource(
    user: string,
    projectId: string,
    file_id: string,
    input: UpdateChatProjectSourceInput,
  ): Promise<IChatProjectSource | null> {
    const project = await assertProjectAccess(mongoose, user, projectId);
    if (!project || !file_id) {
      return null;
    }

    try {
      const ChatProjectSource = mongoose.models.ChatProjectSource as Model<IChatProjectSourceDocument>;
      const update: Partial<Pick<IChatProjectSource, 'status' | 'error'>> = {};
      if (input.status) {
        update.status = normalizeStatus(input.status);
      }
      if (Object.prototype.hasOwnProperty.call(input, 'error')) {
        update.error = normalizeError(input.error);
      } else if (input.status && input.status !== 'failed') {
        update.error = null;
      }

      return await ChatProjectSource.findOneAndUpdate(
        { user, projectId, sourceType: 'file', file_id },
        { $set: update },
        { new: true },
      ).lean<IChatProjectSource>();
    } catch (error) {
      logger.error('[updateChatProjectSource] Error updating project source', error);
      throw new Error('Error updating project source');
    }
  }

  async function deleteChatProjectSource(
    user: string,
    projectId: string,
    file_id: string,
  ): Promise<boolean> {
    const project = await assertProjectAccess(mongoose, user, projectId);
    if (!project || !file_id) {
      return false;
    }

    try {
      const ChatProjectSource = mongoose.models.ChatProjectSource as Model<IChatProjectSourceDocument>;
      const result = await ChatProjectSource.deleteOne({ user, projectId, sourceType: 'file', file_id });
      return result.deletedCount === 1;
    } catch (error) {
      logger.error('[deleteChatProjectSource] Error deleting project source', error);
      throw new Error('Error deleting project source');
    }
  }

  async function deleteChatProjectSourcesForProject(user: string, projectId: string): Promise<number> {
    if (!user || !isValidObjectIdString(projectId)) {
      return 0;
    }

    try {
      const ChatProjectSource = mongoose.models.ChatProjectSource as Model<IChatProjectSourceDocument>;
      const result = await ChatProjectSource.deleteMany({ user, projectId, sourceType: 'file' });
      return result.deletedCount ?? 0;
    } catch (error) {
      logger.error('[deleteChatProjectSourcesForProject] Error deleting project sources', error);
      throw new Error('Error deleting project sources');
    }
  }

  async function deleteChatProjectSourcesByFileId(user: string, file_id: string): Promise<number> {
    if (!user || !file_id) {
      return 0;
    }

    try {
      const ChatProjectSource = mongoose.models.ChatProjectSource as Model<IChatProjectSourceDocument>;
      const result = await ChatProjectSource.deleteMany({ user, file_id, sourceType: 'file' });
      return result.deletedCount ?? 0;
    } catch (error) {
      logger.error('[deleteChatProjectSourcesByFileId] Error deleting project sources by file', error);
      throw new Error('Error deleting project sources by file');
    }
  }

  return {
    createChatProjectSource,
    listChatProjectSources,
    listReadyChatProjectSourceFileIds,
    updateChatProjectSource,
    deleteChatProjectSource,
    deleteChatProjectSourcesForProject,
    deleteChatProjectSourcesByFileId,
  };
}
// End [knauf]
