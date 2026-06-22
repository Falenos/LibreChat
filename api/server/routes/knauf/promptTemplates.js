/** GET /api/knauf/prompt-templates — returns templates from librechat.yaml. */
const express = require('express');
const { z } = require('zod');
const { logger, getTenantId } = require('@librechat/data-schemas');
const { getAppConfig } = require('~/server/services/Config');
const { requireJwtAuth } = require('~/server/middleware');

const templateSchema = z.object({
  id: z.string().max(50),
  label: z.string().max(100),
  description: z.string().max(300),
  content: z.string().max(4000),
});

const router = express.Router();
router.use(requireJwtAuth);

router.get('/', async (req, res) => {
  try {
    const appConfig = await getAppConfig({
      role: req.user?.role,
      userId: req.user?.id,
      tenantId: req.user?.tenantId || getTenantId(),
    });

    // Templates live under interface.knauf.promptTemplates in librechat.yaml.
    const raw = appConfig?.config?.interface?.knauf?.promptTemplates ?? [];
    const templates = [];
    for (const entry of raw) {
      const result = templateSchema.safeParse(entry);
      if (result.success) {
        templates.push(result.data);
      } else {
        logger.warn('[knauf prompt-templates] Skipping malformed template entry', {
          entry,
          errors: result.error.issues,
        });
      }
    }
    return res.json({ templates });
  } catch (err) {
    logger.error('[knauf prompt-templates] Error', err);
    return res
      .status(err?.status ?? 500)
      .json({ message: err?.message ?? 'Failed to load prompt templates.' });
  }
});

module.exports = router;
