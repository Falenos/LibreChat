const { logger } = require('@librechat/data-schemas');
const { loadAgent: loadAgentFn } = require('@librechat/api');
const { isAgentsEndpoint, removeNullishValues, Constants } = require('librechat-data-provider');
const { getMCPServerTools } = require('~/server/services/Config');
// [knauf] Execute the immutable Agent snapshot carried only by an authenticated scheduler fire.
const { getSchedulerAgentSnapshot } = require('~/knauf/scheduler/agentSnapshot');
// End [knauf]
const db = require('~/models');

const loadAgent = (params) => loadAgentFn(params, { getAgent: db.getAgent, getMCPServerTools });

const buildOptions = (req, endpoint, parsedBody, endpointType) => {
  const { spec, iconURL, agent_id, chatProjectId, ...model_parameters } = parsedBody;
  // [knauf] Pin scheduled runs to their persisted per-run Agent configuration.
  const schedulerSnapshot = getSchedulerAgentSnapshot(req, agent_id);
  const agentPromise =
    schedulerSnapshot == null
      ? loadAgent({
          req,
          spec,
          agent_id: isAgentsEndpoint(endpoint) ? agent_id : Constants.EPHEMERAL_AGENT_ID,
          endpoint,
          model_parameters,
        }).catch((error) => {
          logger.error(
            `[/agents/:${agent_id}] Error retrieving agent during build options step`,
            error,
          );
          return undefined;
        })
      : Promise.resolve(schedulerSnapshot);
  // End [knauf]

  /** @type {import('librechat-data-provider').TConversation | undefined} */
  const addedConvo = req.body?.addedConvo;

  return removeNullishValues({
    spec,
    iconURL,
    endpoint,
    agent_id,
    endpointType,
    chatProjectId,
    model_parameters,
    agent: agentPromise,
    addedConvo,
  });
};

module.exports = { buildOptions };
