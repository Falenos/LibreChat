import { createSkillSyncCredentialModel } from './skillSyncCredential';
import { createSkillSyncStatusModel } from './skillSyncStatus';
import { createConversationTagModel } from './conversationTag';
import { createAgentCategoryModel } from './agentCategory';
import { createChatProjectModel } from './chatProject';
// [knauf] KK20-248 — register project-scoped knowledge source model.
import { createChatProjectSourceModel } from './chatProjectSource';
// End [knauf]
import { createAgentApiKeyModel } from './agentApiKey';
import { createTransactionModel } from './transaction';
import { createPromptGroupModel } from './promptGroup';
import { createSystemGrantModel } from './systemGrant';
import { createPluginAuthModel } from './pluginAuth';
import { createSharedLinkModel } from './sharedLink';
import { createAccessRoleModel } from './accessRole';
import { createMCPServerModel } from './mcpServer';
import { createAssistantModel } from './assistant';
import { createSkillFileModel } from './skillFile';
import { createConversationModel } from './convo';
import { createToolCallModel } from './toolCall';
import { createAclEntryModel } from './aclEntry';
import { createAuditLogModel } from './auditLog';
import { createSessionModel } from './session';
import { createBalanceModel } from './balance';
import { createMessageModel } from './message';
import { createActionModel } from './action';
import { createBannerModel } from './banner';
import { createPresetModel } from './preset';
import { createPromptModel } from './prompt';
import { createMemoryModel } from './memory';
import { createConfigModel } from './config';
// [knauf] Migration allowlist model — who is allowed into the new platform.
import { createMigrationAllowlistModel } from './migrationAllowlist';
// End [knauf]
// [knauf] KK20-195 WP2 — physical FileAsset aggregate model.
import { createFileAssetModel } from './fileAsset';
import {
  createAuditRetentionCheckpointModel,
  createAuditRetentionLeaseModel,
} from '~/knauf/audit/model';
// End [knauf]
import { createTokenModel } from './token';
import { createAgentModel } from './agent';
import { createSkillModel } from './skill';
import { createGroupModel } from './group';
import { createUserModel } from './user';
import { createRoleModel } from './role';
import { createFileModel } from './file';
import { createKeyModel } from './key';

/**
 * Creates all database models for all collections
 */
export function createModels(mongoose: typeof import('mongoose')): {
  User: ReturnType<typeof createUserModel>;
  Token: ReturnType<typeof createTokenModel>;
  Session: ReturnType<typeof createSessionModel>;
  Balance: ReturnType<typeof createBalanceModel>;
  Conversation: ReturnType<typeof createConversationModel>;
  ChatProject: ReturnType<typeof createChatProjectModel>;
  // [knauf] KK20-248 — expose project-scoped knowledge source model.
  ChatProjectSource: ReturnType<typeof createChatProjectSourceModel>;
  // End [knauf]
  Message: ReturnType<typeof createMessageModel>;
  Agent: ReturnType<typeof createAgentModel>;
  AgentApiKey: ReturnType<typeof createAgentApiKeyModel>;
  AgentCategory: ReturnType<typeof createAgentCategoryModel>;
  MCPServer: ReturnType<typeof createMCPServerModel>;
  Role: ReturnType<typeof createRoleModel>;
  Action: ReturnType<typeof createActionModel>;
  Assistant: ReturnType<typeof createAssistantModel>;
  File: ReturnType<typeof createFileModel>;
  Banner: ReturnType<typeof createBannerModel>;
  Key: ReturnType<typeof createKeyModel>;
  PluginAuth: ReturnType<typeof createPluginAuthModel>;
  Transaction: ReturnType<typeof createTransactionModel>;
  Preset: ReturnType<typeof createPresetModel>;
  Prompt: ReturnType<typeof createPromptModel>;
  PromptGroup: ReturnType<typeof createPromptGroupModel>;
  Skill: ReturnType<typeof createSkillModel>;
  SkillFile: ReturnType<typeof createSkillFileModel>;
  SkillSyncCredential: ReturnType<typeof createSkillSyncCredentialModel>;
  SkillSyncStatus: ReturnType<typeof createSkillSyncStatusModel>;
  ConversationTag: ReturnType<typeof createConversationTagModel>;
  SharedLink: ReturnType<typeof createSharedLinkModel>;
  ToolCall: ReturnType<typeof createToolCallModel>;
  MemoryEntry: ReturnType<typeof createMemoryModel>;
  AccessRole: ReturnType<typeof createAccessRoleModel>;
  AclEntry: ReturnType<typeof createAclEntryModel>;
  SystemGrant: ReturnType<typeof createSystemGrantModel>;
  AuditLog: ReturnType<typeof createAuditLogModel>;
  Group: ReturnType<typeof createGroupModel>;
  Config: ReturnType<typeof createConfigModel>;
  // [knauf] KK20-195 WP2 — physical FileAsset aggregate. (MigrationAllowlist is
  // deliberately absent here: its factory has no explicit return type, and
  // --isolatedDeclarations rejects inferred types on this exported annotation.)
  KnaufFileAsset: ReturnType<typeof createFileAssetModel>;
  // KK20-328 — audit-retention trust boundary.
  KnaufAuditRetentionCheckpoint: ReturnType<typeof createAuditRetentionCheckpointModel>;
  KnaufAuditRetentionLease: ReturnType<typeof createAuditRetentionLeaseModel>;
  // End [knauf]
} {
  return {
    User: createUserModel(mongoose),
    Token: createTokenModel(mongoose),
    Session: createSessionModel(mongoose),
    Balance: createBalanceModel(mongoose),
    Conversation: createConversationModel(mongoose),
    ChatProject: createChatProjectModel(mongoose),
    // [knauf] KK20-248 — instantiate project-scoped knowledge source model.
    ChatProjectSource: createChatProjectSourceModel(mongoose),
    // End [knauf]
    Message: createMessageModel(mongoose),
    Agent: createAgentModel(mongoose),
    AgentApiKey: createAgentApiKeyModel(mongoose),
    AgentCategory: createAgentCategoryModel(mongoose),
    MCPServer: createMCPServerModel(mongoose),
    Role: createRoleModel(mongoose),
    Action: createActionModel(mongoose),
    Assistant: createAssistantModel(mongoose),
    File: createFileModel(mongoose),
    Banner: createBannerModel(mongoose),
    Key: createKeyModel(mongoose),
    PluginAuth: createPluginAuthModel(mongoose),
    Transaction: createTransactionModel(mongoose),
    Preset: createPresetModel(mongoose),
    Prompt: createPromptModel(mongoose),
    PromptGroup: createPromptGroupModel(mongoose),
    Skill: createSkillModel(mongoose),
    SkillFile: createSkillFileModel(mongoose),
    SkillSyncCredential: createSkillSyncCredentialModel(mongoose),
    SkillSyncStatus: createSkillSyncStatusModel(mongoose),
    ConversationTag: createConversationTagModel(mongoose),
    SharedLink: createSharedLinkModel(mongoose),
    ToolCall: createToolCallModel(mongoose),
    MemoryEntry: createMemoryModel(mongoose),
    AccessRole: createAccessRoleModel(mongoose),
    AclEntry: createAclEntryModel(mongoose),
    SystemGrant: createSystemGrantModel(mongoose),
    AuditLog: createAuditLogModel(mongoose),
    Group: createGroupModel(mongoose),
    Config: createConfigModel(mongoose),
    // [knauf] Migration allowlist — who can access the new platform.
    MigrationAllowlist: createMigrationAllowlistModel(mongoose),
    // End [knauf]
    // [knauf] KK20-195 WP2 — physical FileAsset aggregate.
    KnaufFileAsset: createFileAssetModel(mongoose),
    // KK20-328 — audit-retention trust boundary.
    KnaufAuditRetentionCheckpoint: createAuditRetentionCheckpointModel(mongoose),
    KnaufAuditRetentionLease: createAuditRetentionLeaseModel(mongoose),
    // End [knauf]
  };
}
