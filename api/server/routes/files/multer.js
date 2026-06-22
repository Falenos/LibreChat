const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
// [knauf] resolveUploadErrorMessage forwards Knauf rejection i18n keys verbatim. KK20-190.
const { sanitizeFilename, resolveUploadErrorMessage } = require('@librechat/api');
const {
  mergeFileConfig,
  getEndpointFileConfig,
  fileConfig: defaultFileConfig,
  // [knauf] Actionable allow-list rejection (legacy-Office Save-As help) on the
  // Knauf upload endpoints, mirroring filterFile's messaging. KK20-190.
  EModelEndpoint,
  knaufLegacyOfficeErrorKey,
} = require('librechat-data-provider');
const { getAppConfig } = require('~/server/services/Config');

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const appConfig = req.config;
    const outputPath = path.join(appConfig.paths.uploads, 'temp', req.user.id);
    if (!fs.existsSync(outputPath)) {
      fs.mkdirSync(outputPath, { recursive: true });
    }
    cb(null, outputPath);
  },
  filename: function (req, file, cb) {
    req.file_id = crypto.randomUUID();
    file.originalname = decodeURIComponent(file.originalname);
    const sanitizedFilename = sanitizeFilename(file.originalname);
    cb(null, sanitizedFilename);
  },
});

const importFileFilter = (req, file, cb) => {
  if (file.mimetype === 'application/json') {
    cb(null, true);
  } else if (path.extname(file.originalname).toLowerCase() === '.json') {
    cb(null, true);
  } else {
    cb(new Error('Only JSON files are allowed'), false);
  }
};

/**
 *
 * @param {import('librechat-data-provider').FileConfig | undefined} customFileConfig
 */
const createFileFilter = (customFileConfig) => {
  /**
   * @param {ServerRequest} req
   * @param {Express.Multer.File}
   * @param {import('multer').FileFilterCallback} cb
   */
  const fileFilter = (req, file, cb) => {
    if (!file) {
      return cb(new Error('No file provided'), false);
    }

    if (req.originalUrl.endsWith('/speech/stt') && file.mimetype.startsWith('audio/')) {
      return cb(null, true);
    }

    const endpoint = req.body.endpoint;
    const endpointType = req.body.endpointType;
    const endpointFileConfig = getEndpointFileConfig({
      fileConfig: customFileConfig,
      endpoint,
      endpointType,
    });

    if (!defaultFileConfig.checkType(file.mimetype, endpointFileConfig.supportedMimeTypes)) {
      // [knauf] On the Knauf allow-list endpoints, reject with an actionable i18n
      // key — legacy Office binaries (.doc/.xls/.ppt) get Save-As-to-OOXML help;
      // anything else gets a friendly supported-formats message — instead of the
      // bare generic error. fileFilter runs during multipart streaming, before the
      // files.js route body, so this error bypasses that resolveUploadErrorMessage
      // catch; it's tagged `knaufUploadRejection` so the paired error handler
      // (knaufUploadRejectionHandler, wired in ./index) forwards it as JSON
      // {message:<key>} for the client to localize. Other endpoints keep the
      // upstream generic message. KK20-190.
      const isKnaufCappedEndpoint =
        endpoint === EModelEndpoint.azureOpenAI || endpoint === EModelEndpoint.agents;
      if (isKnaufCappedEndpoint) {
        const rejection = new Error(
          knaufLegacyOfficeErrorKey(file.mimetype, file.originalname) ??
            'com_knauf_error_unsupported_type',
        );
        rejection.knaufUploadRejection = true;
        return cb(rejection, false);
      }
      // End [knauf]
      return cb(new Error('Unsupported file type: ' + file.mimetype), false);
    }

    cb(null, true);
  };

  return fileFilter;
};

const createMulterInstance = async () => {
  const appConfig = await getAppConfig();
  const fileConfig = mergeFileConfig(appConfig?.fileConfig);
  const fileFilter = createFileFilter(fileConfig);
  return multer({
    storage,
    fileFilter,
    limits: { fileSize: fileConfig.serverFileSizeLimit },
  });
};

// [knauf] Route-scoped error handler for the chat upload POST. The fileFilter
// above rejects unsupported types DURING multipart streaming (before the files.js
// route body), so those errors never reach files.js's resolveUploadErrorMessage
// catch and would otherwise surface to the client as a generic 500. Only errors
// tagged `knaufUploadRejection` are handled here (returned as a localizable
// 415 JSON `{ message: <i18n key> }`); MulterError (size/limits) and anything
// else fall through to the global ErrorController unchanged. Wired as the trailing
// handler on `router.post('/')` in ./index. KK20-190.
const knaufUploadRejectionHandler = (err, req, res, next) => {
  if (err?.knaufUploadRejection === true) {
    return res.status(415).json({ message: resolveUploadErrorMessage(err) });
  }
  return next(err);
};
// End [knauf]

module.exports = {
  createMulterInstance,
  storage,
  importFileFilter,
  // [knauf] exported for ./index wiring + multer.spec.js seam test. KK20-190.
  knaufUploadRejectionHandler,
};
