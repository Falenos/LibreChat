/**
 * [knauf] Tier 5 fork of upstream
 * client/src/components/SidePanel/Agents/MCPTools.tsx.
 *
 * Two intentional changes vs upstream:
 *   1. Inner "<label>" heading reading com_ui_mcp_servers — dropped;
 *      the enclosing KnaufSection already provides the section title
 *      (with the Knauf-friendly tooltip).
 *   2. Inner "Add MCP Server Tools" button — dropped; KnaufAgentConfig
 *      renders a single "Add MCP server" button outside this component
 *      that opens the same MCPToolSelectDialog.
 *
 * Wrapper className: the outer "mb-1" is not a margin reduction. Upstream
 * wraps everything in "mb-4" and uses an inner "mb-1" div for the server
 * list; we drop the outer wrapper (KnaufSection already supplies "mb-6"
 * spacing) and keep the upstream inner "mb-1" as the new top-level div.
 *
 * Without this fork the user sees the section title twice and two
 * buttons that open the same dialog. Everything else (server row
 * variants, MCP_SERVERS access gate) is preserved verbatim. When
 * upstream MCPTools.tsx changes, this file is the merge surface.
 */
import React from 'react';
import { PermissionTypes, Permissions } from 'librechat-data-provider';
import UninitializedMCPTool from '~/components/SidePanel/Agents/UninitializedMCPTool';
import UnconfiguredMCPTool from '~/components/SidePanel/Agents/UnconfiguredMCPTool';
import MCPTool from '~/components/SidePanel/Agents/MCPTool';
import { useHasAccess } from '~/hooks';
import { useAgentPanelContext } from '~/Providers';

export default function KnaufMCPTools({
  agentId,
  mcpServerNames,
}: {
  agentId: string;
  mcpServerNames?: string[];
}) {
  const { mcpServersMap } = useAgentPanelContext();
  const hasMcpAccess = useHasAccess({
    permissionType: PermissionTypes.MCP_SERVERS,
    permission: Permissions.USE,
  });
  if (!hasMcpAccess) {
    return null;
  }
  return (
    <div className="mb-1">
      {mcpServerNames?.map((mcpServerName) => {
        const serverInfo = mcpServersMap.get(mcpServerName);
        if (!serverInfo?.isConfigured) {
          return (
            <UnconfiguredMCPTool key={`${mcpServerName}-${agentId}`} serverName={mcpServerName} />
          );
        }
        if (!serverInfo) {
          return null;
        }

        if (serverInfo?.tools?.length && serverInfo.tools.length > 0) {
          return <MCPTool key={`${serverInfo.serverName}-${agentId}`} serverInfo={serverInfo} />;
        }

        return (
          <UninitializedMCPTool
            key={`${serverInfo.serverName}-${agentId}`}
            serverInfo={serverInfo}
          />
        );
      })}
    </div>
  );
}
