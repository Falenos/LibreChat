/** GET /api/knauf/costs/conversations/:conversationId — estimated chat costs from transactions. */
const express = require('express');
const mongoose = require('mongoose');
const { logger } = require('@librechat/data-schemas');
const { requireJwtAuth } = require('~/server/middleware');
const { getConversationCosts } = require('~/server/services/knauf/costs');

const router = express.Router();
router.use(requireJwtAuth);

function isValidConversationId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 160;
}

router.get('/conversations/:conversationId', async (req, res) => {
  const { conversationId } = req.params;
  if (!isValidConversationId(conversationId)) {
    return res.status(400).json({ message: 'Invalid conversationId.' });
  }

  try {
    const summary = await getConversationCosts({
      userId: req.user.id,
      conversationId,
      Transaction: mongoose.models.Transaction,
    });
    return res.json(summary);
  } catch (error) {
    logger.error('[knauf costs] Failed to load conversation costs', error);
    return res.status(500).json({ message: 'Failed to load conversation costs.' });
  }
});

module.exports = router;
module.exports.isValidConversationId = isValidConversationId;
