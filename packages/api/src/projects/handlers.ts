import { isValidObjectIdString, logger } from '@librechat/data-schemas';

import type {
  ChatProjectMethods,
  ChatProjectSortBy,
  ChatProjectSortDirection,
  ChatProjectSourceMethods,
  CreateChatProjectInput,
  FileMethods,
  IChatProjectSource,
  IMongoFile,
  UpdateChatProjectInput,
} from '@librechat/data-schemas';
// [knauf] KK20-248 — project files expose the shared async-indexing projection.
import type { TChatProjectFileIndexing } from 'librechat-data-provider';
// End [knauf]
import type { Request, Response } from 'express';

const PROJECT_NOT_FOUND = 'Project not found';
const CONVERSATION_NOT_FOUND = 'Conversation not found';
// [knauf] KK20-255 — preserve the scheduler active-run deletion fence through the project API.
const SCHEDULE_ACTIVE_RUN_CODE = 'SCHEDULE_ACTIVE_RUN';
// End [knauf]

const PROJECT_SORT_FIELDS = new Set<ChatProjectSortBy>(['name', 'createdAt', 'lastConversationAt']);

interface ProjectUser {
  id: string;
  _id?: {
    toString(): string;
  };
}

interface ProjectRequest extends Request {
  user?: ProjectUser;
}

type FileOwner = { user: string; tenantId?: string | null };

type ProjectDeleteCleanup = {
  beforeDelete: () => Promise<void>;
  afterDelete: () => Promise<void>;
  rollback: () => Promise<void>;
};

type ProjectHandlerDependencies = Pick<
  ChatProjectMethods,
  | 'listChatProjects'
  | 'createChatProject'
  | 'getChatProject'
  | 'updateChatProject'
  | 'deleteChatProject'
  | 'assignConversationToProject'
> &
  // [knauf] KK20-248 — project knowledge file API depends on explicit project-source methods.
  Pick<
    ChatProjectSourceMethods,
    'createChatProjectSource' | 'listChatProjectSources' | 'deleteChatProjectSource'
  > &
  Pick<FileMethods, 'getFiles'> & {
    attachIndexingToFiles: (files: IMongoFile[]) => Promise<IndexedProjectFile[]>;
    prepareProjectDeleteCleanup?: (
      req: ProjectRequest,
      projectId: string,
    ) => Promise<ProjectDeleteCleanup>;
  };
// End [knauf]

const getUserId = (req: ProjectRequest): string => req.user?.id ?? req.user?._id?.toString() ?? '';

const projectFileOwnerFilter = (req: ProjectRequest): FileOwner & Record<string, unknown> => {
  const user = getUserId(req);
  const tenantId = (req.user as (ProjectUser & { tenantId?: string | null }) | undefined)?.tenantId;
  if (!tenantId) {
    return { user };
  }
  return {
    user,
    // [knauf] KK20-248 — include legacy user-owned file rows that predate
    // tenantId persistence; otherwise valid project files appear as missing.
    $or: [{ tenantId }, { tenantId: { $exists: false } }, { tenantId: null }],
    // End [knauf]
  };
};

const queryString = (value: Request['query'][string]): string | undefined => {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return queryString(value[0]);
  }
  return undefined;
};

const normalizeString = (value: string | null | undefined): string =>
  typeof value === 'string' ? value.trim() : '';

const normalizeLimit = (value: Request['query'][string]): number => {
  const limit = parseInt(queryString(value) ?? '', 10);
  if (!Number.isFinite(limit)) {
    return 25;
  }
  return Math.min(Math.max(limit, 1), 100);
};

const normalizeSortBy = (value: Request['query'][string]): ChatProjectSortBy | undefined => {
  const sortBy = queryString(value);
  return PROJECT_SORT_FIELDS.has(sortBy as ChatProjectSortBy)
    ? (sortBy as ChatProjectSortBy)
    : undefined;
};

const normalizeSortDirection = (
  value: Request['query'][string],
): ChatProjectSortDirection | undefined => {
  const sortDirection = queryString(value);
  return sortDirection === 'asc' || sortDirection === 'desc' ? sortDirection : undefined;
};

const createProjectInput = (req: ProjectRequest): CreateChatProjectInput | null => {
  const name = normalizeString(req.body?.name);
  if (!name) {
    return null;
  }

  return {
    name,
    description: typeof req.body?.description === 'string' ? req.body.description : '',
    // [knauf] KK20-248 — accept project-level instructions at creation time.
    instructions: typeof req.body?.instructions === 'string' ? req.body.instructions : '',
    // End [knauf]
  };
};

// [knauf] KK20-248 — merge project-source lifecycle state with authorized File metadata.
type IndexedProjectFile = IMongoFile & { indexing?: TChatProjectFileIndexing };
type ProjectFileResponse = IChatProjectSource &
  Partial<Pick<IMongoFile, 'filename' | 'type' | 'bytes' | 'embedded'>> & {
    indexing?: TChatProjectFileIndexing;
  };

const deriveProjectFileStatus = (
  source: IChatProjectSource,
  file?: IMongoFile,
): Pick<IChatProjectSource, 'status' | 'error'> => {
  if (!file) {
    return { status: 'failed', error: source.error ?? 'File not found' };
  }
  if (file.embedded === true) {
    return { status: 'ready', error: null };
  }
  if (source.status === 'failed') {
    return { status: 'failed', error: source.error ?? null };
  }
  return { status: 'processing', error: source.error ?? null };
};

const buildProjectFileResponse = (
  source: IChatProjectSource,
  file?: IndexedProjectFile,
): ProjectFileResponse => {
  const { status, error } = deriveProjectFileStatus(source, file);
  return {
    ...source,
    status,
    error,
    filename: file?.filename,
    type: file?.type,
    bytes: file?.bytes,
    embedded: file?.embedded,
    indexing: file?.indexing,
  };
};
// End [knauf]

export function createProjectHandlers(deps: ProjectHandlerDependencies): {
  listProjects: (req: ProjectRequest, res: Response) => Promise<Response>;
  createProject: (req: ProjectRequest, res: Response) => Promise<Response>;
  assignConversationToProject: (req: ProjectRequest, res: Response) => Promise<Response>;
  getProject: (req: ProjectRequest, res: Response) => Promise<Response>;
  updateProject: (req: ProjectRequest, res: Response) => Promise<Response>;
  deleteProject: (req: ProjectRequest, res: Response) => Promise<Response>;
  // [knauf] KK20-248 — project knowledge file API surface.
  listProjectFiles: (req: ProjectRequest, res: Response) => Promise<Response>;
  addProjectFile: (req: ProjectRequest, res: Response) => Promise<Response>;
  downloadProjectFile: (req: ProjectRequest, res: Response) => Promise<Response | void>;
  deleteProjectFile: (req: ProjectRequest, res: Response) => Promise<Response>;
  // End [knauf]
} {
  async function listProjects(req: ProjectRequest, res: Response): Promise<Response> {
    try {
      const result = await deps.listChatProjects(getUserId(req), {
        cursor: queryString(req.query.cursor),
        limit: normalizeLimit(req.query.limit),
        sortBy: normalizeSortBy(req.query.sortBy),
        sortDirection: normalizeSortDirection(req.query.sortDirection),
        search: queryString(req.query.search),
      });
      return res.status(200).json(result);
    } catch (error) {
      logger.error('[projects] Error listing projects', error);
      return res.status(500).json({ error: 'Error listing projects' });
    }
  }

  async function createProject(req: ProjectRequest, res: Response): Promise<Response> {
    const input = createProjectInput(req);
    if (!input) {
      return res.status(400).json({ error: 'name is required' });
    }

    try {
      const project = await deps.createChatProject(getUserId(req), input);
      return res.status(201).json(project);
    } catch (error) {
      logger.error('[projects] Error creating project', error);
      return res.status(500).json({ error: 'Error creating project' });
    }
  }

  async function assignConversationToProject(
    req: ProjectRequest,
    res: Response,
  ): Promise<Response> {
    const { conversationId } = req.params;
    const projectId = req.body?.projectId ?? null;

    if (projectId !== null && typeof projectId !== 'string') {
      return res.status(400).json({ error: 'projectId must be a string or null' });
    }

    try {
      const result = await deps.assignConversationToProject(
        getUserId(req),
        conversationId,
        projectId,
      );
      if (!result) {
        return res.status(404).json({ error: CONVERSATION_NOT_FOUND });
      }
      return res.status(200).json(result);
    } catch (error) {
      if (error instanceof Error && error.message === PROJECT_NOT_FOUND) {
        return res.status(404).json({ error: PROJECT_NOT_FOUND });
      }
      logger.error('[projects] Error assigning conversation to project', error);
      return res.status(500).json({ error: 'Error assigning conversation to project' });
    }
  }

  async function getProject(req: ProjectRequest, res: Response): Promise<Response> {
    const { projectId } = req.params;
    if (!isValidObjectIdString(projectId)) {
      return res.status(404).json({ error: PROJECT_NOT_FOUND });
    }

    try {
      const project = await deps.getChatProject(getUserId(req), projectId);
      if (!project) {
        return res.status(404).json({ error: PROJECT_NOT_FOUND });
      }
      return res.status(200).json(project);
    } catch (error) {
      logger.error('[projects] Error getting project', error);
      return res.status(500).json({ error: 'Error getting project' });
    }
  }

  async function updateProject(req: ProjectRequest, res: Response): Promise<Response> {
    const { projectId } = req.params;
    if (!isValidObjectIdString(projectId)) {
      return res.status(404).json({ error: PROJECT_NOT_FOUND });
    }

    const input: UpdateChatProjectInput = {};
    if (req.body?.name !== undefined) {
      const name = normalizeString(req.body.name);
      if (!name) {
        return res.status(400).json({ error: 'name is required' });
      }
      input.name = name;
    }
    if (req.body?.description !== undefined) {
      input.description = typeof req.body.description === 'string' ? req.body.description : '';
    }
    // [knauf] KK20-248 — allow saving project-level instructions separately.
    if (req.body?.instructions !== undefined) {
      input.instructions = typeof req.body.instructions === 'string' ? req.body.instructions : '';
    }
    // End [knauf]

    try {
      const project = await deps.updateChatProject(getUserId(req), projectId, input);
      if (!project) {
        return res.status(404).json({ error: PROJECT_NOT_FOUND });
      }
      return res.status(200).json(project);
    } catch (error) {
      logger.error('[projects] Error updating project', error);
      return res.status(500).json({ error: 'Error updating project' });
    }
  }

  async function deleteProject(req: ProjectRequest, res: Response): Promise<Response> {
    const { projectId } = req.params;
    if (!isValidObjectIdString(projectId)) {
      return res.status(404).json({ error: PROJECT_NOT_FOUND });
    }

    try {
      const cleanup = deps.prepareProjectDeleteCleanup
        ? await deps.prepareProjectDeleteCleanup(req, projectId)
        : undefined;
      const userId = getUserId(req);
      await cleanup?.beforeDelete();
      let result;
      try {
        result = await deps.deleteChatProject(userId, projectId);
      } catch (error) {
        await cleanup?.rollback();
        throw error;
      }
      if (!result.deletedCount) {
        await cleanup?.rollback();
        return res.status(404).json({ error: PROJECT_NOT_FOUND });
      }
      await cleanup?.afterDelete();
      return res.status(200).json(result);
    } catch (error) {
      // [knauf] KK20-255 — a project with queued or actively leased scheduled work is retryable.
      if (
        error != null &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === SCHEDULE_ACTIVE_RUN_CODE
      ) {
        return res.status(409).json({ error: 'Project has an active scheduled run' });
      }
      // End [knauf]
      logger.error('[projects] Error deleting project', error);
      return res.status(500).json({ error: 'Error deleting project' });
    }
  }

  // [knauf] KK20-248 — explicit project file endpoints for project knowledge.
  async function listProjectFiles(req: ProjectRequest, res: Response): Promise<Response> {
    const { projectId } = req.params;
    if (!isValidObjectIdString(projectId)) {
      return res.status(404).json({ error: PROJECT_NOT_FOUND });
    }

    try {
      const sources = await deps.listChatProjectSources(getUserId(req), projectId);
      const fileIds = sources.map((source) => source.file_id).filter(Boolean);
      const fileRows = fileIds.length
        ? ((await deps.getFiles(
            {
              file_id: { $in: fileIds },
              ...projectFileOwnerFilter(req),
            },
            {},
            { filename: 1, type: 1, bytes: 1, embedded: 1, knauf_asset_id: 1, file_id: 1 },
          )) ?? [])
        : [];
      const indexedFileRows = await deps.attachIndexingToFiles(fileRows);
      const filesById = new Map(indexedFileRows.map((file) => [file.file_id, file]));
      return res.status(200).json({
        files: sources.map((source) =>
          buildProjectFileResponse(source, filesById.get(source.file_id)),
        ),
      });
    } catch (error) {
      logger.error('[projects] Error listing project files', error);
      return res.status(500).json({ error: 'Error listing project files' });
    }
  }

  async function addProjectFile(req: ProjectRequest, res: Response): Promise<Response> {
    const { projectId } = req.params;
    const fileId = normalizeString(req.body?.file_id ?? req.body?.fileId);
    if (!isValidObjectIdString(projectId)) {
      return res.status(404).json({ error: PROJECT_NOT_FOUND });
    }
    if (!fileId) {
      return res.status(400).json({ error: 'file_id is required' });
    }

    try {
      const [authorizedFile] =
        (await deps.getFiles(
          {
            file_id: { $in: [fileId] },
            ...projectFileOwnerFilter(req),
          },
          {},
          { filename: 1, type: 1, bytes: 1, embedded: 1, knauf_asset_id: 1, file_id: 1 },
        )) ?? [];
      if (!authorizedFile) {
        return res.status(404).json({ error: 'File not found' });
      }

      // End [knauf]

      // [knauf] KK20-297 — Code Interpreter-only uploads cannot become Project Knowledge.
      if (authorizedFile.embedded !== true && !authorizedFile.knauf_asset_id) {
        return res.status(400).json({ error: 'File is not indexable as project knowledge' });
      }
      // End [knauf]

      // [knauf] KK20-248 — explicit project file endpoints for project knowledge.
      const source = await deps.createChatProjectSource(getUserId(req), {
        projectId,
        file_id: fileId,
        status: req.body?.status,
      });
      if (!source) {
        return res.status(404).json({ error: PROJECT_NOT_FOUND });
      }
      const [indexedFile = authorizedFile] = await deps.attachIndexingToFiles([authorizedFile]);
      return res.status(201).json(buildProjectFileResponse(source, indexedFile));
    } catch (error) {
      logger.error('[projects] Error adding project file', error);
      return res.status(500).json({ error: 'Error adding project file' });
    }
  }

  async function downloadProjectFile(req: ProjectRequest, res: Response): Promise<Response | void> {
    const { projectId, fileId } = req.params;
    if (!isValidObjectIdString(projectId)) {
      return res.status(404).json({ error: PROJECT_NOT_FOUND });
    }
    if (!fileId) {
      return res.status(400).json({ error: 'fileId is required' });
    }

    try {
      const sources = await deps.listChatProjectSources(getUserId(req), projectId);
      if (!sources.some((source) => source.file_id === fileId)) {
        return res.status(404).json({ error: 'Project file not found' });
      }
      return res.redirect(
        307,
        `/api/files/download/${encodeURIComponent(getUserId(req))}/${encodeURIComponent(fileId)}`,
      );
    } catch (error) {
      logger.error('[projects] Error downloading project file', error);
      return res.status(500).json({ error: 'Error downloading project file' });
    }
  }

  async function deleteProjectFile(req: ProjectRequest, res: Response): Promise<Response> {
    const { projectId, fileId } = req.params;
    if (!isValidObjectIdString(projectId)) {
      return res.status(404).json({ error: PROJECT_NOT_FOUND });
    }
    if (!fileId) {
      return res.status(400).json({ error: 'fileId is required' });
    }

    try {
      const deleted = await deps.deleteChatProjectSource(getUserId(req), projectId, fileId);
      if (!deleted) {
        return res.status(404).json({ error: 'Project file not found' });
      }
      return res.status(200).json({ deleted: true });
    } catch (error) {
      logger.error('[projects] Error deleting project file', error);
      return res.status(500).json({ error: 'Error deleting project file' });
    }
  }

  // End [knauf]

  return {
    listProjects,
    createProject,
    assignConversationToProject,
    getProject,
    updateProject,
    deleteProject,
    // [knauf] KK20-248 — expose project knowledge file handlers.
    listProjectFiles,
    addProjectFile,
    downloadProjectFile,
    deleteProjectFile,
    // End [knauf]
  };
}
