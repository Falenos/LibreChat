const express = require('express');
const {
  createFileLimiters,
  configMiddleware,
  requireJwtAuth,
  uaParser,
  checkBan,
} = require('~/server/middleware');
const { restoreTenantContextFromReq } = require('@librechat/api');
const { avatar: asstAvatarRouter } = require('~/server/routes/assistants/v1');
const { avatar: agentAvatarRouter } = require('~/server/routes/agents/v1');
// [knauf] knaufUploadRejectionHandler forwards allow-list fileFilter rejections
// (which fire during streaming, before the files.js route catch) as localizable
// 415 JSON instead of a generic 500. KK20-190.
const { createMulterInstance, knaufUploadRejectionHandler } = require('./multer');

const files = require('./files');
const images = require('./images');
const avatar = require('./avatar');
const speech = require('./speech');

const initialize = async () => {
  const router = express.Router();
  router.use(requireJwtAuth);
  router.use(configMiddleware);
  router.use(checkBan);
  router.use(uaParser);

  const upload = await createMulterInstance();
  router.post('/speech/stt', upload.single('audio'), restoreTenantContextFromReq);

  /* Important: speech route must be added before the upload limiters */
  router.use('/speech', speech);

  const { fileUploadIpLimiter, fileUploadUserLimiter } = createFileLimiters();

  /** Apply rate limiters to all POST routes (excluding /speech which is handled above) */
  router.use((req, res, next) => {
    if (req.method === 'POST' && !req.path.startsWith('/speech')) {
      return fileUploadIpLimiter(req, res, (err) => {
        if (err) {
          return next(err);
        }
        return fileUploadUserLimiter(req, res, next);
      });
    }
    next();
  });

  // [knauf] Trailing error handler catches the allow-list fileFilter rejection for
  // the chat upload route and returns a localizable 415; on success the request
  // falls through to `router.use('/', files)` as before. KK20-190.
  router.post('/', upload.single('file'), restoreTenantContextFromReq, knaufUploadRejectionHandler);
  // End [knauf]
  router.post('/images', upload.single('file'), restoreTenantContextFromReq);
  router.post('/images/avatar', upload.single('file'), restoreTenantContextFromReq);
  router.post(
    '/images/agents/:agent_id/avatar',
    upload.single('file'),
    restoreTenantContextFromReq,
  );
  router.post(
    '/images/assistants/:assistant_id/avatar',
    upload.single('file'),
    restoreTenantContextFromReq,
  );

  router.use('/', files);
  router.use('/images', images);
  router.use('/images/avatar', avatar);
  router.use('/images/agents', agentAvatarRouter);
  router.use('/images/assistants', asstAvatarRouter);
  return router;
};

module.exports = { initialize };
