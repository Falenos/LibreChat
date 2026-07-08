jest.mock('winston', () => {
  // [knauf] return a factory so `winston.format(fn)()` is safe;
  // matches the shape @librechat/data-schemas/dist/config/winston expects.
  // Real `winston.format(fn)` returns a Format constructor whose instances
  // expose a `.transform(info, opts)` method that winston's pipeline calls.
  // The previous mock `(fn) => fn` collapsed this — `parsers.redactFormat()`
  // (called at @librechat/data-schemas dist module-load) ended up invoking
  // the inner transform fn with no `info` argument, throwing on `info.level`.
  // Returning a thunk that yields `{ transform: fn }` matches real winston's
  // shape just enough that module-load completes cleanly; the inner fn is
  // only ever invoked by winston's pipeline (never at load time).
  // NOTE: upstream v0.8.6 converged on this exact mock — candidate for seam retirement.
  const mockFormatFunction = jest.fn((fn) => () => ({ transform: fn }));
  // End [knauf]

  mockFormatFunction.colorize = jest.fn();
  mockFormatFunction.combine = jest.fn();
  mockFormatFunction.label = jest.fn();
  mockFormatFunction.timestamp = jest.fn();
  mockFormatFunction.printf = jest.fn();
  mockFormatFunction.errors = jest.fn();
  mockFormatFunction.splat = jest.fn();
  mockFormatFunction.json = jest.fn();
  return {
    format: mockFormatFunction,
    createLogger: jest.fn().mockReturnValue({
      info: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
      error: jest.fn(),
    }),
    transports: {
      Console: jest.fn(),
      DailyRotateFile: jest.fn(),
      File: jest.fn(),
    },
    addColors: jest.fn(),
  };
});

jest.mock('winston-daily-rotate-file', () => {
  return jest.fn().mockImplementation(() => {
    return {
      level: 'error',
      filename: '../logs/error-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      zippedArchive: true,
      maxSize: '20m',
      maxFiles: '14d',
      format: 'format',
    };
  });
});

jest.mock('~/config', () => {
  return {
    logger: {
      info: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
      error: jest.fn(),
    },
  };
});

jest.mock('~/config/parsers', () => {
  return {
    redactMessage: jest.fn(),
    redactFormat: jest.fn(),
    debugTraverse: jest.fn(),
    formatConsoleMeta: jest.fn(() => ''),
  };
});
