const express = require('express');
const request = require('supertest');

const mockGetActiveCategories = jest.fn();
const mockCreateCategory = jest.fn();
const mockFindCategoryByValue = jest.fn();
const mockGetAgent = jest.fn();
const mockDeleteCategory = jest.fn();
let mockUserRole = 'ADMIN';

jest.mock('~/models', () => ({
  getActiveCategories: (...args) => mockGetActiveCategories(...args),
  createCategory: (...args) => mockCreateCategory(...args),
  findCategoryByValue: (...args) => mockFindCategoryByValue(...args),
  getAgent: (...args) => mockGetAgent(...args),
  deleteCategory: (...args) => mockDeleteCategory(...args),
}));

jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (req, _res, next) => {
    req.user = { role: mockUserRole };
    next();
  },
  checkAdmin: jest.requireActual('~/server/middleware/roles/admin'),
}));

jest.mock('@librechat/data-schemas', () => ({
  logger: { error: jest.fn() },
}));

const agentCategoriesRouter = require('./agentCategories');
const { createAgentCategory } = agentCategoriesRouter;

const makeResponse = () => ({
  status: jest.fn().mockReturnThis(),
  json: jest.fn().mockReturnThis(),
});

describe('Knauf custom agent categories', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUserRole = 'ADMIN';
  });

  it('rejects non-admin creation requests', async () => {
    mockUserRole = 'USER';
    const app = express();
    app.use(express.json(), agentCategoriesRouter);

    await request(app).post('/').send({ label: 'Field Operations' }).expect(403);

    expect(mockGetActiveCategories).not.toHaveBeenCalled();
    expect(mockCreateCategory).not.toHaveBeenCalled();
  });

  it('rejects non-admin deletion requests', async () => {
    mockUserRole = 'USER';
    const app = express();
    app.use(express.json(), agentCategoriesRouter);

    await request(app).delete('/custom_field_ops').expect(403);

    expect(mockFindCategoryByValue).not.toHaveBeenCalled();
    expect(mockDeleteCategory).not.toHaveBeenCalled();
  });

  it('creates a reusable custom category with a preserved display label', async () => {
    mockGetActiveCategories.mockResolvedValue([{ value: 'general', label: 'General' }]);
    mockCreateCategory.mockImplementation(async (category) => category);
    const res = makeResponse();

    await createAgentCategory({ body: { label: '  Field   Operations  ' } }, res);

    expect(mockCreateCategory).toHaveBeenCalledWith(
      expect.objectContaining({
        value: expect.stringMatching(/^custom_[a-z0-9_-]{12}$/),
        label: 'Field Operations',
        custom: true,
        isActive: true,
      }),
    );
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ label: 'Field Operations', custom: true, count: 0 }),
    );
  });

  it('reuses an existing category name case-insensitively', async () => {
    mockGetActiveCategories.mockResolvedValue([
      { value: 'custom_existing', label: 'Field Operations', custom: true },
    ]);
    const res = makeResponse();

    await createAgentCategory({ body: { label: 'field operations' } }, res);

    expect(mockCreateCategory).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ value: 'custom_existing', label: 'Field Operations' }),
    );
  });

  it('rejects empty and oversized names', async () => {
    for (const label of ['   ', 'x'.repeat(81)]) {
      const res = makeResponse();
      await createAgentCategory({ body: { label } }, res);
      expect(res.status).toHaveBeenCalledWith(400);
    }
    expect(mockGetActiveCategories).not.toHaveBeenCalled();
    expect(mockCreateCategory).not.toHaveBeenCalled();
  });

  it('deletes an unused custom category', async () => {
    mockFindCategoryByValue.mockResolvedValue({
      value: 'custom_field_ops',
      label: 'Field Operations',
      custom: true,
    });
    mockGetAgent.mockResolvedValue(null);
    mockDeleteCategory.mockResolvedValue(true);
    const app = express();
    app.use(express.json(), agentCategoriesRouter);

    await request(app).delete('/custom_field_ops').expect(204);

    expect(mockGetAgent).toHaveBeenCalledWith({ category: 'custom_field_ops' });
    expect(mockDeleteCategory).toHaveBeenCalledWith('custom_field_ops');
  });

  it('protects built-in categories', async () => {
    mockFindCategoryByValue.mockResolvedValue({
      value: 'general',
      label: 'General',
      custom: false,
    });
    const app = express();
    app.use(express.json(), agentCategoriesRouter);

    await request(app).delete('/general').expect(400);

    expect(mockGetAgent).not.toHaveBeenCalled();
    expect(mockDeleteCategory).not.toHaveBeenCalled();
  });

  it('refuses to delete a category assigned to an agent', async () => {
    mockFindCategoryByValue.mockResolvedValue({
      value: 'custom_field_ops',
      label: 'Field Operations',
      custom: true,
    });
    mockGetAgent.mockResolvedValue({ id: 'agent-1', category: 'custom_field_ops' });
    const app = express();
    app.use(express.json(), agentCategoriesRouter);

    await request(app).delete('/custom_field_ops').expect(409);

    expect(mockDeleteCategory).not.toHaveBeenCalled();
  });
});
