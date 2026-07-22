const express = require('express');
const { nanoid } = require('nanoid');
const { z } = require('zod');
const { logger } = require('@librechat/data-schemas');
const { requireJwtAuth, checkAdmin } = require('~/server/middleware');
const db = require('~/models');

const router = express.Router();
const createCategorySchema = z.object({
  label: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .transform((label) => label.replace(/\s+/g, ' ')),
});
const deleteCategorySchema = z.string().trim().min(1).max(100);
const formatCategory = (category) => ({
  value: category.value,
  label: category.label,
  description: category.description,
  custom: category.custom,
  count: 0,
});

async function createAgentCategory(req, res) {
  try {
    const { label } = createCategorySchema.parse(req.body);
    const categories = await db.getActiveCategories();
    const existing = categories.find(
      (category) => category.label.localeCompare(label, 'en', { sensitivity: 'accent' }) === 0,
    );

    if (existing) {
      return res.status(200).json(formatCategory(existing));
    }

    const category = await db.createCategory({
      value: `custom_${nanoid(12).toLowerCase()}`,
      label,
      description: '',
      order: categories.length,
      isActive: true,
      custom: true,
    });
    return res.status(201).json(formatCategory(category));
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid category', details: error.errors });
    }
    logger.error('[knauf agent categories] Failed to create category', error);
    return res.status(500).json({ error: 'Failed to create category' });
  }
}

async function deleteAgentCategory(req, res) {
  try {
    const value = deleteCategorySchema.parse(req.params.value);
    const category = await db.findCategoryByValue(value);

    if (!category) {
      return res.status(404).json({ error: 'Category not found' });
    }
    if (category.custom !== true) {
      return res.status(400).json({ error: 'Built-in categories cannot be deleted' });
    }
    if (await db.getAgent({ category: value })) {
      return res.status(409).json({ error: 'Category is assigned to an agent' });
    }
    if (!(await db.deleteCategory(value))) {
      return res.status(404).json({ error: 'Category not found' });
    }

    return res.status(204).send();
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid category', details: error.errors });
    }
    logger.error('[knauf agent categories] Failed to delete category', error);
    return res.status(500).json({ error: 'Failed to delete category' });
  }
}

router.post('/', requireJwtAuth, checkAdmin, createAgentCategory);
router.delete('/:value', requireJwtAuth, checkAdmin, deleteAgentCategory);

module.exports = router;
module.exports.createAgentCategory = createAgentCategory;
module.exports.deleteAgentCategory = deleteAgentCategory;
